// S3-88: права с датами (K1 «Делегирование», 04 §9), TC-15, TC-16 на уровне ядра. can = роль ∪ право в зоне права,
// scopeFilter(ctx, action) = зона роли ∪ зона права на это действие, зона права ⊆ назначений получателя.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIONS,
  DELEGABLE,
  actionsOf,
  actionsOfContext,
  assertCan,
  assertCanManageStaff,
  assertGrantable,
  can,
  hasAction,
  loadAccess,
  roleAllows,
  scopeFilter,
  type AccessContext,
  type NetworkLookup,
  type StaffRole,
} from '../../apps/api/src/core/permissions.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const CITY_1 = '11111111-0000-4000-8000-00000000000c';
const CITY_2 = '22222222-0000-4000-8000-00000000000c';
const BR_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BR_B = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const BR_C = 'cccccccc-0000-4000-8000-0000000000c1'; // другой город

function ctx(role: StaffRole, branchIds: string[], grants: [string, string[]][] = []): AccessContext {
  return {
    actor: { kind: 'staff', staffId: '11111111-0000-4000-8000-000000000001', sessionId: 's' },
    role,
    network: role === 'owner',
    cityIds: new Set(),
    branchIds: new Set(branchIds),
    at: new Date('2026-11-15T07:00:00Z'),
    grants: new Map(grants.map(([a, b]) => [a, { cityIds: new Set<string>(), branchIds: new Set(b) }])),
  };
}

