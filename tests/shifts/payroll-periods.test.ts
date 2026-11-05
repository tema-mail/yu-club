// Ревизия: периоды без разрывов и дата записи «в открытом периоде» (K18 §7): запись корректировки и переноса всегда попадает в ведомость.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { type Clock, type LocalDate, type TimeZone } from '../../apps/api/src/core/time.ts';
import { nextOpenDate, openPayrollDate } from '../../apps/api/src/modules/shifts/accrual.ts';
import { closePeriod, createPeriod, postCorrection } from '../../apps/api/src/modules/shifts/payroll.ts';
import { createShift } from '../../apps/api/src/modules/shifts/plan.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const TZ = 'Asia/Novosibirsk' as TimeZone;
const clock: Clock = { now: () => new Date('2026-11-14T05:00:00Z') };
const owner: AccessContext = { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });

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
const period = (from: string, to: string) => tx((t) => createPeriod(t, owner, { from, to }, meta(), clock));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('периоды без разрывов', () => {
  it('первый период не может оставить запись корректировки перед собой; дальше – только встык', async () => {
    const { id: branchId } = await createTestBranch(db.client);
    await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '09:00', '23:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchId, randomUUID()]);
    const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
    const staffId = r.rows[0]!.id;
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [staffId, branchId]);
    const shift = await tx((t) => createShift(t, owner, { staffId, branchId, start: '2026-11-10T05:00:00Z', end: '2026-11-10T07:00:00Z' }, meta(), clock));
    await tx((t) => postCorrection(t, owner, { staffId, amountKop: 100, ref: { type: 'shift', id: shift.id }, reason: 'до первого периода' }, meta(), { idempotencyKey: randomUUID(), clock }));

    await expect(period('2026-12-01', '2026-12-31')).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_GAP', details: { date: '2026-11-14' } });
    await period('2026-11-01', '2026-11-30');
    await expect(period('2027-01-01', '2027-01-31')).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_GAP', details: { expectedFrom: '2026-12-01' } });
    await period('2026-12-01', '2026-12-31');
    await expect(period('2026-09-01', '2026-09-15')).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_GAP' });
    await period('2026-10-01', '2026-10-31'); // встык перед первым
  });

  it('дата записи: до всех периодов и в закрытом – начало следующего открытого; после всех – сама дата, её покроет следующий период', async () => {
    const at = (d: string): Clock => ({ now: () => new Date(`${d}T05:00:00Z`) });
    const date = (c: Clock) => tx((t) => openPayrollDate(t, TZ, c));
    expect(await date(at('2026-08-20'))).toBe('2026-10-01');
    expect(await date(at('2026-10-20'))).toBe('2026-10-20');
    await tx(async (t) => closePeriod(t, owner, (await t.query<{ id: string }>(`SELECT id FROM app.payroll_periods WHERE date_from = '2026-10-01'`)).rows[0]!.id, {}, meta(), clock));
    expect(await date(at('2026-10-20'))).toBe('2026-11-01');
    expect(await tx((t) => nextOpenDate(t, '2026-11-01' as LocalDate))).toBe('2026-11-01');
    expect(await date(at('2027-03-01'))).toBe('2027-03-01');
    expect(await tx((t) => nextOpenDate(t, '2027-01-01' as LocalDate))).toBe('2027-01-01');
  });
});
