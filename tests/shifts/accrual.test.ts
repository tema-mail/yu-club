// S3-15: начисление K18 §6: 2 ч → 120 мин × ставка + ставка за выход; 1 ч 59 мин → без неё; no_show – только сторно; двойная доставка
// и обратный порядок версий → одно живое начисление; новая ставка задним числом – только открытый период; событие по смене закрытого –
// корректировка в открытом; payroll.bonus до 0306 → 23514, после – проходит; Σ accrual = формула на случайных данных.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { verifyBalance } from '../../apps/api/src/core/ledger.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers, settleShift } from '../../apps/api/src/modules/shifts/accrual.ts';
import { setAttendance } from '../../apps/api/src/modules/shifts/attendance.ts';
import { createShift } from '../../apps/api/src/modules/shifts/plan.ts';
import { accrualParts, setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
let branchId = '';
const TZ = 'Asia/Novosibirsk' as TimeZone;
const clock: Clock = { now: () => new Date('2026-11-14T05:00:00Z') };
const at = (time: string, date: LocalDate) => localToInstant(date, time as LocalTime, TZ).toISOString();
const later = { now: () => new Date('2027-12-01T05:00:00Z') };
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
async function newStaff(rate?: { hourly: number; fee: number; from?: string }): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  const s = r.rows[0]!.id;
  await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s, branchId]);
  if (rate) await tx((t) => setRate(t, owner, { staffId: s, validFrom: rate.from ?? '2026-01-01', hourlyKop: rate.hourly, attendanceFeeKop: rate.fee, reason: 'старт' }, meta(), clock));
  return s;
}
const plan = (staffId: string, date: LocalDate) => tx((t) => createShift(t, owner, { staffId, branchId, start: at('10:00', date), end: at('20:00', date) }, meta(), clock));
const worked = (shiftId: string, rowVersion: number, paidMinutes: number) => tx((t) => setAttendance(t, owner, shiftId, { rowVersion, status: 'worked', paidMinutes, reason: 'факт' }, meta(), later));
const noShow = (shiftId: string, rowVersion: number) => tx((t) => setAttendance(t, owner, shiftId, { rowVersion, status: 'no_show', reason: 'нет' }, meta(), later));

/** Обработать события смены в порядке fact_version или обратном. */
async function deliver(shiftId: string, order: 'asc' | 'desc' = 'asc'): Promise<void> {
  const r = await db.client.query<{ id: string }>(`SELECT id FROM app.outbox_events WHERE event_type = 'shift.attendance_changed' AND aggregate_id = $1 ORDER BY (payload->>'factVersion')::int ${order}`, [shiftId]);
  for (const e of r.rows) await processEvent(pool, HANDLER_ATTENDANCE, e.id, later.now());
}
const deliverRate = async (rateId: string) => {
  const r = await db.client.query<{ id: string }>(`SELECT id FROM app.outbox_events WHERE event_type = 'staff.rate_set' AND aggregate_id = $1`, [rateId]);
  await processEvent(pool, HANDLER_RATE, r.rows[0]!.id, later.now());
};
const entries = async (shiftId: string) =>
  (await db.client.query<{ amount: string; entry_type: string; branch_id: string; refs: Record<string, string> }>(`SELECT amount, entry_type, branch_id, refs FROM journal.ledger_entries WHERE ref_type = 'shift' AND ref_id = $1 ORDER BY id`, [shiftId])).rows;
