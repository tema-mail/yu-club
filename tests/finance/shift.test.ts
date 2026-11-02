// S2-16b: кассовая смена (K17 §7): флаг false – смены нет; true – вторая открытая – CASH_SHIFT_ALREADY_OPEN (и в гонке);
// закрытие с расхождением – needs_resolution без проводки; решение – Директор/Владелец: correct – correction на diff со
// ссылкой на смену, accept – без проводки; Администратор не решает.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { closeShift, openShift, resolveShift } from '../../apps/api/src/modules/finance/shift.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:00:00Z';
const staff: Record<string, string> = {};

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return { actor: { kind: 'staff', staffId: staff[role]!, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() };
}
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });
async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}
const open = (who: AccessContext, branchId: string, countedKop: number) => tx((t) => openShift(t, who, { branchId, countedKop }, meta(who), clock));
const close = (who: AccessContext, shiftId: string, countedKop: number) => tx((t) => closeShift(t, who, { shiftId, countedKop }, meta(who), clock));
const resolve = (who: AccessContext, shiftId: string, action: string, reason = 'пересчитали') => tx((t) => resolveShift(t, who, { shiftId, action, reason }, meta(who), { clock }));
const income = (who: AccessContext, branchId: string, amountKop: number) =>
  tx((t) => recordIncome(t, who, { branchId, method: 'cash', amountKop, source: 'other', occurredAt: AT }, meta(who), { idempotencyKey: randomUUID(), clock }));
