// S3-13: факт выхода K18 §5: окно прихода, отметка только за себя, минуты по факту, ручные минуты с комментарием, невыход,
// «не оплачивается», fact_version и событие на каждое изменение, закрытый период; shifts.review – needs_review ровно один раз.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { checkIn, checkOut, reviewShifts, setAttendance, startShiftReview } from '../../apps/api/src/modules/shifts/attendance.ts';
import { createShift, getShift, type ShiftDto } from '../../apps/api/src/modules/shifts/plan.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const TZ = 'Asia/Novosibirsk' as TimeZone;
const DAY = '2026-11-20' as LocalDate;
const at = (time: string, date: LocalDate = DAY) => localToInstant(date, time as LocalTime, TZ);
const clockAt = (d: Date): Clock => ({ now: () => d });
const before = clockAt(new Date('2026-11-14T05:00:00Z'));

function ctx(role: StaffRole, staffId: string = randomUUID(), branchIds: string[] = []): AccessContext {
  return { actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: before.now() };
}
const owner = ctx('owner');
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

/** Новый сотрудник с плановой сменой 10:00–16:00; self – его контекст. */
async function setup(date: LocalDate = DAY): Promise<{ s: string; b: string; self: AccessContext; shift: ShiftDto }> {
  const { id: b } = await createTestBranch(db.client);
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '09:00', '23:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [b, randomUUID()]);
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  const s = r.rows[0]!.id;
  await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s, b]);
  const shift = await tx((t) => createShift(t, owner, { staffId: s, branchId: b, start: at('10:00', date).toISOString(), end: at('16:00', date).toISOString() }, meta(owner), before));
  return { s, b, self: ctx('admin', s, [b]), shift };
}
const events = async (shiftId: string) =>
  (await db.client.query<{ payload: { factVersion: number } }>(`SELECT payload FROM app.outbox_events WHERE event_type = 'shift.attendance_changed' AND aggregate_id = $1`, [shiftId])).rows.map((e) => e.payload.factVersion).sort();

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('приход и уход', () => {
  it('раньше окна и после конца смены – CHECKIN_WINDOW; за 30 минут – можно; приход не делает смену фактом', async () => {
    const { self, shift } = await setup();
    await expect(tx((t) => checkIn(t, self, shift.id, meta(self), clockAt(at('09:29'))))).rejects.toMatchObject({ code: 'CHECKIN_WINDOW' });
    await expect(tx((t) => checkIn(t, self, shift.id, meta(self), clockAt(at('16:00'))))).rejects.toMatchObject({ code: 'CHECKIN_WINDOW' });
    const c = clockAt(at('09:30'));
    const d = await tx((t) => checkIn(t, self, shift.id, meta(self), c));
    expect(d).toMatchObject({ status: 'planned', factStart: at('09:30').toISOString(), factEnd: null, paidMinutes: null, factVersion: 1 });
    const again = await tx((t) => checkIn(t, self, shift.id, meta(self), clockAt(at('09:40'))));
    expect(again.factVersion).toBe(1);
    expect(await events(shift.id)).toEqual([1]);
  });

  it('за другого – FORBIDDEN, вне зоны – 404', async () => {
    const { shift, b } = await setup();
    const colleague = ctx('admin', randomUUID(), [b]);
    await expect(tx((t) => checkIn(t, colleague, shift.id, meta(colleague), clockAt(at('10:00'))))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(tx((t) => checkOut(t, colleague, shift.id, meta(colleague), clockAt(at('10:00'))))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const stranger = ctx('admin', randomUUID(), [randomUUID()]);
    await expect(tx((t) => checkIn(t, stranger, shift.id, meta(stranger), clockAt(at('10:00'))))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(tx((t) => checkIn(t, owner, shift.id, meta(owner), clockAt(at('10:00'))))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('уход: worked, минуты между отметками без обрезки по плану, повторный уход – без изменений', async () => {
    const { self, shift } = await setup();
    await expect(tx((t) => checkOut(t, self, shift.id, meta(self), clockAt(at('11:00'))))).rejects.toMatchObject({ code: 'CHECKIN_WINDOW' });
    await tx((t) => checkIn(t, self, shift.id, meta(self), clockAt(at('09:45'))));
    const out = await tx((t) => checkOut(t, self, shift.id, meta(self), clockAt(at('16:30'))));
    expect(out).toMatchObject({ status: 'worked', paidMinutes: 405, paidMinutesSource: 'fact_time', factVersion: 2 });
    const again = await tx((t) => checkOut(t, self, shift.id, meta(self), clockAt(at('16:40'))));
    expect(again).toMatchObject({ paidMinutes: 405, factVersion: 2 });
    expect(await events(shift.id)).toEqual([1, 2]);
    const audit = await db.client.query(`SELECT action, after FROM journal.audit_events WHERE object_type = 'shift' AND object_id = $1 AND action = 'shift.attendance_set'`, [shift.id]);
    expect(audit.rows).toHaveLength(2);
  });
});

describe('setAttendance', () => {
  it('ручные минуты без комментария – COMMENT_REQUIRED; с комментарием – worked, источник manual', async () => {
    const { shift } = await setup();
    const c = clockAt(at('20:00'));
    await expect(tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'worked', paidMinutes: 120 }, meta(owner), c))).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    await expect(tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'worked', paidMinutes: 120, reason: ' ' }, meta(owner), c))).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    const d = await tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'worked', paidMinutes: 120, reason: 'забыл отметиться' }, meta(owner), c));
    expect(d).toMatchObject({ status: 'worked', paidMinutes: 120, paidMinutesSource: 'manual', rowVersion: 2, factVersion: 1 });
  });

  it('факт по времени считает минуты; приход позже ухода – INVALID_DURATION; уход в будущем – отказ', async () => {
    const { shift } = await setup();
    const c = clockAt(at('20:00'));
    await expect(tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'worked', factStart: at('12:00').toISOString(), factEnd: at('10:00').toISOString(), reason: 'x' }, meta(owner), c))).rejects.toMatchObject({ code: 'INVALID_DURATION' });
    await expect(tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'worked', factStart: at('10:00').toISOString(), factEnd: at('21:00').toISOString(), reason: 'x' }, meta(owner), c))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const d = await tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'worked', factStart: at('10:00').toISOString(), factEnd: at('12:01').toISOString(), reason: 'x' }, meta(owner), c));
    expect(d).toMatchObject({ paidMinutes: 121, paidMinutesSource: 'fact_time' });
  });

  it('невыход снимает факт; смена не началась – SHIFT_NOT_EDITABLE; устаревшая версия – VERSION_CONFLICT', async () => {
    const { shift } = await setup();
    await expect(tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'no_show', reason: 'x' }, meta(owner), clockAt(at('09:00'))))).rejects.toMatchObject({ code: 'SHIFT_NOT_EDITABLE' });
    const c = clockAt(at('20:00'));
    const worked = await tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'worked', paidMinutes: 60, reason: 'x' }, meta(owner), c));
    await expect(tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'no_show', reason: 'x' }, meta(owner), c))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const d = await tx((t) => setAttendance(t, owner, shift.id, { rowVersion: worked.rowVersion, status: 'no_show', reason: 'не пришёл' }, meta(owner), c));
    expect(d).toMatchObject({ status: 'no_show', paidMinutes: null, factStart: null, factVersion: 2 });
  });

  it('«не оплачивается» – флаг с причиной, статус тот же; Администратор – 403, чужая зона – 404', async () => {
    const { shift, b } = await setup();
    const c = clockAt(at('20:00'));
    const adminCtx = ctx('admin', randomUUID(), [b]);
    await expect(tx((t) => setAttendance(t, adminCtx, shift.id, { rowVersion: 1, unpaidConfirmed: true, reason: 'x' }, meta(adminCtx), c))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const foreign = ctx('director', randomUUID(), [randomUUID()]);
    await expect(tx((t) => setAttendance(t, foreign, shift.id, { rowVersion: 1, unpaidConfirmed: true, reason: 'x' }, meta(foreign), c))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const d = await tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, unpaidConfirmed: true, reason: 'стажировка' }, meta(owner), c));
    expect(d).toMatchObject({ status: 'planned', flags: { unpaidConfirmed: true } });
  });

  it('смена в закрытом периоде – PAYROLL_PERIOD_CLOSED для отметок и исправления', async () => {
    const date = '2027-05-10' as LocalDate;
    const { self, shift } = await setup(date);
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2027-05-01', '2027-05-31', 'closed', now())`);
    const c = clockAt(at('10:00', date));
    await expect(tx((t) => checkIn(t, self, shift.id, meta(self), c))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
    await expect(tx((t) => checkOut(t, self, shift.id, meta(self), c))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
    await expect(tx((t) => setAttendance(t, owner, shift.id, { rowVersion: 1, status: 'no_show', reason: 'x' }, meta(owner), c))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
  });
});

describe('shifts.review', () => {
  it('плановая без отметки – не факт (приёмка 11): после review_grace – needs_review ровно один раз; причина по отметке прихода', async () => {
    const date = '2026-12-05' as LocalDate;
    const noCheckIn = await setup(date);
    const noCheckOut = await setup(date);
    await tx((t) => checkIn(t, noCheckOut.self, noCheckOut.shift.id, meta(noCheckOut.self), clockAt(at('10:00', date))));
    await reviewShifts(pool, clockAt(at('16:59', date))); // другие тесты файла могли оставить более ранние смены
    expect((await getShift(pool, noCheckIn.shift.id))?.status).toBe('planned');
    expect((await getShift(pool, noCheckIn.shift.id))?.factVersion).toBe(0);

    const c = clockAt(at('17:00', date));
    expect(await reviewShifts(pool, c)).toBeGreaterThanOrEqual(2);
    expect(await reviewShifts(pool, c)).toBe(0); // повтор задачи
    expect(await getShift(pool, noCheckIn.shift.id)).toMatchObject({ status: 'needs_review', paidMinutes: null, flags: { reviewReason: 'no_checkin' } });
    expect(await getShift(pool, noCheckOut.shift.id)).toMatchObject({ status: 'needs_review', flags: { reviewReason: 'no_checkout' } });
    const audit = await db.client.query(`SELECT count(*)::int AS n FROM journal.audit_events WHERE action = 'shift.review_flagged' AND object_id = $1`, [noCheckIn.shift.id]);
    expect(audit.rows[0]!.n).toBe(1);

    // Уход после needs_review исправляет руководитель; после исправления причина снята.
    await expect(tx((t) => checkOut(t, noCheckOut.self, noCheckOut.shift.id, meta(noCheckOut.self), c))).rejects.toMatchObject({ code: 'SHIFT_NOT_EDITABLE' });
    const fixed = await tx((t) => setAttendance(t, owner, noCheckOut.shift.id, { rowVersion: 3, status: 'worked', paidMinutes: 300, reason: 'забыл уход' }, meta(owner), c));
    expect(fixed).toMatchObject({ status: 'worked', flags: { reviewReason: null } });
  });

  it('смену в закрытом периоде задача не трогает; запуск в worker – таймер со stop', async () => {
    const date = '2027-07-10' as LocalDate;
    const { shift } = await setup(date);
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2027-07-01', '2027-07-31', 'closed', now())`);
    await reviewShifts(pool, clockAt(at('23:00', date)));
    expect((await getShift(pool, shift.id))?.status).toBe('planned');
    const seen: unknown[] = [];
    const task = startShiftReview({ pool, clock: before, intervalMs: 10, onError: (e) => seen.push(e) });
    await new Promise((r) => setTimeout(r, 40));
    task.stop();
    expect(seen).toEqual([]);
  });
});