const sumOf = (rows: Array<{ amount: string }>) => rows.reduce((s, r) => s + Number(r.amount), 0);
const liveAccruals = async (shiftId: string) =>
  Number((await db.client.query(`SELECT count(*) AS n FROM journal.ledger_entries le WHERE le.ref_type = 'shift' AND le.ref_id = $1 AND le.entry_type = 'payroll.accrual' AND NOT EXISTS (SELECT 1 FROM journal.ledger_entries r WHERE r.reversal_of = le.id)`, [shiftId])).rows[0].n);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  branchId = (await createTestBranch(db.client)).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '09:00', '23:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchId, randomUUID()]);
  clearSubscriptions();
  registerPayrollHandlers({ clock: later });
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('0306', () => {
  it('вверх/вниз/вверх; запись payroll.bonus до 0306 → 23514, после – проходит', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const later306 = await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0306'`);
      const down = await migrateDown(clean.client, later306.rows[0]!.n);
      expect(down.at(-1)).toBe('0306');
      expect((await clean.client.query(`SELECT to_regclass('journal.payroll_accruals') AS t`)).rows).toEqual([{ t: null }]);
      const owner_ = await clean.client.query<{ id: string }>(`INSERT INTO app.ledger_accounts (kind, unit, owner_type, owner_id) VALUES ('staff_payroll', 'RUB_KOP', 'staff', gen_random_uuid()) RETURNING id`);
      const insert = (amount: number) =>
        clean.client.query(`INSERT INTO journal.ledger_entries (posting_id, account_id, amount, balance_after, entry_type, idempotency_key, occurred_at, author_type) VALUES (gen_random_uuid(), $1, $2, 0, 'payroll.bonus', $3, now(), 'system')`, [owner_.rows[0]!.id, amount, randomUUID()]);
      await expect(insert(100)).rejects.toMatchObject({ code: '23514', constraint: 'ledger_entry_type_known' });
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
      await expect(insert(100)).resolves.toBeDefined();
    } finally {
      await clean.drop();
    }
  });

  it('DELETE ведомостей и штрафов запрещён, журнал начислений – только вставка', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query(`DELETE FROM app.payroll_statements`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`DELETE FROM app.payroll_penalties`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`UPDATE journal.payroll_accruals SET fee_part_kop = 0`)).rejects.toMatchObject({ code: '42501' });
      expect((await c.query(`SELECT * FROM journal.append_only_violations()`)).rows).toEqual([]);
    } finally {
      c.release();
    }
  });
});

describe('начисление', () => {
  it('2 ч → 120 мин × ставка + ставка за выход; ссылки и филиал записи; баланс сходится', async () => {
    const s = await newStaff({ hourly: 30_000, fee: 10_000 });
    const shift = await plan(s, '2026-06-02' as LocalDate);
    await worked(shift.id, shift.rowVersion, 120);
    await deliver(shift.id);
    const rows = await entries(shift.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: '70000', entry_type: 'payroll.accrual', branch_id: branchId, refs: { factVersion: '1', hourlyPartKop: '60000', feePartKop: '10000' } });
    const acc = await db.client.query<{ id: string; branch_id: string | null; min_balance: string | null }>(`SELECT id, branch_id, min_balance FROM app.ledger_accounts WHERE kind = 'staff_payroll' AND owner_id = $1`, [s]);
    expect(acc.rows[0]).toMatchObject({ branch_id: null, min_balance: null });
    expect(await verifyBalance(db.client, acc.rows[0]!.id)).toMatchObject({ cached: 70_000, ok: true });
    const row = await db.client.query(`SELECT fact_version, hourly_part_kop, fee_part_kop FROM journal.payroll_accruals WHERE shift_id = $1`, [shift.id]);
    expect(row.rows).toEqual([{ fact_version: 1, hourly_part_kop: '60000', fee_part_kop: '10000' }]);
  });

  it('1 ч 59 мин → без ставки за выход; ставка 0 – строка начисления есть, записи K3 нет', async () => {
    const s = await newStaff({ hourly: 30_000, fee: 10_000 });
    const shift = await plan(s, '2026-06-03' as LocalDate);
    await worked(shift.id, shift.rowVersion, 119);
    await deliver(shift.id);
    expect(sumOf(await entries(shift.id))).toBe(59_500);
    const zero = await newStaff({ hourly: 0, fee: 0 });
    const free = await plan(zero, '2026-06-03' as LocalDate);
    await worked(free.id, free.rowVersion, 60);
    await deliver(free.id);
    expect(await entries(free.id)).toEqual([]);
    expect((await db.client.query(`SELECT ledger_entry_id FROM journal.payroll_accruals WHERE shift_id = $1`, [free.id])).rows).toEqual([{ ledger_entry_id: null }]);
  });

  it('no_show после worked – только сторно, ничего живого; повторная доставка не меняет сумму', async () => {
    const s = await newStaff({ hourly: 60_000, fee: 0 });
    const shift = await plan(s, '2026-06-04' as LocalDate);
    const w = await worked(shift.id, shift.rowVersion, 60);
    await deliver(shift.id);
    await noShow(shift.id, w.rowVersion);
    await deliver(shift.id);
    await deliver(shift.id);
    const rows = await entries(shift.id);
    expect(rows.map((r) => r.entry_type)).toEqual(['payroll.accrual', 'reversal']);
    expect(sumOf(rows)).toBe(0);
    expect(await liveAccruals(shift.id)).toBe(0);
  });

  it('двойная доставка и обратный порядок версий → одно живое начисление по последнему факту', async () => {
    const s = await newStaff({ hourly: 60_000, fee: 0 });
    const shift = await plan(s, '2026-06-05' as LocalDate);
    const v1 = await worked(shift.id, shift.rowVersion, 60);
    await worked(shift.id, v1.rowVersion, 90);
    await deliver(shift.id, 'desc');
    await deliver(shift.id, 'asc');
    await tx((t) => settleShift(t, shift.id, 'attendance', later)); // доставка мимо processed_events
    expect(await liveAccruals(shift.id)).toBe(1);
    expect(sumOf(await entries(shift.id))).toBe(90_000);
    expect(await entries(shift.id)).toHaveLength(1); // по v1 начисление и не проводилось
  });

  it('ставка не задана – начисления нет, это не ноль; потом ставка задним числом начисляет по событию', async () => {
    const s = await newStaff();
    const shift = await plan(s, '2026-06-06' as LocalDate);
    await worked(shift.id, shift.rowVersion, 60);
    await deliver(shift.id);
    expect(await entries(shift.id)).toEqual([]);
    expect((await db.client.query(`SELECT 1 FROM journal.payroll_accruals WHERE shift_id = $1`, [shift.id])).rows).toEqual([]);
    const { rate, affectedShiftIds } = await tx((t) => setRate(t, owner, { staffId: s, validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 0, reason: 'забыли' }, meta(), later));
    expect(affectedShiftIds).toEqual([shift.id]);
    await deliverRate(rate.id);
    expect(sumOf(await entries(shift.id))).toBe(60_000);
  });

  it('«не оплачивается» снимает живое начисление', async () => {
    const s = await newStaff({ hourly: 60_000, fee: 0 });
    const shift = await plan(s, '2026-06-07' as LocalDate);
    const w = await worked(shift.id, shift.rowVersion, 60);
    await deliver(shift.id);
    await tx((t) => setAttendance(t, owner, shift.id, { rowVersion: w.rowVersion, unpaidConfirmed: true, reason: 'стажировка' }, meta(), later));
    await deliver(shift.id);
    expect(sumOf(await entries(shift.id))).toBe(0);
    expect(await liveAccruals(shift.id)).toBe(0);
  });
});