async function branchWithShifts(): Promise<string> {
  const b = (await createTestBranch(db.client)).id;
  await db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.cash_shift_enabled', 'branch', $1, 'true', '2026-01-01', $2)`, [b, staff.owner]);
  return b;
}
const cash = async (b: string) => Number((await db.client.query(`SELECT balance FROM app.ledger_accounts WHERE owner_id = $1 AND kind = 'cash_branch'`, [b])).rows[0]?.balance ?? 0);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 10 });
  for (const role of ['owner', 'director', 'admin']) {
    staff[role] = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`, [`${role}@yu.test`, role])).rows[0]!.id;
  }
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('кассовая смена', () => {
  it('флаг false – открыть смену нельзя (смены нет), операции идут', async () => {
    const b = (await createTestBranch(db.client)).id;
    await fails(open(ctx('admin', [b]), b, 0), 'VALIDATION_FAILED');
    expect((await income(ctx('owner'), b, 100)).shiftId).toBeNull();
  });

  it('открыть – Администратор; вторая открытая – CASH_SHIFT_ALREADY_OPEN; гонка 6 открытий – одна смена', async () => {
    const b = await branchWithShifts();
    const results = await Promise.all(Array.from({ length: 6 }, () => open(ctx('admin', [b]), b, 0).then(() => 'ok', (e: AppError) => e.code)));
    expect(results.filter((x) => x === 'ok')).toHaveLength(1);
    expect(new Set(results.filter((x) => x !== 'ok'))).toEqual(new Set(['CASH_SHIFT_ALREADY_OPEN']));
    const n = await db.client.query(`SELECT count(*)::int AS n FROM app.cash_shifts WHERE branch_id = $1`, [b]);
    expect(n.rows[0].n).toBe(1);
  });

  it('закрытие без расхождения – closed; с расхождением – needs_resolution, остаток не изменился', async () => {
    const b = await branchWithShifts();
    const admin = ctx('admin', [b]);
    const s1 = await open(admin, b, 0);
    expect(s1).toMatchObject({ status: 'open', openingExpectedKop: 0, openingDiffKop: 0 });
    await income(ctx('owner'), b, 5_000);
    expect((await close(admin, s1.id, 5_000)).status).toBe('closed');
    const s2 = await open(admin, b, 5_000);
    await income(ctx('owner'), b, 1_000);
    const c2 = await close(admin, s2.id, 5_700); // недостача 300
    expect(c2).toMatchObject({ status: 'needs_resolution', closingExpectedKop: 6_000, closingDiffKop: -300 });
    expect(await cash(b)).toBe(6_000); // расхождение само не проводится
    await fails(close(admin, s2.id, 6_000), 'VALIDATION_FAILED');
  });

  it('решение: Администратор – FORBIDDEN; Директор correct – correction −300 со ссылкой на смену; accept – без проводки', async () => {
    const b = await branchWithShifts();
    const admin = ctx('admin', [b]);
    const s = await open(admin, b, 0);
    await income(ctx('owner'), b, 1_000);
    await close(admin, s.id, 700);
    await fails(resolve(admin, s.id, 'correct'), 'FORBIDDEN');
    await fails(resolve(ctx('director', [b]), s.id, 'correct', ' '), 'COMMENT_REQUIRED');
    await fails(resolve(ctx('director', [randomUUID()]), s.id, 'correct'), 'NOT_FOUND');
    const r = await resolve(ctx('director', [b]), s.id, 'correct', 'недостача по пересчёту');
    expect(r.shift).toMatchObject({ status: 'resolved', resolution: 'correct', resolutionOperationId: r.operation!.id });
    expect(r.operation).toMatchObject({ kind: 'correction', place: 'cash', direction: 'out', amountKop: 300, ref: { type: 'shift', id: s.id }, shiftId: s.id });
    expect(await cash(b)).toBe(700);
    await fails(resolve(ctx('director', [b]), s.id, 'accept'), 'VALIDATION_FAILED'); // уже решено

    const s2 = await open(admin, b, 700);
    await close(admin, s2.id, 900); // излишек 200
    const a = await resolve(ctx('owner'), s2.id, 'accept', 'нашли чужую купюру, вернули');
    expect(a).toMatchObject({ operation: null, shift: { status: 'resolved', resolution: 'accept' } });
    expect(await cash(b)).toBe(700);
    const audit = await db.client.query(`SELECT action FROM journal.audit_events WHERE object_type = 'cash_shift' AND object_id = $1 ORDER BY id`, [s2.id]);
    expect(audit.rows.map((x) => x.action)).toEqual(['cash_shift.opened', 'cash_shift.closed', 'cash_shift.resolved']);
  });

  it('расхождение при открытии: смена открыта, при закрытии – needs_resolution, даже если закрытие сошлось', async () => {
    const b = await branchWithShifts();
    const admin = ctx('admin', [b]);
    await fails(income(ctx('owner'), b, 1_000), 'CASH_SHIFT_REQUIRED'); // без смены наличные не принимаются
    const s = await open(admin, b, 500); // ожидалось 0
    expect(s).toMatchObject({ status: 'open', openingDiffKop: 500 });
    expect((await close(admin, s.id, 0)).status).toBe('needs_resolution');
    await fails(resolve(ctx('director', [b]), s.id, 'correct'), 'VALIDATION_FAILED'); // при закрытии сошлось
    expect((await resolve(ctx('director', [b]), s.id, 'accept')).shift.status).toBe('resolved');
  });
  it('расхождение смены 1, решённое correct после открытия смены 2, не всплывает как openingDiff смены 2', async () => {
    const b = await branchWithShifts();
    const admin = ctx('admin', [b]);
    const s1 = await open(admin, b, 0);
    await income(ctx('owner'), b, 1_000);
    await close(admin, s1.id, 700); // недостача 300, ждёт решения
    const s2 = await open(admin, b, 700); // в ящике те же 700, остаток счёта ещё 1000
    expect(s2.openingDiffKop).toBe(-300);
    await resolve(ctx('director', [b]), s1.id, 'correct', 'недостача по пересчёту');
    expect(await cash(b)).toBe(700);
    const c2 = await close(admin, s2.id, 700);
    expect(c2).toMatchObject({ status: 'closed', openingExpectedKop: 700, openingDiffKop: 0, closingDiffKop: 0 });
  });
  it('accept по смене 1 после открытия смены 2 тоже сдвигает openingExpected смены 2; проводки нет, ссылка в аудите', async () => {
    const b = await branchWithShifts();
    const admin = ctx('admin', [b]);
    const s1 = await open(admin, b, 0);
    await income(ctx('owner'), b, 1_000);
    await close(admin, s1.id, 700);
    const s2 = await open(admin, b, 700);
    expect(s2.openingDiffKop).toBe(-300);
    const a = await resolve(ctx('director', [b]), s1.id, 'accept', 'приняли пересчёт');
    expect(a.operation).toBeNull();
    expect(await cash(b)).toBe(1_000);
    const s2now = await db.client.query(`SELECT opening_expected_kop::int AS e FROM app.cash_shifts WHERE id = $1`, [s2.id]);
    expect(s2now.rows[0].e).toBe(700);
    const audit = await db.client.query(`SELECT after FROM journal.audit_events WHERE action = 'cash_shift.resolved' AND object_id = $1`, [s1.id]);
    expect(audit.rows[0].after).toMatchObject({ resolution: 'accept', openingAdjustedShiftId: s2.id });
  });
});
