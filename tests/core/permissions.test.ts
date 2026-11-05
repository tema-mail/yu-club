import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIONS,
  actionsOf,
  assertCan,
  assertCanAudited,
  assertCanManageStaff,
  assertOwnClient,
  branchScopeSql,
  can,
  loadAccess,
  roleAllows,
  scopeFilter,
  type AccessContext,
  type NetworkLookup,
  type StaffRole,
  type Target,
} from '../../apps/api/src/core/permissions.ts';
import { networkLookup } from '../../apps/api/src/server.ts';
import { SETTINGS, settingDef } from '../../apps/api/src/core/settings.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { createTestBranch } from '../helpers/network.ts';

const CITY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CITY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BR_A1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BR_A2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const BR_B1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';

function ctx(role: StaffRole, zone: { cityIds?: string[]; branchIds?: string[] } = {}): AccessContext {
  return {
    actor: { kind: 'staff', staffId: { owner: '0', director: '1', admin: '2' }[role].repeat(8) + '-0000-4000-8000-000000000001', sessionId: 's' },
    role,
    network: role === 'owner',
    cityIds: new Set(zone.cityIds ?? []),
    branchIds: new Set(zone.branchIds ?? []),
    at: new Date('2026-11-15T07:00:00Z'),
  };
}

// Директор – город A (филиалы A1, A2), Администратор – только филиал A1.
const owner = ctx('owner');
const director = ctx('director', { cityIds: [CITY_A], branchIds: [BR_A1, BR_A2] });
const admin = ctx('admin', { branchIds: [BR_A1] });

// Матрица K1 §Реестр, переписанная независимо от кода: О Д А и тип цели.
const EXPECTED: [string, string, 'network' | 'city' | 'branch' | 'client'][] = [
  ['network.view', 'ОДА', 'branch'],
  ['network.city.manage', 'О', 'network'],
  ['network.branch.create', 'О', 'city'],
  ['network.branch.archive', 'О', 'city'],
  ['network.branch.update', 'ОД', 'branch'],
  ['network.hours.manage', 'ОД', 'branch'],
  ['staff.view', 'ОД', 'branch'],
  ['staff.director.assign', 'О', 'branch'],
  ['staff.admin.assign', 'ОД', 'branch'],
  ['staff.block', 'ОД', 'branch'],
  ['resources.view', 'ОДА', 'branch'],
  ['resources.manage', 'ОД', 'branch'],
  ['schedule.view', 'ОДА', 'branch'],
  ['booking.create', 'ОДА', 'branch'],
  ['booking.cancel', 'ОДА', 'branch'],
  ['booking.reschedule', 'ОДА', 'branch'],
  ['booking.visit.mark', 'ОДА', 'branch'],
  ['booking.visit.correct', 'ОД', 'branch'],
  ['block.manage', 'ОДА', 'branch'],
  ['client.view.basic', 'ОДА', 'client'],
  ['client.view.full', 'ОД', 'client'],
  ['client.update.limited', 'ОДА', 'client'],
  ['client.update', 'ОД', 'client'],
  ['client.merge', 'О', 'network'],
  ['client.export', 'О', 'network'],
  ['export.pd', 'О', 'network'],
  ['tariff.manage', 'О', 'branch'],
  ['settings.network.manage', 'О', 'network'],
  ['settings.branch.manage', 'ОД', 'branch'],
  ['dictionary.manage', 'О', 'network'],
  ['audit.view', 'ОД', 'branch'],
  ['audit.view.own', 'ОДА', 'branch'],
  ['audit.export', 'О', 'network'],
  ['notifications.view', 'ОДА', 'branch'],
  // Э2 – K1 «Действия Э2» (K10 §8, K15 §10, K16 §9, K17 §8)
  ['finance.payment.record', 'ОДА', 'branch'],
  ['finance.payment.view', 'ОДА', 'branch'],
  ['finance.refund', 'ОД', 'branch'],
  ['finance.view', 'ОД', 'branch'],
  ['finance.view.day', 'ОДА', 'branch'],
  ['finance.expense.create', 'ОДА', 'branch'],
  ['finance.income.create', 'ОД', 'branch'],
  ['finance.opening_balance', 'О', 'branch'],
  ['finance.withdrawal', 'ОД', 'branch'],
  ['finance.place_transfer', 'ОД', 'branch'],
  ['finance.correct', 'О', 'branch'],
  ['finance.category.manage', 'О', 'network'],
  ['finance.period.close', 'О', 'branch'],
  ['finance.shift.operate', 'ОДА', 'branch'],
  ['finance.shift.resolve', 'ОД', 'branch'],
  ['loyalty.view', 'ОДА', 'client'],
  ['loyalty.adjust', 'ОД', 'client'],
  ['loyalty.adjust_below_limit', 'О', 'client'],
  ['loyalty.book_below_limit', 'ОД', 'branch'],
  ['loyalty.goods.manage', 'ОД', 'branch'],
  ['loyalty.goods.issue', 'ОДА', 'branch'],
  ['certificate.view', 'ОДА', 'branch'],
  ['certificate.sell', 'ОД', 'branch'],
  ['certificate.cancel', 'ОД', 'branch'],
  ['certificate.correct', 'О', 'branch'],
  ['certificate.review', 'ОД', 'branch'],
  ['certificate.link', 'ОДА', 'branch'],
];