describe('ставка задним числом и закрытый период', () => {
  it('новая ставка пересчитывает только открытый период; закрытая смена не тронута; версия выросла, строка начисления новая', async () => {
    const s = await newStaff({ hourly: 60_000, fee: 0 });
    const closedDay = '2026-03-10' as LocalDate;
    const openDay = '2026-04-10' as LocalDate;
    const inClosed = await plan(s, closedDay);
    const inOpen = await plan(s, openDay);
    await worked(inClosed.id, inClosed.rowVersion, 60);
    await worked(inOpen.id, inOpen.rowVersion, 60);
    await deliver(inClosed.id);
    await deliver(inOpen.id);
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2026-03-01', '2026-03-31', 'closed', now())`);
    const { rate, affectedShiftIds } = await tx((t) => setRate(t, owner, { staffId: s, validFrom: '2026-01-01', hourlyKop: 90_000, attendanceFeeKop: 0, reason: 'повышение', corrects: null }, meta(), later));
    expect(affectedShiftIds).toEqual([inOpen.id]);
    await deliverRate(rate.id);
    expect(sumOf(await entries(inClosed.id))).toBe(60_000);
    expect(sumOf(await entries(inOpen.id))).toBe(90_000);
    expect(await liveAccruals(inOpen.id)).toBe(1);
    const a = await db.client.query<{ fact_version: number }>(`SELECT fact_version FROM journal.payroll_accruals WHERE shift_id = $1 ORDER BY id`, [inOpen.id]);
    expect(a.rows.map((r) => r.fact_version)).toEqual([1, 2]);
    expect((await db.client.query<{ fact_version: number }>(`SELECT fact_version FROM app.staff_shifts WHERE id = $1`, [inOpen.id])).rows[0]!.fact_version).toBe(2);
    await deliverRate(rate.id); // дубль события
    await tx((t) => settleShift(t, inOpen.id, 'rate', later));
    expect(sumOf(await entries(inOpen.id))).toBe(90_000);
    expect(await liveAccruals(inOpen.id)).toBe(1);
    // ставка по смене закрытого периода событием rate не трогается даже прямым вызовом
    await tx((t) => settleShift(t, inClosed.id, 'rate', later));
    expect(sumOf(await entries(inClosed.id))).toBe(60_000);
  });

  it('событие attendance по смене закрытого периода: не падает, разница – payroll.correction датой открытого периода; повтор – без дубля', async () => {
    const s = await newStaff({ hourly: 60_000, fee: 0 });
    const day = '2026-05-10' as LocalDate;
    const shift = await plan(s, day);
    await worked(shift.id, shift.rowVersion, 60);
    await deliver(shift.id);
    // Факт поменялся, событие застряло, период успели закрыть: состояние из базы.
    await db.client.query(`UPDATE app.staff_shifts SET status = 'no_show', paid_minutes = NULL, fact_version = fact_version + 1 WHERE id = $1`, [shift.id]);
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2026-05-01', '2026-05-31', 'closed', now())`);
    await tx((t) => settleShift(t, shift.id, 'attendance', later));
    await tx((t) => settleShift(t, shift.id, 'attendance', later));
    const rows = await entries(shift.id);
    expect(rows.map((r) => r.entry_type)).toEqual(['payroll.accrual', 'payroll.correction']);
    expect(sumOf(rows)).toBe(0);
    const when = await db.client.query<{ d: string }>(`SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM journal.ledger_entries WHERE ref_id = $1 AND entry_type = 'payroll.correction'`, [shift.id]);
    expect(when.rows[0]!.d).toBe('2027-12-01'); // сегодня, открыто
    const created = await db.client.query(`SELECT 1 FROM journal.ledger_entries WHERE ref_id = $1 AND reversal_of IS NOT NULL`, [shift.id]);
    expect(created.rows).toEqual([]); // исходная запись закрытого периода не сторнируется
  });

  it('сегодня внутри закрытого периода: корректировка – первым днём после него', async () => {
    const s = await newStaff({ hourly: 60_000, fee: 0 });
    const day = '2027-11-10' as LocalDate;
    const shift = await plan(s, day);
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2027-11-01', '2027-12-05', 'closed', now())`);
    await db.client.query(`UPDATE app.staff_shifts SET status = 'worked', paid_minutes = 60, fact_version = 1 WHERE id = $1`, [shift.id]);
    await tx((t) => settleShift(t, shift.id, 'attendance', later));
    const when = await db.client.query<{ d: string; amount: string }>(`SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, amount FROM journal.ledger_entries WHERE ref_id = $1`, [shift.id]);
    expect(when.rows).toEqual([{ d: '2027-12-06', amount: '60000' }]);
  });
});

