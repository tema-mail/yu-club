// S3-16: начисление через живой outbox и pg-boss (startWorkerTasks, как на стенде): отметка ухода → запись K3 в течение 2 с;
// сбой обработчика не откатывает отметку (16 §2.6), повтор очереди доводит начисление до конца.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { clearSubscriptions, listSubscriptions } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE } from '../../apps/api/src/modules/shifts/accrual.ts';
import { checkIn, checkOut } from '../../apps/api/src/modules/shifts/attendance.ts';
import { createShift, getShift } from '../../apps/api/src/modules/shifts/plan.ts';
import { setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { startWorkerTasks, type WorkerTasks } from '../../apps/api/src/worker.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const TZ = 'Asia/Novosibirsk' as TimeZone;
const DAY = '2026-11-16' as LocalDate;
const at = (time: string) => localToInstant(DAY, time as LocalTime, TZ);
const clockAt = (d: Date): Clock => ({ now: () => d });
let db: TestDatabase;
let pool: pg.Pool;
let boss: PgBoss;
let tasks: WorkerTasks | undefined;
let branchId = '';
const errors: unknown[] = [];
const owner: AccessContext = { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: new Date() };
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

async function newWorker(): Promise<{ s: string; self: AccessContext; shiftId: string }> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  const s = r.rows[0]!.id;
  await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s, branchId]);
  const c = clockAt(new Date('2026-11-14T05:00:00Z'));
  await tx((t) => setRate(t, owner, { staffId: s, validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 10_000, reason: 'старт' }, meta(owner), c));
  const shift = await tx((t) => createShift(t, owner, { staffId: s, branchId, start: at('10:00').toISOString(), end: at('12:00').toISOString() }, meta(owner), c));
  const self: AccessContext = { actor: { kind: 'staff', staffId: s, sessionId: randomUUID() }, role: 'admin', network: false, cityIds: new Set(), branchIds: new Set([branchId]), at: c.now() };
  await tx((t) => checkIn(t, self, shift.id, meta(self), clockAt(at('10:00'))));
  return { s, self, shiftId: shift.id };
}
const accrued = async (shiftId: string) => Number((await db.client.query<{ sum: string }>(`SELECT coalesce(sum(amount), 0) AS sum FROM journal.ledger_entries WHERE ref_type = 'shift' AND ref_id = $1`, [shiftId])).rows[0]!.sum);
async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  branchId = (await createTestBranch(db.client)).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '09:00', '23:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchId, randomUUID()]);
  boss = new PgBoss({ connectionString: db.url, schema: 'pgboss' });
  boss.on('error', (err) => errors.push(err));
  await boss.start();
  clearSubscriptions();
  tasks = await startWorkerTasks({ pool, boss, vapid: null, clock: clockAt(at('12:30')), outboxIntervalMs: 200, pollingIntervalSeconds: 0.5, logger: { error: (obj) => void errors.push(obj) } });
}, 60_000);
afterAll(async () => {
  await tasks?.stop();
  await boss?.stop({ graceful: false });
  clearSubscriptions();
  await pool?.end();
  await db?.drop();
});

it('worker подписан на оба события начисления', () => {
  const names = listSubscriptions().map((s) => s.name);
  expect(names).toContain(HANDLER_ATTENDANCE);
  expect(names).toContain(HANDLER_RATE);
});

it('отметка ухода → запись K3 в течение 2 с', async () => {
  const { self, shiftId } = await newWorker();
  await tx((t) => checkOut(t, self, shiftId, meta(self), clockAt(at('12:00'))));
  const started = Date.now();
  expect(await waitFor(async () => (await accrued(shiftId)) === 130_000, 2_000)).toBe(true); // 120 мин × 600 ₽/ч + 100 ₽ за выход
  expect(Date.now() - started).toBeLessThanOrEqual(2_000);
});

it('сбой обработчика не откатывает отметку; повтор очереди доводит начисление', async () => {
  const { s, self, shiftId } = await newWorker();
  // Счёт закрыт – post бросит ACCOUNT_CLOSED; сам счёт создаём заранее.
  const acc = await db.client.query<{ id: string }>(`INSERT INTO app.ledger_accounts (kind, unit, owner_type, owner_id, status) VALUES ('staff_payroll', 'RUB_KOP', 'staff', $1, 'closed') RETURNING id`, [s]);
  await tx((t) => checkOut(t, self, shiftId, meta(self), clockAt(at('12:00'))));
  // Обработчик успевает упасть: processed_events откатился вместе с его транзакцией.
  await new Promise((r) => setTimeout(r, 1_500));
  const shift = await getShift(pool, shiftId);
  expect(shift).toMatchObject({ status: 'worked', paidMinutes: 120 });
  expect(await accrued(shiftId)).toBe(0);
  await db.client.query(`UPDATE app.ledger_accounts SET status = 'active' WHERE id = $1`, [acc.rows[0]!.id]);
  expect(await waitFor(async () => (await accrued(shiftId)) === 130_000, 15_000)).toBe(true);
}, 30_000);
