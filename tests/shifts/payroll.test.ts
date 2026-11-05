// S3-18: периоды и ведомости K18 §7, §9: пересечение, нерешённое при закрытии, гонка «закрытие ↔ уход» 100 раз на настоящем Postgres,
// закрытый период, корректировка в открытом, ready/paid только у закрытого, toPayKop = 0, < 0 (перенос без задвоения баланса), снимок при новой
// ставке, paid дважды – одна выплата.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { verifyBalance } from '../../apps/api/src/core/ledger.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { addDays, localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers } from '../../apps/api/src/modules/shifts/accrual.ts';
import { checkIn, checkOut, setAttendance } from '../../apps/api/src/modules/shifts/attendance.ts';
import { calculateStatements, closePeriod, createPeriod, getStatement, markPaid, postCorrection, setStatementStatus, type PayrollPeriodDto, type PayrollStatementDto } from '../../apps/api/src/modules/shifts/payroll.ts';
import { createPenalty } from '../../apps/api/src/modules/shifts/penalties.ts';
import { createShift, type ShiftDto } from '../../apps/api/src/modules/shifts/plan.ts';
import { setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
let branch = '';
let branch2 = '';
const TZ = 'Asia/Novosibirsk' as TimeZone;
const at = (time: string, date: LocalDate) => localToInstant(date, time as LocalTime, TZ);
const clockAt = (d: Date): Clock => ({ now: () => d });
const nowClock = clockAt(new Date('2031-12-01T05:00:00Z')); // позже всех дат тестов: смены в прошлом
const d = (s: string) => s as LocalDate;

function ctx(role: StaffRole, branchIds: string[] = [], staffId: string = randomUUID()): AccessContext {
  return { actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: nowClock.now() };
}
const owner = ctx('owner');
const meta = (c: AccessContext = owner): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

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
async function newStaff(rate: { hourly: number; fee: number } | null = { hourly: 60_000, fee: 0 }): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  const s = r.rows[0]!.id;
  for (const b of [branch, branch2]) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2020-01-01', $1)`, [s, b]);
  if (rate) await tx((t) => setRate(t, owner, { staffId: s, validFrom: '2020-01-01', hourlyKop: rate.hourly, attendanceFeeKop: rate.fee, reason: 'старт' }, meta(), nowClock));
  await settleEvents();
  return s;
}
const plan = (staffId: string, date: LocalDate, b = branch) => tx((t) => createShift(t, owner, { staffId, branchId: b, start: at('10:00', date).toISOString(), end: at('20:00', date).toISOString() }, meta(), clockAt(new Date('2020-01-01T00:00:00Z'))));
const worked = (s: ShiftDto, paidMinutes: number) => tx((t) => setAttendance(t, owner, s.id, { rowVersion: s.rowVersion, status: 'worked', paidMinutes, reason: 'факт' }, meta(), nowClock));
/** Обработать все неразобранные события начисления, как воркер. */
async function settleEvents(): Promise<void> {
  const r = await db.client.query<{ id: string; event_type: string }>(
    `SELECT e.id, e.event_type FROM app.outbox_events e WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set')
       AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id) ORDER BY e.occurred_at, e.id`,
  );
  for (const e of r.rows) await processEvent(pool, e.event_type === 'staff.rate_set' ? HANDLER_RATE : HANDLER_ATTENDANCE, e.id, nowClock.now());
}
let cursor = d('2030-01-01');
/** Новый месячный диапазон, не пересекающий другие тесты. */
function nextRange(days = 28): { from: LocalDate; to: LocalDate; day: LocalDate } {
  const from = cursor;
  const to = addDays(from, days - 1);
  cursor = addDays(to, 1);
  return { from, to, day: addDays(from, 9) };
}
const period = (r: { from: LocalDate; to: LocalDate }): Promise<PayrollPeriodDto> => tx((t) => createPeriod(t, owner, r, meta(), nowClock));
const close = (id: string, c: Clock = nowClock) => tx((t) => closePeriod(t, owner, id, {}, meta(), c));
const statementOf = async (periodId: string, staffId: string): Promise<PayrollStatementDto> => {
  const r = await db.client.query<{ id: string }>(`SELECT id FROM app.payroll_statements WHERE period_id = $1 AND staff_id = $2`, [periodId, staffId]);
  return getStatement(pool, owner, r.rows[0]!.id, nowClock);
};
const toStatus = (s: PayrollStatementDto, status: 'checked' | 'ready' | 'disputed' | 'calculated', who = owner) => tx((t) => setStatementStatus(t, who, s.id, { rowVersion: s.rowVersion, status }, meta(who), nowClock));
async function readyStatement(s: PayrollStatementDto): Promise<PayrollStatementDto> {
  return toStatus(await toStatus(s, 'checked'), 'ready');
}
const paid = (s: PayrollStatementDto, date = '2031-11-30') => tx((t) => markPaid(t, owner, s.id, { rowVersion: s.rowVersion, actualPayoutDate: date }, meta(), nowClock));
const balance = async (staffId: string) => {
  const a = await db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'staff_payroll' AND owner_id = $1`, [staffId]);
  return (await verifyBalance(db.client, a.rows[0]!.id)).cached;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  branch = (await createTestBranch(db.client)).id;
  branch2 = (await createTestBranch(db.client)).id;
  for (const b of [branch, branch2]) await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, x, '09:00', '23:00', '2020-01-01', $2 FROM generate_series(1, 7) x`, [b, randomUUID()]);
  clearSubscriptions();
  registerPayrollHandlers({ clock: nowClock });
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('payroll.penalties_enabled', 'network', 'true', '2020-01-01', $1)`, [randomUUID()]);
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('периоды', () => {
  it('пересекающийся период – PAYROLL_PERIOD_OVERLAP; Директор – 403; конец раньше начала – 400', async () => {
    const r = nextRange();
    await period(r);
    await expect(period({ from: addDays(r.to, -1), to: addDays(r.to, 5) })).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_OVERLAP' });
    const director = ctx('director', [branch]);
    await expect(tx((t) => createPeriod(t, director, { from: '2029-01-01', to: '2029-01-31' }, meta(director), nowClock))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(period({ from: d('2029-02-10'), to: d('2029-02-01') })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('закрытие при needs_review – UNRESOLVED; после решения закрывается', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff();
    const shift = await plan(s, r.day);
    await db.client.query(`UPDATE app.staff_shifts SET status = 'needs_review', review_reason = 'no_checkin' WHERE id = $1`, [shift.id]);
    const err = await close(p.id).catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED', details: { shiftIds: [shift.id], rateIds: [] } });
    await tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'no_show', reason: 'не вышел' }, meta(), nowClock));
    await settleEvents();
    expect((await close(p.id)).status).toBe('closed');
    await expect(close(p.id)).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
  });

  it('смена worked без payroll_accruals на текущую fact_version – UNRESOLVED; после обработки события закрывается', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff();
    await worked(await plan(s, r.day), 60);
    await expect(close(p.id)).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED' });
    await settleEvents();
    expect((await close(p.id)).status).toBe('closed');
    expect((await statementOf(p.id, s)).totals).toMatchObject({ accruedKop: 60_000, toPayKop: 60_000, workedShifts: 1, paidMinutes: 60 });
  });

  it('необработанное staff.rate_set со сменой периода – UNRESOLVED со списком; rate_missing – UNRESOLVED; «не оплачивается» закрывает', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff();
    await worked(await plan(s, r.day), 60);
    await settleEvents();
    const { rate } = await tx((t) => setRate(t, owner, { staffId: s, validFrom: '2020-01-01', hourlyKop: 90_000, attendanceFeeKop: 0, reason: 'x' }, meta(), nowClock));
    const err = await close(p.id).catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED', details: { rateIds: [rate.id] } });
    await settleEvents();

    const noRate = await newStaff(null);
    const unpaidShift = await worked(await plan(noRate, r.day), 60);
    await settleEvents();
    const e2 = await close(p.id).catch((e: AppError) => e);
    expect(e2).toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED', details: { shiftIds: [unpaidShift.id] } });
    await tx((t) => setAttendance(t, owner, unpaidShift.id, { rowVersion: unpaidShift.rowVersion, unpaidConfirmed: true, reason: 'стажировка' }, meta(), nowClock));
    await settleEvents();
    expect((await close(p.id)).status).toBe('closed');
    expect((await statementOf(p.id, s)).totals.toPayKop).toBe(90_000);
  });

  it('любая плановая смена в периоде – UNRESOLVED: и прошедшая, и идущая с приходом, и будущая; часы не теряются', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff();
    const self = ctx('admin', [branch], s);
    const shift = await plan(s, r.day);
    await expect(close(p.id)).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED', details: { shiftIds: [shift.id] } }); // прошла
    await expect(close(p.id, clockAt(at('09:00', r.day)))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED', details: { shiftIds: [shift.id] } }); // будущая
    await tx((t) => checkIn(t, self, shift.id, meta(self), clockAt(at('10:00', r.day))));
    await settleEvents();
    const during = clockAt(at('12:00', r.day));
    await expect(close(p.id, during)).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED', details: { shiftIds: [shift.id] } }); // идёт
    await tx((t) => checkOut(t, self, shift.id, meta(self), during));
    await settleEvents();
    expect((await close(p.id, during)).status).toBe('closed');
    expect((await statementOf(p.id, s)).totals).toMatchObject({ accruedKop: 120_000, workedShifts: 1, paidMinutes: 120 });
  });

  it('гонка «закрытие ↔ отметка ухода» 100 раз: закрытие не проходит мимо, отметка не теряется, начисление в периоде', async () => {
    const s = await newStaff();
    const self = ctx('admin', [branch], s);
    for (let i = 0; i < 100; i++) {
      const r = nextRange(1);
      const day = r.from;
      const p = await period(r);
      const shift = await plan(s, day);
      await tx((t) => checkIn(t, self, shift.id, meta(self), clockAt(at('12:00', day))));
      await settleEvents();
      const later = clockAt(at('13:00', day));
      const delay = i % 2 === 0 ? 0 : (i % 10) + 1;
      const [closing, leaving] = await Promise.allSettled([new Promise((res) => setTimeout(res, delay)).then(() => close(p.id, later)), tx((t) => checkOut(t, self, shift.id, meta(self), later))]);
      // В обоих порядках закрытие видит нерешённую смену: planned или worked без начисления.
      expect(leaving.status).toBe('fulfilled');
      expect((closing as PromiseRejectedResult).reason).toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED' });
      await settleEvents();
      expect((await close(p.id, later)).status).toBe('closed');
      expect((await statementOf(p.id, s)).totals).toMatchObject({ accruedKop: 60_000, workedShifts: 1 });
    }
  }, 120_000);

  it('гонка «закрытие ↔ исправление факта» 100 раз: либо исправление до закрытия и период не закрыт, либо PAYROLL_PERIOD_CLOSED и снимок цел', async () => {
    const s = await newStaff();
    const outcomes = { before: 0, closed: 0 };
    for (let i = 0; i < 100; i++) {
      const r = nextRange(1);
      const p = await period(r);
      const shift = await worked(await plan(s, r.from), 60);
      await settleEvents();
      const delay = i % 2 === 0 ? 0 : (i % 10) + 1;
      const [closing, fixing] = await Promise.allSettled([
        new Promise((res) => setTimeout(res, delay)).then(() => close(p.id)),
        tx((t) => setAttendance(t, owner, shift.id, { rowVersion: shift.rowVersion, status: 'worked', paidMinutes: 90, reason: 'поправка' }, meta(), nowClock)),
      ]);
      if (fixing.status === 'fulfilled') {
        outcomes.before += 1;
        expect((closing as PromiseRejectedResult).reason).toMatchObject({ code: 'PAYROLL_PERIOD_HAS_UNRESOLVED' });
        await settleEvents();
        expect((await close(p.id)).status).toBe('closed');
        expect((await statementOf(p.id, s)).totals.accruedKop).toBe(90_000);
      } else {
        outcomes.closed += 1;
        expect(closing.status).toBe('fulfilled');
        expect(fixing.reason).toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
        expect((await statementOf(p.id, s)).totals.accruedKop).toBe(60_000);
      }
    }
    expect(outcomes.before).toBeGreaterThan(0);
    expect(outcomes.closed).toBeGreaterThan(0);
  }, 120_000);

  it('после закрытия смена и штраф с датой периода – PAYROLL_PERIOD_CLOSED; корректировка закрытого – запись в открытом со ссылкой', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff();
    const shift = await worked(await plan(s, r.day), 60);
    await settleEvents();
    await close(p.id);
    await expect(plan(s, addDays(r.day, 1))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
    await expect(tx((t) => setAttendance(t, owner, shift.id, { rowVersion: shift.rowVersion, status: 'no_show', reason: 'x' }, meta(), nowClock))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
    await expect(tx((t) => createPenalty(t, owner, { staffId: s, branchId: branch, date: r.day, amountKop: 100, reason: 'x' }, meta(), nowClock))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });

    await expect(tx((t) => postCorrection(t, owner, { staffId: s, amountKop: -5_000, ref: { type: 'shift', id: shift.id } }, meta(), { idempotencyKey: randomUUID(), clock: nowClock }))).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    const director = ctx('director', [branch]);
    await expect(tx((t) => postCorrection(t, director, { staffId: s, amountKop: -5_000, ref: { type: 'shift', id: shift.id }, reason: 'x' }, meta(director), { idempotencyKey: randomUUID(), clock: nowClock }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const key = randomUUID();
    const c = await tx((t) => postCorrection(t, owner, { staffId: s, amountKop: -5_000, ref: { type: 'shift', id: shift.id }, reason: 'переплата' }, meta(), { idempotencyKey: key, clock: nowClock }));
    expect(c.date).toBe('2031-12-01');
    const e = await db.client.query(`SELECT entry_type, amount, ref_type, ref_id, branch_id FROM journal.ledger_entries WHERE posting_id = $1`, [c.postingId]);
    expect(e.rows).toEqual([{ entry_type: 'payroll.correction', amount: '-5000', ref_type: 'shift', ref_id: shift.id, branch_id: branch }]);
    const again = await tx((t) => postCorrection(t, owner, { staffId: s, amountKop: -5_000, ref: { type: 'shift', id: shift.id }, reason: 'переплата' }, meta(), { idempotencyKey: key, clock: nowClock }));
    expect(again.postingId).toBe(c.postingId);
    expect((await statementOf(p.id, s)).totals.toPayKop).toBe(60_000); // снимок тот же
  });
});

describe('ведомости', () => {
  it('разбивка по филиалам без двойного учёта; пересчёт draft → calculated; ready и paid у открытого периода – PAYROLL_PERIOD_OPEN', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff({ hourly: 60_000, fee: 10_000 });
    await worked(await plan(s, r.day), 180);
    await worked(await plan(s, addDays(r.day, 1), branch2), 60); // короче порога – без ставки за выход
    await settleEvents();
    const list = await tx((t) => calculateStatements(t, owner, p.id, meta(), nowClock));
    const st = list.find((x) => x.staffId === s)!;
    expect(st.status).toBe('calculated');
    expect(st.totals).toMatchObject({ workedShifts: 2, paidMinutes: 240, accruedKop: 250_000, hourlyPartKop: 240_000, feePartKop: 10_000, toPayKop: 250_000 });
    expect(st.byBranch.map((b) => [b.branchId, b.accruedKop]).sort()).toEqual([[branch, 190_000], [branch2, 60_000]].sort());
    const checked = await toStatus(st, 'checked');
    await expect(toStatus(checked, 'ready')).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_OPEN' });
    await expect(paid(checked)).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_OPEN' });
  });

  it('штрафы и корректировки в toPayKop; прогноз отдельно (05 §8.2) и не в журнале', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff({ hourly: 60_000, fee: 0 });
    await worked(await plan(s, r.day), 60);
    const future = at('10:00', addDays(r.day, 3));
    await tx((t) => createShift(t, owner, { staffId: s, branchId: branch, start: future.toISOString(), end: new Date(future.getTime() + 2 * 3_600_000).toISOString() }, meta(), clockAt(new Date('2020-01-01T00:00:00Z'))));
    await settleEvents();
    await tx((t) => createPenalty(t, owner, { staffId: s, branchId: branch, date: r.day, amountKop: 10_000, reason: 'опоздание' }, meta(), nowClock));
    const [st] = (await tx((t) => calculateStatements(t, owner, p.id, meta(), clockAt(at('09:00', r.day))))).filter((x) => x.staffId === s);
    expect(st!.totals).toMatchObject({ accruedKop: 60_000, penaltiesKop: 10_000, toPayKop: 50_000, forecastKop: 120_000 });
    expect(st!.needsReview).toEqual([]);
    const entries = await db.client.query(`SELECT count(*)::int AS n FROM journal.ledger_entries le JOIN app.ledger_accounts a ON a.id = le.account_id WHERE a.owner_id = $1 AND le.entry_type = 'payroll.accrual'`, [s]);
    expect(entries.rows[0].n).toBe(1);
  });

  it('снимок закрытой ведомости не меняется при новой ставке (приёмка 15); paid дважды – одна выплата; после paid статус не меняется', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff();
    await worked(await plan(s, r.day), 60);
    await settleEvents();
    await close(p.id);
    const before = await statementOf(p.id, s);
    const { rate, affectedShiftIds } = await tx((t) => setRate(t, owner, { staffId: s, validFrom: '2020-01-01', hourlyKop: 120_000, attendanceFeeKop: 0, reason: 'x' }, meta(), nowClock));
    expect(affectedShiftIds).toEqual([]);
    const ev = await db.client.query<{ id: string }>(`SELECT id FROM app.outbox_events WHERE aggregate_id = $1`, [rate.id]);
    await processEvent(pool, HANDLER_RATE, ev.rows[0]!.id, nowClock.now());
    await tx((t) => calculateStatements(t, owner, p.id, meta(), nowClock)); // закрытый период: снимок не трогается
    const after = await statementOf(p.id, s);
    expect(after.totals).toEqual(before.totals);
    expect(after.rowVersion).toBe(before.rowVersion);

    const ready = await readyStatement(after);
    expect(ready.status).toBe('ready');
    const [one, two] = await Promise.all([paid(ready), paid(ready)]);
    expect(one.status).toBe('paid');
    expect(two.status).toBe('paid');
    const payouts = await db.client.query(`SELECT amount FROM journal.ledger_entries WHERE ref_type = 'payroll_statement' AND ref_id = $1 AND entry_type = 'payroll.payout'`, [ready.id]);
    expect(payouts.rows).toEqual([{ amount: '-60000' }]);
    expect(await balance(s)).toBe(0);
    expect((await paid(ready)).actualPayoutDate).toBe('2031-11-30');
    await expect(toStatus(one, 'disputed')).rejects.toBeInstanceOf(AppError);
  });

  it('toPayKop = 0 → paid без проводки', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff({ hourly: 0, fee: 0 });
    await worked(await plan(s, r.day), 60);
    await settleEvents();
    await close(p.id);
    const done = await paid(await readyStatement(await statementOf(p.id, s)));
    expect(done.status).toBe('paid');
    expect((await db.client.query(`SELECT payout_posting_id FROM app.payroll_statements WHERE id = $1`, [done.id])).rows).toEqual([{ payout_posting_id: null }]);
    expect((await db.client.query(`SELECT 1 FROM journal.ledger_entries WHERE ref_id = $1`, [done.id])).rows).toEqual([]);
  });

  it('toPayKop < 0 → paid без выплаты, минус переносится корректировкой в следующий период; баланс не задваивается', async () => {
    const r1 = nextRange();
    const r2 = nextRange();
    const p1 = await period(r1);
    const p2 = await period(r2);
    const s = await newStaff();
    await tx((t) => createPenalty(t, owner, { staffId: s, branchId: branch, date: r1.day, amountKop: 50_000, reason: 'недостача по решению' }, meta(), nowClock));
    await close(p1.id);
    const st = await statementOf(p1.id, s);
    expect(st.totals.toPayKop).toBe(-50_000);
    const done = await paid(await readyStatement(st));
    expect(done.status).toBe('paid');
    const payouts = await db.client.query(`SELECT 1 FROM journal.ledger_entries WHERE ref_id = $1 AND entry_type = 'payroll.payout'`, [st.id]);
    expect(payouts.rows).toEqual([]);
    const corr = await db.client.query<{ amount: string; d: string; refs: Record<string, string> }>(`SELECT amount, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, refs FROM journal.ledger_entries WHERE ref_id = $1 AND entry_type = 'payroll.correction' ORDER BY id`, [st.id]);
    expect(corr.rows.map((c) => [c.amount, c.d])).toEqual([['-50000', r2.from], ['50000', r2.from]]);

    // Следующий период: минус виден в итогах, а выплата закрывает счёт в ноль.
    await worked(await plan(s, r2.day), 120);
    await settleEvents();
    await close(p2.id);
    const next = await statementOf(p2.id, s);
    expect(next.totals).toMatchObject({ accruedKop: 120_000, correctionsKop: -50_000, toPayKop: 70_000 });
    await paid(await readyStatement(next));
    expect(await balance(s)).toBe(0);
  });

  it('ready при нерешённой смене – PAYROLL_STATEMENT_NEEDS_REVIEW; disputed и обратно; недопустимый переход – отказ; версия', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff();
    const shift = await worked(await plan(s, r.day), 60);
    await settleEvents();
    await close(p.id);
    const st = await statementOf(p.id, s);
    await db.client.query(`UPDATE app.staff_shifts SET status = 'needs_review' WHERE id = $1`, [shift.id]);
    const checked = await toStatus(st, 'checked');
    await expect(toStatus(checked, 'ready')).rejects.toMatchObject({ code: 'PAYROLL_STATEMENT_NEEDS_REVIEW' });
    await db.client.query(`UPDATE app.staff_shifts SET status = 'worked' WHERE id = $1`, [shift.id]);
    const disputed = await toStatus(checked, 'disputed');
    await expect(toStatus(disputed, 'ready')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(toStatus(checked, 'calculated')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await toStatus(disputed, 'calculated')).status).toBe('calculated');
  });

  it('Директор зоны {А}: ведомость сотрудника в обоих филиалах – только суммы А; ready и paid – 403; ведомость чужой зоны – 404; Администратор – 403', async () => {
    const r = nextRange();
    const p = await period(r);
    const s = await newStaff();
    await worked(await plan(s, r.day), 60);
    await worked(await plan(s, addDays(r.day, 1), branch2), 120);
    const onlyB = await newStaff();
    await worked(await plan(onlyB, r.day, branch2), 60);
    await settleEvents();
    await close(p.id);
    const st = await statementOf(p.id, s);
    expect(st.totals.toPayKop).toBe(180_000);
    const director = ctx('director', [branch]);
    const seen = await getStatement(pool, director, st.id, nowClock);
    expect(seen.totals).toMatchObject({ accruedKop: 60_000, toPayKop: 60_000, workedShifts: 1 });
    expect(seen.byBranch.map((b) => b.branchId)).toEqual([branch]);
    await expect(toStatus(st, 'ready', director)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(tx((t) => markPaid(t, director, st.id, { rowVersion: st.rowVersion, actualPayoutDate: '2031-11-30' }, meta(director), nowClock))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await statementOf(p.id, onlyB);
    await expect(getStatement(pool, director, other.id, nowClock)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getStatement(pool, ctx('admin', [branch]), st.id, nowClock)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await toStatus(st, 'checked', director)).status).toBe('checked');
  });
});