describe('формула', () => {
  it('Σ accrual = формула на случайных минутах и ставках (property-based)', async () => {
    let seed = 20261114;
    const rnd = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    const feeMin = 120;
    for (let i = 0; i < 40; i++) {
      const minutes = 1 + rnd(720);
      const hourly = rnd(100_000);
      const fee = rnd(50_000);
      const s = await newStaff({ hourly, fee });
      const shift = await plan(s, '2026-08-15' as LocalDate);
      const v = await worked(shift.id, shift.rowVersion, minutes);
      await deliver(shift.id);
      const expected = accrualParts(minutes, { hourlyKop: hourly, attendanceFeeKop: fee }, feeMin);
      expect(sumOf(await entries(shift.id))).toBe(expected.totalKop);
      expect(expected.hourlyPartKop).toBe(Math.floor((minutes * hourly + 30) / 60));
      expect(expected.feePartKop).toBe(minutes >= feeMin ? fee : 0);
      if (i % 4 === 0) {
        const again = 1 + rnd(720);
        await worked(shift.id, v.rowVersion, again);
        await deliver(shift.id);
        expect(sumOf(await entries(shift.id))).toBe(accrualParts(again, { hourlyKop: hourly, attendanceFeeKop: fee }, feeMin).totalKop);
      }
    }
  });
});