const LETTER: Record<StaffRole, string> = { owner: 'О', director: 'Д', admin: 'А' };
const own: Record<string, Target> = { network: { network: true }, city: { cityId: CITY_A }, branch: { branchId: BR_A1 } };
const foreign: Record<string, Target> = { network: { network: true }, city: { cityId: CITY_B }, branch: { branchId: BR_B1 } };

describe('матрица K1 × роль × своя/чужая цель', () => {
  it('реестр кода совпадает с K1 построчно (Э0–Э2; Э3 – permissions-e3.test.ts, Э4 – permissions-e4.test.ts)', () => {
    const e3 = /^(shift|payroll|equipment|repair|event|gift|holiday)\.|^staff\.planning_status$/;
    const e4 = /^(content|reports|search)\.|^notifications\.(send|retry|templates)(\.|$)/;
    expect(ACTIONS.filter((a) => !e3.test(a) && !e4.test(a)).sort()).toEqual(EXPECTED.map((r) => r[0]).sort());
  });

  const rows = EXPECTED.flatMap(([action, roles, kind]) =>
    (['owner', 'director', 'admin'] as const).map((role) => ({ action, role, kind, allowed: roles.includes(LETTER[role]) })),
  );

  it.each(rows)('$action / $role', ({ action, role, kind, allowed }) => {
    const c = { owner, director, admin }[role];
    expect(roleAllows(role, action)).toBe(allowed);
    if (kind === 'client') return; // клиент – только assertCanClient (K1)
    expect(can(c, action, own[kind]!)).toBe(allowed && (kind !== 'network' || role === 'owner'));
    expect(can(c, action, foreign[kind]!)).toBe(allowed && role === 'owner');
  });

  it('неуказанное – запрещено всем, включая Владельца (payroll.export – Э4; ledger.override_limit не вводится)', () => {
    for (const a of ['payroll.export', 'payroll.view.own', 'ledger.override_limit', 'finance.export', 'booking.delete', '']) {
      expect(can(owner, a, { network: true })).toBe(false);
      expect(can(owner, a, { branchId: BR_A1 })).toBe(false);
      expect(roleAllows('owner', a)).toBe(false);
    }
  });

  it('actionsOf для меню CRM', () => {
    expect(actionsOf('admin')).not.toContain('staff.view');
    expect(actionsOf('owner')).toHaveLength(ACTIONS.length);
  });
});