describe('чистые проверки: право только на своё действие и свою зону', () => {
  const admin = ctx('admin', [BR_A, BR_B], [['payroll.view', [BR_A]]]);

  it('can: право в филиале А открывает А и не открывает Б', () => {
    expect(can(admin, 'payroll.view', { branchId: BR_A })).toBe(true);
    expect(can(admin, 'payroll.view', { branchId: BR_B })).toBe(false);
    expect(can(admin, 'shift.manage', { branchId: BR_A })).toBe(false);
  });

  it('assertCan: в зоне права – пропуск; в зоне роли без права – 403; вне всех зон – 404; сеть – 403', () => {
    expect(() => assertCan(admin, 'payroll.view', { branchId: BR_A })).not.toThrow();
    expect(() => assertCan(admin, 'payroll.view', { branchId: BR_B })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCan(admin, 'payroll.view', { branchId: BR_C })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => assertCan(admin, 'payroll.view', { network: true })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('scopeFilter: по делегированному действию – филиал права, по другому – нет', () => {
    expect(scopeFilter(admin, 'payroll.view')).toEqual({ kind: 'branches', branchIds: [BR_A] });
    expect(scopeFilter(admin, 'shift.manage')).toEqual({ kind: 'none' });
    expect(scopeFilter(admin, 'shift.view')).toEqual({ kind: 'branches', branchIds: [BR_A, BR_B] });
  });

  it('scopeFilter: зона роли ∪ зона права', () => {
    const director = ctx('director', [BR_A], [['payroll.view', [BR_B]]]);
    expect(scopeFilter(director, 'payroll.view')).toEqual({ kind: 'branches', branchIds: [BR_A, BR_B] });
    expect(scopeFilter(ctx('owner', []), 'payroll.view')).toEqual({ kind: 'all' });
  });

  it('hasAction и меню: роль ∪ право, без лишнего', () => {
    expect(hasAction(admin, 'payroll.view')).toBe(true);
    expect(hasAction(admin, 'shift.manage')).toBe(false);
    expect(actionsOfContext(admin).sort()).toEqual([...actionsOf('admin'), 'payroll.view'].sort());
  });

  it('без прав – тот же результат, что у роли и зоны, по всей матрице (табличный тест S3-01)', () => {
    const noField: AccessContext = { ...ctx('admin', [BR_A]) };
    delete noField.grants;
    const empty = ctx('admin', [BR_A]);
    const expected = (c: AccessContext, a: string, b: string) => roleAllows(c.role, a) && c.branchIds.has(b);
    for (const a of ACTIONS) {
      for (const c of [noField, empty]) {
        expect(can(c, a, { branchId: BR_A })).toBe(expected(c, a, BR_A));
        expect(can(c, a, { branchId: BR_B })).toBe(false);
        expect(scopeFilter(c, a)).toEqual(roleAllows('admin', a) ? { kind: 'branches', branchIds: [BR_A] } : { kind: 'none' });
      }
    }
  });

  it('список DELEGABLE совпадает с CHECK миграции 0310', () => {
    const sql = readFileSync(new URL('../../db/migrations/0310_staff_grants.sql', import.meta.url), 'utf8');
    const check = /action IN \(([^)]+)\)/.exec(sql)![1]!;
    expect(check.match(/'[^']+'/g)!.map((x) => x.slice(1, -1)).sort()).toEqual([...DELEGABLE].sort());
    for (const a of DELEGABLE) expect(ACTIONS).toContain(a);
  });

  it('TC-15: Администратор двух филиалов – другой город автоматически не открывается', () => {
    const two = ctx('admin', [BR_A, BR_B]);
    expect(can(two, 'schedule.view', { branchId: BR_A })).toBe(true);
    expect(can(two, 'schedule.view', { branchId: BR_B })).toBe(true);
    expect(can(two, 'schedule.view', { branchId: BR_C })).toBe(false);
    expect(() => assertCan(two, 'schedule.view', { branchId: BR_C })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(can(two, 'schedule.view', { cityId: CITY_2 })).toBe(false);
  });

  it('TC-16: Директор зоны видит свою область, не назначает директоров и не расширяет доступ', () => {
    const director = ctx('director', [BR_A]);
    expect(scopeFilter(director, 'staff.view')).toEqual({ kind: 'branches', branchIds: [BR_A] });
    expect(can(director, 'staff.view', { branchId: BR_B })).toBe(false);
    expect(() => assertCanManageStaff(director, 'create', { role: 'director', branchIds: [BR_A], cityIds: [] })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCanManageStaff(director, 'change_scope', { staffId: director.actor.staffId, role: 'director', branchIds: [BR_B], cityIds: [] })).toThrow();
    expect(() => assertCanManageStaff(director, 'create', { role: 'admin', branchIds: [BR_B], cityIds: [] })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('БД: выдача и действие права', () => {
  let db: TestDatabase;
  let ownerId: string;
  const at = new Date('2026-11-15T07:00:00Z');
  const network: NetworkLookup = {
    branchesOfCities: async (_db, ids) => ids.flatMap((id) => (id === CITY_1 ? [BR_A, BR_B] : id === CITY_2 ? [BR_C] : [])),
  };
  const actor = (staffId: string) => ({ kind: 'staff' as const, staffId, sessionId: 's' });

  async function staff(role: StaffRole): Promise<string> {
    const r = await db.client.query<{ id: string }>(
      `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('А', 'Б', gen_random_uuid() || '@yu.test', $1, 'x') RETURNING id`,
      [role],
    );
    return r.rows[0]!.id;
  }
  const assign = (staffId: string, kind: 'city' | 'branch', id: string, to: string | null = null) =>
    db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, valid_to, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', $5, $1)`,
      [staffId, kind, kind === 'city' ? id : null, kind === 'branch' ? id : null, to],
    );
  async function grant(staffId: string, action: string, scope: { cityId?: string; branchId?: string }, from = '2026-11-01', to: string | null = null): Promise<string> {
    const r = await db.client.query<{ id: string }>(
      `INSERT INTO app.staff_grants (staff_id, action, scope_type, city_id, branch_id, valid_from, valid_to, granted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [staffId, action, scope.cityId ? 'city' : 'branch', scope.cityId ?? null, scope.branchId ?? null, from, to, ownerId],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    await createTestCity(db.client, { id: CITY_1 });
    await createTestBranch(db.client, { id: BR_A, cityId: CITY_1 });
    await createTestBranch(db.client, { id: BR_B, cityId: CITY_1 });
    await createTestBranch(db.client, { id: BR_C, cityId: CITY_2 });
    ownerId = await staff('owner');
  });
  afterAll(async () => {
    await db.drop();
  });

  it('право вне DELEGABLE – GRANT_ACTION_NOT_DELEGABLE при выдаче; в базе – CHECK', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', BR_A);
    await expect(assertGrantable(db.client, { staffId: id, action: 'finance.correct', scope: { branchId: BR_A }, validFrom: '2026-11-01' }, network)).rejects.toMatchObject({
      code: 'GRANT_ACTION_NOT_DELEGABLE',
      httpStatus: 422,
    });
    await expect(grant(id, 'finance.correct', { branchId: BR_A })).rejects.toMatchObject({ code: '23514' });
  });

  it('зона вне назначений на дату – GRANT_SCOPE_INVALID; внутри – проходит', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', BR_A, '2026-12-31');
    const check = (scope: { cityId: string } | { branchId: string }, validFrom = '2026-11-01', action = 'payroll.view') =>
      assertGrantable(db.client, { staffId: id, action, scope, validFrom }, network);
    await expect(check({ branchId: BR_A })).resolves.toBeUndefined();
    await expect(check({ branchId: BR_B })).rejects.toMatchObject({ code: 'GRANT_SCOPE_INVALID', httpStatus: 422 });
    await expect(check({ cityId: CITY_1 })).rejects.toMatchObject({ code: 'GRANT_SCOPE_INVALID' });
    await expect(check({ branchId: BR_A }, '2027-01-01')).rejects.toMatchObject({ code: 'GRANT_SCOPE_INVALID' });
  });

  it('филиал города из назначения на город – внутри зоны; network.branch.create – только на город', async () => {
    const id = await staff('director');
    await assign(id, 'city', CITY_1);
    const check = (action: string, scope: { cityId: string } | { branchId: string }) =>
      assertGrantable(db.client, { staffId: id, action, scope, validFrom: '2026-11-01' }, network);
    await expect(check('payroll.view', { branchId: BR_B })).resolves.toBeUndefined();
    await expect(check('payroll.view', { branchId: BR_C })).rejects.toMatchObject({ code: 'GRANT_SCOPE_INVALID' });
    await expect(check('network.branch.create', { cityId: CITY_1 })).resolves.toBeUndefined();
    await expect(check('network.branch.create', { branchId: BR_A })).rejects.toMatchObject({ code: 'GRANT_SCOPE_INVALID' });
  });

  it('loadAccess: действующее право в контексте; право в А не открывает Б', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', BR_A);
    await assign(id, 'branch', BR_B);
    await grant(id, 'payroll.view', { branchId: BR_A });
    const c = await loadAccess(db.client, actor(id), at, network);
    expect(can(c, 'payroll.view', { branchId: BR_A })).toBe(true);
    expect(can(c, 'payroll.view', { branchId: BR_B })).toBe(false);
    expect(scopeFilter(c, 'payroll.view')).toEqual({ kind: 'branches', branchIds: [BR_A] });
  });

  it('истёкшее, будущее и отозванное – не действует со следующего запроса', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', BR_A);
    await grant(id, 'payroll.view', { branchId: BR_A }, '2026-01-01', '2026-11-14');
    await grant(id, 'shift.manage', { branchId: BR_A }, '2026-11-16');
    const live = await grant(id, 'network.hours.manage', { branchId: BR_A });
    let c = await loadAccess(db.client, actor(id), at, network);
    expect(can(c, 'payroll.view', { branchId: BR_A })).toBe(false);
    expect(can(c, 'shift.manage', { branchId: BR_A })).toBe(false);
    expect(can(c, 'network.hours.manage', { branchId: BR_A })).toBe(true);
    await db.client.query(`UPDATE app.staff_grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1`, [live, ownerId]);
    c = await loadAccess(db.client, actor(id), at, network);
    expect(can(c, 'network.hours.manage', { branchId: BR_A })).toBe(false);
    expect(hasAction(c, 'network.hours.manage')).toBe(false);
  });

  it('право на город раскрывается в филиалы и не выходит за город', async () => {
    const id = await staff('director');
    await assign(id, 'city', CITY_1);
    await grant(id, 'network.branch.create', { cityId: CITY_1 });
    const c = await loadAccess(db.client, actor(id), at, network);
    expect(can(c, 'network.branch.create', { cityId: CITY_1 })).toBe(true);
    expect(can(c, 'network.branch.create', { cityId: CITY_2 })).toBe(false);
    expect(can(c, 'network.branch.create', { network: true })).toBe(false);
  });

  it('снятое назначение закрывает и право: зона права остаётся внутри назначений', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', BR_A);
    await assign(id, 'branch', BR_B, '2026-11-10');
    await grant(id, 'payroll.view', { branchId: BR_B });
    const c = await loadAccess(db.client, actor(id), at, network);
    expect(can(c, 'payroll.view', { branchId: BR_B })).toBe(false);
    expect(scopeFilter(c, 'payroll.view')).toEqual({ kind: 'none' });
  });

  it('база: второе пересекающееся право, выдача себе, зона без цели и запись от yu_app', async () => {
    const id = await staff('admin');
    await grant(id, 'block.manage', { branchId: BR_A }, '2026-11-01', '2026-11-30');
    await expect(grant(id, 'block.manage', { branchId: BR_A }, '2026-11-15')).rejects.toMatchObject({ code: '23P01' });
    await expect(grant(id, 'block.manage', { branchId: BR_B }, '2026-11-15')).resolves.toBeTruthy();
    await expect(
      db.client.query(`INSERT INTO app.staff_grants (staff_id, action, scope_type, branch_id, valid_from, granted_by) VALUES ($1, 'block.manage', 'branch', $2, '2027-01-01', $1)`, [id, BR_A]),
    ).rejects.toMatchObject({ code: '23514' });
    await db.client.query('SET ROLE yu_app');
    try {
      await expect(db.client.query(`DELETE FROM app.staff_grants`)).rejects.toMatchObject({ code: '42501' });
      await expect(db.client.query(`TRUNCATE app.staff_grants`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.client.query('RESET ROLE');
    }
  });
});