describe('S2-01: права и настройки Э2', () => {
  it('Администратор в Э2 получает ровно 9 действий (план 6.4 S2-01)', () => {
    const e2 = actionsOf('admin').filter((a) => /^(finance|loyalty|certificate)\./.test(a)).sort();
    expect(e2).toEqual(
      [
        'certificate.link', 'certificate.view', 'finance.expense.create', 'finance.payment.record', 'finance.payment.view',
        'finance.shift.operate', 'finance.view.day', 'loyalty.goods.issue', 'loyalty.view',
      ].sort(),
    );
  });

  it('Директор не получает finance.correct, finance.opening_balance, certificate.correct, loyalty.adjust_below_limit', () => {
    for (const a of ['finance.correct', 'finance.opening_balance', 'certificate.correct', 'loyalty.adjust_below_limit']) {
      expect(roleAllows('director', a)).toBe(false);
      expect(roleAllows('owner', a)).toBe(true);
    }
    expect(() => assertCan(director, 'finance.correct', { branchId: BR_A1 })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCan(director, 'finance.refund', { branchId: BR_B1 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('умолчания ключей совпадают с K7 «Реестр ключей Э2», менять – только Владелец', () => {
    const expected: Record<string, { value: unknown; levels: string[] }> = {
      'payment.certificate_topup_enabled': { value: false, levels: ['network'] },
      'finance.negative_balance_allowed': { value: false, levels: ['network', 'branch'] },
      'finance.cash_shift_enabled': { value: false, levels: ['network', 'branch'] },
      'certificate.sale_methods': { value: ['cash', 'card', 'transfer'], levels: ['network'] },
      'certificate.nominal_min_kop': { value: null, levels: ['network'] },
      'certificate.nominal_max_kop': { value: null, levels: ['network'] },
      'loyalty.batch_ttl_days': { value: null, levels: ['network'] },
      'loyalty.penalty_scope': { value: 'visit', levels: ['network'] },
      'loyalty.penalties_from': { value: null, levels: ['network'] },
      'loyalty.points_resource_types': { value: ['pc', 'vr_seat', 'ps_room'], levels: ['network'] },
      'loyalty.accrue_for_points': { value: false, levels: ['network'] },
      'loyalty.accrue_for_certificate': { value: true, levels: ['network'] },
    };
    for (const [key, e] of Object.entries(expected)) {
      const d = settingDef(key);
      expect(d.systemDefault, key).toEqual(e.value);
      expect([...d.levels], key).toEqual(e.levels);
      expect(d.editAction, key).toBe('settings.network.manage');
      expect(d.schema.safeParse(d.systemDefault).success, key).toBe(true);
    }
    expect(Object.keys(SETTINGS).filter((k) => /^(payment|finance|certificate|loyalty)\./.test(k)).sort()).toEqual(Object.keys(expected).sort());
  });

  it('схемы ключей Э2 отсекают неверное', () => {
    const bad: [string, unknown][] = [
      ['certificate.sale_methods', []],
      ['certificate.sale_methods', ['cash', 'cash']],
      ['certificate.sale_methods', ['points']],
      ['loyalty.penalty_scope', 'day'],
      ['loyalty.batch_ttl_days', 0],
      ['loyalty.penalties_from', '2026-12-01'],
      ['certificate.nominal_min_kop', 1.5],
    ];
    for (const [key, v] of bad) expect(settingDef(key).schema.safeParse(v).success, `${key}=${JSON.stringify(v)}`).toBe(false);
    expect(settingDef('loyalty.penalties_from').schema.safeParse('2026-12-01T00:00:00Z').success).toBe(true);
  });
});

describe('assertCan: чужое – 404, своё без права – 403', () => {
  it('Директор: свой филиал – да, чужой – NOT_FOUND', () => {
    expect(() => assertCan(director, 'network.branch.update', { branchId: BR_A2 })).not.toThrow();
    expect(() => assertCan(director, 'network.branch.update', { branchId: BR_B1 })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', httpStatus: 404 }),
    );
  });

  it('Администратор: чужой филиал – NOT_FOUND даже для разрешённого действия, свой без права – FORBIDDEN', () => {
    expect(() => assertCan(admin, 'booking.create', { branchId: BR_A2 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => assertCan(admin, 'resources.manage', { branchId: BR_A1 })).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', httpStatus: 403 }),
    );
    expect(() => assertCan(admin, 'resources.manage', { branchId: BR_B1 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('тело 404 для чужого и несуществующего одинаково', () => {
    const msg = (t: Target) => {
      try {
        assertCan(admin, 'schedule.view', t);
      } catch (e) {
        return JSON.stringify({ ...(e as object), message: (e as Error).message });
      }
      return 'нет ошибки';
    };
    expect(msg({ branchId: BR_B1 })).toBe(msg({ branchId: 'ffffffff-0000-4000-8000-000000000000' }));
  });

  it('сетевая цель у не-Владельца – FORBIDDEN', () => {
    expect(() => assertCan(director, 'network.city.manage', { network: true })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCan(owner, 'network.city.manage', { network: true })).not.toThrow();
  });
});

describe('assertCanManageStaff (04 §2 п.6, §4.2)', () => {
  const t = (role: StaffRole, extra: object = {}) => ({ role, branchIds: [BR_A1], cityIds: [], ...extra });

  it('Директор не назначает и не блокирует директоров и Владельца', () => {
    for (const op of ['create', 'change_role', 'change_scope', 'block', 'end_sessions'] as const) {
      expect(() => assertCanManageStaff(director, op, t('director', { newRole: 'admin' }))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
      expect(() => assertCanManageStaff(director, op, t('owner', { newRole: 'admin' }))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    }
  });

  it('Директор назначает администратора в свою зону; в чужую – NOT_FOUND', () => {
    expect(() => assertCanManageStaff(director, 'create', t('admin'))).not.toThrow();
    expect(() => assertCanManageStaff(director, 'block', t('admin', { staffId: 'x' }))).not.toThrow();
    expect(() => assertCanManageStaff(director, 'create', t('admin', { branchIds: [BR_B1] }))).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() => assertCanManageStaff(director, 'change_scope', t('admin', { cityIds: [CITY_B], branchIds: [] }))).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('никто не меняет себе роль и зону – даже Владелец', () => {
    for (const c of [owner, director]) {
      for (const op of ['change_role', 'change_scope'] as const) {
        expect(() => assertCanManageStaff(c, op, { staffId: c.actor.staffId, role: 'admin', newRole: 'admin', branchIds: [], cityIds: [] })).toThrow(
          expect.objectContaining({ code: 'FORBIDDEN' }),
        );
      }
    }
  });

  it('Владельца не создаёт никто через CRM; Владелец назначает директора', () => {
    expect(() => assertCanManageStaff(owner, 'create', t('owner'))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCanManageStaff(owner, 'change_role', t('owner', { staffId: 'other', newRole: 'admin' }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => assertCanManageStaff(owner, 'create', t('director', { branchIds: [BR_B1] }))).not.toThrow();
  });

  it('change_role смотрит на новую роль: повысить до директора – только Владелец, до Владельца – никто', () => {
    expect(() => assertCanManageStaff(director, 'change_role', t('admin', { staffId: 'x', newRole: 'director' }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => assertCanManageStaff(director, 'change_role', t('admin', { staffId: 'x', newRole: 'owner' }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => assertCanManageStaff(owner, 'change_role', t('admin', { staffId: 'x', newRole: 'director' }))).not.toThrow();
    expect(() => assertCanManageStaff(owner, 'change_role', t('director', { staffId: 'x', newRole: 'admin' }))).not.toThrow();
    expect(() => assertCanManageStaff(owner, 'change_role', t('admin', { staffId: 'x', newRole: 'owner' }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => assertCanManageStaff(owner, 'change_role', t('admin', { staffId: 'x' }))).toThrow(/newRole/);
  });

  it('Администратор сотрудниками не управляет', () => {
    expect(() => assertCanManageStaff(admin, 'create', t('admin'))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCanManageStaff(admin, 'end_sessions', t('admin'))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});

describe('клиент и списки', () => {
  it('assertOwnClient: чужой клиент и сотрудник – NOT_FOUND', () => {
    expect(() => assertOwnClient({ kind: 'client', clientId: 'c1', sessionId: 's' }, 'c1')).not.toThrow();
    expect(() => assertOwnClient({ kind: 'client', clientId: 'c1', sessionId: 's' }, 'c2')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() => assertOwnClient(owner.actor, 'c1')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('scopeFilter: Владелец – all, зона – branches, без права или без зоны – none', () => {
    expect(scopeFilter(owner, 'schedule.view')).toEqual({ kind: 'all' });
    expect(scopeFilter(admin, 'schedule.view')).toEqual({ kind: 'branches', branchIds: [BR_A1] });
    expect(scopeFilter(admin, 'audit.view')).toEqual({ kind: 'none' });
    expect(scopeFilter(ctx('admin'), 'schedule.view')).toEqual({ kind: 'none' });
    expect(scopeFilter(admin, 'finance.correct')).toEqual({ kind: 'none' });
  });

  it('branchScopeSql: условие и параметр, кривое имя столбца – ошибка', () => {
    const p: unknown[] = ['x'];
    expect(branchScopeSql('b.branch_id', { kind: 'branches', branchIds: [BR_A1] }, p)).toBe('b.branch_id = ANY($2::uuid[])');
    expect(p).toEqual(['x', [BR_A1]]);
    expect(branchScopeSql('branch_id', { kind: 'all' }, p)).toBe('TRUE');
    expect(branchScopeSql('branch_id', { kind: 'none' }, p)).toBe('FALSE');
    expect(() => branchScopeSql('1; DROP', { kind: 'all' }, p)).toThrow();
  });
});

describe('loadAccess и назначения (БД)', () => {
  let db: TestDatabase;
  const network: NetworkLookup = {
    branchesOfCities: async (_db, ids) =>
      ids.flatMap((id) => (id === CITY_A ? [BR_A1, BR_A2] : id === CITY_B ? [BR_B1] : [])),
  };
  const at = new Date('2026-11-15T07:00:00Z');

  async function staff(role: StaffRole, status = 'active'): Promise<string> {
    const r = await db.client.query<{ id: string }>(
      `INSERT INTO app.staff (first_name, last_name, email, role, status, password_hash)
       VALUES ('А', 'Б', gen_random_uuid() || '@yu.test', $1, $2, 'x') RETURNING id`,
      [role, status],
    );
    return r.rows[0]!.id;
  }
  async function assign(staffId: string, kind: 'city' | 'branch', id: string, from = '2026-01-01', to: string | null = null) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, valid_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $1)`,
      [staffId, kind, kind === 'city' ? id : null, kind === 'branch' ? id : null, from, to],
    );
  }
  const actor = (staffId: string) => ({ kind: 'staff' as const, staffId, sessionId: 's' });

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    for (const [id, cityId] of [[BR_A1, CITY_A], [BR_A2, CITY_A], [BR_B1, CITY_B]] as const) await createTestBranch(db.client, { id, cityId });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('назначение branch не открывает соседний филиал того же города', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', BR_A1);
    const c = await loadAccess(db.client, actor(id), at, network);
    expect([...c.branchIds]).toEqual([BR_A1]);
    expect(c.cityIds.size).toBe(0);
    expect(can(c, 'schedule.view', { branchId: BR_A2 })).toBe(false);
    expect(can(c, 'network.view', { cityId: CITY_A })).toBe(false);
  });

  it('назначение city открывает все филиалы города (и только его)', async () => {
    const id = await staff('director');
    await assign(id, 'city', CITY_A);
    const c = await loadAccess(db.client, actor(id), at, network);
    expect([...c.branchIds].sort()).toEqual([BR_A1, BR_A2]);
    expect(can(c, 'schedule.view', { branchId: BR_B1 })).toBe(false);
  });

  it('отзыв и истёкший срок назначения → следующий loadAccess не видит филиал', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', BR_A1);
    await assign(id, 'branch', BR_A2, '2026-01-01', '2026-11-14');
    expect([...(await loadAccess(db.client, actor(id), at, network)).branchIds]).toEqual([BR_A1]);
    await db.client.query('UPDATE app.staff_assignments SET revoked_at = now(), revoked_by = $1 WHERE staff_id = $1', [id]);
    expect((await loadAccess(db.client, actor(id), at, network)).branchIds.size).toBe(0);
  });

  it('пересечение действующих назначений на одну цель запрещено, после отзыва – можно', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', BR_B1, '2026-01-01', '2026-12-31');
    await expect(assign(id, 'branch', BR_B1, '2026-06-01')).rejects.toMatchObject({ code: '23P01' });
    await db.client.query('UPDATE app.staff_assignments SET revoked_at = now(), revoked_by = $1 WHERE staff_id = $1', [id]);
    await assign(id, 'branch', BR_B1, '2026-06-01');
  });

  it('Владелец – вся сеть без назначений; заблокированный – SESSION_REVOKED', async () => {
    const o = await staff('owner');
    expect((await loadAccess(db.client, actor(o), at)).network).toBe(true);
    const b = await staff('admin', 'blocked');
    await expect(loadAccess(db.client, actor(b), at)).rejects.toMatchObject({ code: 'SESSION_REVOKED', httpStatus: 401 });
    await expect(loadAccess(db.client, actor('00000000-0000-4000-8000-000000000000'), at)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });

  it('assertCanAudited пишет отказ в аудит и бросает ту же ошибку', async () => {
    const meta = { actor: admin.actor, access: admin, source: 'crm' as const, requestId: 'r-deny' };
    await expect(
      assertCanAudited(db.client, meta, admin, 'network.branch.update', { branchId: BR_B1 }, {
        action: 'branch.updated',
        object: { type: 'branch', id: BR_B1 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const r = await db.client.query("SELECT action, result, reason, branch_id FROM journal.audit_events WHERE request_id = 'r-deny'");
    expect(r.rows).toEqual([
      { action: 'branch.updated', result: 'denied', reason: 'NOT_FOUND: network.branch.update', branch_id: BR_B1 },
    ]);
  });
});

describe('loadAccess с модулем network (БД): раскрытие города и дата назначения по зоне цели', () => {
  let db: TestDatabase;
  const ids: Record<string, string> = {};
  const actor = (staffId: string) => ({ kind: 'staff' as const, staffId, sessionId: 's' });

  async function row(sql: string, values: unknown[]): Promise<string> {
    const r = await db.client.query<{ id: string }>(sql, values);
    return r.rows[0]!.id;
  }
  const city = (slug: string, tz: string) =>
    row(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ($1, $1, $1, $2) RETURNING id`, [slug, tz]);
  const branch = (cityId: string, slug: string, tz: string) =>
    row(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone) VALUES ($1, $2, $2, $2, 'a', $3) RETURNING id`, [cityId, slug, tz]);
  const staff = (role: StaffRole) =>
    row(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('А', 'Б', gen_random_uuid() || '@yu.test', $1, 'x') RETURNING id`, [role]);
  const assign = (staffId: string, kind: 'city' | 'branch', id: string, from: string, to: string | null = null) =>
    db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, valid_to, created_by) VALUES ($1, $2, $3, $4, $5, $6, $1)`,
      [staffId, kind, kind === 'city' ? id : null, kind === 'branch' ? id : null, from, to],
    );

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    ids.nsk = await city('nsk', 'Asia/Novosibirsk');
    ids.msk = await city('msk', 'Europe/Moscow');
    ids.nsk1 = await branch(ids.nsk, 'nsk-1', 'Asia/Novosibirsk');
    ids.nsk2 = await branch(ids.nsk, 'nsk-2', 'Asia/Novosibirsk');
    ids.msk1 = await branch(ids.msk, 'msk-1', 'Europe/Moscow');
  });
  afterAll(async () => {
    await db.drop();
  });

  it('назначение на город открывает все его филиалы из базы, чужой город – нет', async () => {
    const id = await staff('director');
    await assign(id, 'city', ids.nsk!, '2026-01-01');
    const c = await loadAccess(db.client, actor(id), new Date('2026-11-15T07:00:00Z'), networkLookup);
    expect([...c.branchIds].sort()).toEqual([ids.nsk1, ids.nsk2].sort());
    expect(can(c, 'schedule.view', { branchId: ids.msk1! })).toBe(false);
    expect((await loadAccess(db.client, actor(id), new Date('2026-11-15T07:00:00Z'))).branchIds.size).toBe(0);
  });

  it('начало назначения – по дате филиала: 14.11 18:00Z = 15.11 01:00 в Новосибирске', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', ids.nsk1!, '2026-11-15');
    const at = new Date('2026-11-14T18:00:00Z');
    expect([...(await loadAccess(db.client, actor(id), at, networkLookup)).branchIds]).toEqual([ids.nsk1]);
    expect((await loadAccess(db.client, actor(id), at)).branchIds.size).toBe(0); // без зон – дата UTC, ещё 14.11
  });

  it('конец назначения – по дате филиала: 14.11 22:30Z = 15.11 01:30 в Москве, назначение до 14.11 уже кончилось', async () => {
    const id = await staff('admin');
    await assign(id, 'branch', ids.msk1!, '2026-01-01', '2026-11-14');
    await assign(id, 'branch', ids.nsk2!, '2026-01-01', '2026-11-15');
    const c = await loadAccess(db.client, actor(id), new Date('2026-11-14T22:30:00Z'), networkLookup);
    expect([...c.branchIds]).toEqual([ids.nsk2]);
  });

  it('город по зоне города: назначение с 15.11 открывается в 01:00 по Новосибирску', async () => {
    const id = await staff('director');
    await assign(id, 'city', ids.nsk!, '2026-11-15');
    expect((await loadAccess(db.client, actor(id), new Date('2026-11-14T16:59:00Z'), networkLookup)).cityIds.size).toBe(0);
    expect([...(await loadAccess(db.client, actor(id), new Date('2026-11-14T17:00:00Z'), networkLookup)).cityIds]).toEqual([ids.nsk]);
  });
});
