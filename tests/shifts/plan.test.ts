// S3-11: планирование смен K18 §4. TC-15: два филиала одного города, стык, пересечение, 50 параллельных создания → одна;
// вне графика, срок своей смены, on_leave и список требующих решения, закрытый период, чужая правка (история + событие).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, localToInstant, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { cancelShift, createShift, getShift, setPlanningStatus, updateShift } from '../../apps/api/src/modules/shifts/plan.ts';
import { setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const NOW = '2026-11-14T05:00:00Z'; // 12:00 в Новосибирске
const clock = fixedClock(NOW);
const TZ = 'Asia/Novosibirsk' as TimeZone;
const DAY = '2026-11-20' as LocalDate;
const at = (time: string, date: LocalDate = DAY) => localToInstant(date, time as LocalTime, TZ).toISOString();

function ctx(role: StaffRole, staffId: string = randomUUID(), branchIds: string[] = []): AccessContext {
  return { actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() };
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

async function newStaff(branchIds: string[], role: StaffRole = 'admin'): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`, [`${randomUUID()}@yu.test`, role]);
  const id = r.rows[0]!.id;
  for (const b of branchIds) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [id, b]);
  }
  return id;
}
async function newBranch(cityId?: string): Promise<string> {
  const b = await createTestBranch(db.client, cityId ? { cityId } : {});
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '09:00', '23:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [b.id, randomUUID()]);
  return b.id;
}
const create = (staffId: string, branchId: string, start: string, end: string, who = owner) => tx((t) => createShift(t, who, { staffId, branchId, start, end }, meta(who), clock));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 55 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('TC-15', () => {
  it('А 10–16 + Б 16–21 – обе; Б 15–21 – SHIFT_OVERLAP с details; филиал другого города без назначения – STAFF_NOT_ASSIGNED', async () => {
    const city = await createTestCity(db.client);
    const a = await newBranch(city);
    const b = await newBranch(city);
    const other = await newBranch();
    const s = await newStaff([a, b]);
    const first = await create(s, a, at('10:00'), at('16:00'));
    expect(first).toMatchObject({ status: 'planned', localDate: DAY, plannedMinutes: 360, branchId: a, timezone: TZ });
    expect((await create(s, b, at('16:00'), at('21:00'))).status).toBe('planned');
    const err = await create(s, b, at('15:00'), at('21:00'), owner).catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'SHIFT_OVERLAP', details: { conflictShiftId: first.id, branchId: a } });
    await expect(create(s, other, at('08:00', '2026-11-21' as LocalDate), at('10:00', '2026-11-21' as LocalDate))).rejects.toMatchObject({ code: 'STAFF_NOT_ASSIGNED' });
  });

  it('филиал смены вне зоны смотрящего – в details нет branchId', async () => {
    const a = await newBranch();
    const b = await newBranch();
    const s = await newStaff([a, b]);
    const director = ctx('director', randomUUID(), [b]);
    await create(s, a, at('10:00'), at('16:00'));
    const err = await create(s, b, at('15:00'), at('20:00'), director).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('SHIFT_OVERLAP');
    expect((err as AppError).details?.branchId).toBeUndefined();
  });

  it('50 параллельных пересекающихся смен одного сотрудника в двух филиалах → одна, без 40P01', async () => {
    const a = await newBranch();
    const b = await newBranch();
    const s = await newStaff([a, b]);
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => create(s, i % 2 ? a : b, at('10:00'), at('14:00'))));
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as AppError).code).toBe('SHIFT_OVERLAP');
    const n = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.staff_shifts WHERE staff_id = $1`, [s]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('гарантию держит база: прямая вставка пересечения – 23P01', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    await create(s, a, at('10:00'), at('14:00'));
    await expect(
      db.client.query(`INSERT INTO app.staff_shifts (staff_id, branch_id, local_date, period, created_by) VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $1)`, [s, a, DAY, at('13:00'), at('15:00')]),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'staff_shifts_no_overlap' });
  });
});

describe('проверки K18 §4', () => {
  it('смена 2 ч проходит; shift.min_minutes работает, если задан', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    expect((await create(s, a, at('10:00'), at('12:00'))).plannedMinutes).toBe(120);
    await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('shift.min_minutes', 'network', '180', '2026-01-01', $1)`, [randomUUID()]);
    await expect(create(s, a, at('13:00'), at('15:00'))).rejects.toMatchObject({ code: 'SHIFT_TOO_SHORT' });
    await db.client.query(`UPDATE app.settings_values SET valid_to = '2026-01-02' WHERE key = 'shift.min_minutes'`);
    await db.client.query(`DELETE FROM app.settings_values WHERE key = 'shift.min_minutes'`);
  });

  it('начало позже конца и переход через полночь – INVALID_DURATION', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    await expect(create(s, a, at('12:00'), at('10:00'))).rejects.toMatchObject({ code: 'INVALID_DURATION' });
    await expect(create(s, a, at('22:00'), at('01:00', '2026-11-21' as LocalDate))).rejects.toMatchObject({ code: 'INVALID_DURATION' });
  });

  it('вне графика: Администратор сам – OUTSIDE_SCHEDULE; Директор с правом – пометка outsideHours', async () => {
    const a = await newBranch();
    const adminId = await newStaff([a]);
    await expect(create(adminId, a, at('06:00'), at('08:00'), ctx('admin', adminId, [a]))).rejects.toMatchObject({ code: 'OUTSIDE_SCHEDULE' });
    const shift = await create(adminId, a, at('06:00'), at('08:00'), ctx('director', randomUUID(), [a]));
    expect(shift.flags.outsideHours).toBe(true);
  });

  it('своя смена: за 23 ч – SHIFT_EDIT_DEADLINE, за 25 ч – можно; задним числом – нельзя', async () => {
    const a = await newBranch();
    const adminId = await newStaff([a]);
    const self = ctx('admin', adminId, [a]);
    const in23 = new Date(new Date(NOW).getTime() + 23 * 3_600_000);
    await expect(create(adminId, a, in23.toISOString(), new Date(in23.getTime() + 3_600_000).toISOString(), self)).rejects.toMatchObject({ code: 'SHIFT_EDIT_DEADLINE' });
    const ok = new Date(new Date(NOW).getTime() + 25 * 3_600_000);
    expect((await create(adminId, a, ok.toISOString(), new Date(ok.getTime() + 3_600_000).toISOString(), self)).status).toBe('planned');
    await expect(create(adminId, a, at('10:00', '2026-11-13' as LocalDate), at('12:00', '2026-11-13' as LocalDate), self)).rejects.toMatchObject({ code: 'SHIFT_EDIT_DEADLINE' });
  });

  it('заблокированный и в архиве – STAFF_NOT_ACTIVE; on_leave – STAFF_ON_LEAVE, будущие смены – в futureShiftsNeedingDecision и не отменены', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    const future = await create(s, a, at('10:00'), at('12:00'));
    const res = await tx((t) => setPlanningStatus(t, owner, s, { planningStatus: 'on_leave' }, meta(owner), clock));
    expect(res.planningStatus).toBe('on_leave');
    expect(res.futureShiftsNeedingDecision.map((x) => [x.id, x.status])).toEqual([[future.id, 'planned']]);
    await expect(create(s, a, at('13:00'), at('15:00'))).rejects.toMatchObject({ code: 'STAFF_ON_LEAVE' });
    const back = await tx((t) => setPlanningStatus(t, owner, s, { planningStatus: 'available' }, meta(owner), clock));
    expect(back.futureShiftsNeedingDecision).toEqual([]);
    await db.client.query(`UPDATE app.staff SET status = 'blocked' WHERE id = $1`, [s]);
    await expect(create(s, a, at('13:00'), at('15:00'))).rejects.toMatchObject({ code: 'STAFF_NOT_ACTIVE' });
    const audit = await db.client.query(`SELECT count(*)::int AS n FROM journal.audit_events WHERE action = 'staff.planning_changed' AND object_id = $1`, [s]);
    expect(audit.rows[0]!.n).toBe(2);
  });

  it('setPlanningStatus: Директор чужой зоны – 404, Администратор – 403', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    const foreign = ctx('director', randomUUID(), [await newBranch()]);
    await expect(tx((t) => setPlanningStatus(t, foreign, s, { planningStatus: 'on_leave' }, meta(foreign), clock))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const adminCtx = ctx('admin', randomUUID(), [a]);
    await expect(tx((t) => setPlanningStatus(t, adminCtx, s, { planningStatus: 'on_leave' }, meta(adminCtx), clock))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('права: Администратор чужую смену не создаёт (403), филиал вне зоны – 404', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    await expect(create(s, a, at('10:00'), at('12:00'), ctx('admin', randomUUID(), [a]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(create(s, a, at('10:00'), at('12:00'), ctx('director', randomUUID(), [await newBranch()]))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('дата в закрытом периоде – PAYROLL_PERIOD_CLOSED при создании, переносе и отмене', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    const d1 = '2027-03-10' as LocalDate;
    const d2 = '2027-04-10' as LocalDate;
    const shift = await create(s, a, at('10:00', d2), at('12:00', d2));
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2027-03-01', '2027-03-31', 'closed', now())`);
    await expect(create(s, a, at('10:00', d1), at('12:00', d1))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
    const move = { rowVersion: shift.rowVersion, start: at('10:00', d1), end: at('12:00', d1), reason: 'перенос' };
    await expect(tx((t) => updateShift(t, owner, shift.id, move, meta(owner), clock))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2027-04-01', '2027-04-30', 'closed', now())`);
    await expect(tx((t) => cancelShift(t, owner, shift.id, { rowVersion: shift.rowVersion, reason: 'x' }, meta(owner), clock))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
  });
});

describe('правка и отмена', () => {
  it('чужая правка: причина обязательна, история было/стало, событие shift.changed; своя – без истории', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    const shift = await create(s, a, at('10:00'), at('12:00'));
    await expect(tx((t) => updateShift(t, owner, shift.id, { rowVersion: 1, end: at('13:00') }, meta(owner), clock))).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    const updated = await tx((t) => updateShift(t, owner, shift.id, { rowVersion: 1, end: at('13:00'), reason: 'дольше' }, meta(owner), clock));
    expect(updated).toMatchObject({ rowVersion: 2, plannedMinutes: 180 });
    const changes = await db.client.query<{ kind: string; before: { end: string } | null; after: { end: string }; reason: string | null }>(`SELECT kind, before, after, reason FROM journal.staff_shift_changes WHERE shift_id = $1 ORDER BY id`, [shift.id]);
    expect(changes.rows.map((c) => c.kind)).toEqual(['created', 'updated']);
    expect(changes.rows[1]).toMatchObject({ reason: 'дольше', before: { end: at('12:00') }, after: { end: at('13:00') } });
    const ev = await db.client.query<{ payload: { kind: string; changedBy: string } }>(`SELECT payload FROM app.outbox_events WHERE event_type = 'shift.changed' AND aggregate_id = $1 ORDER BY occurred_at, dedupe_key`, [shift.id]);
    expect(ev.rows.map((e) => e.payload.kind).sort()).toEqual(['created', 'updated']);
    await expect(tx((t) => updateShift(t, owner, shift.id, { rowVersion: 1, end: at('14:00'), reason: 'старая версия' }, meta(owner), clock))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const adminId = await newStaff([a]);
    const self = ctx('admin', adminId, [a]);
    const own = await create(adminId, a, at('10:00'), at('12:00'), self);
    await tx((t) => updateShift(t, self, own.id, { rowVersion: 1, end: at('13:00') }, meta(self), clock));
    const none = await db.client.query(`SELECT 1 FROM journal.staff_shift_changes WHERE shift_id = $1`, [own.id]);
    expect(none.rows).toEqual([]);
  });

  it('прошедшую смену сотрудник не отменяет (SHIFT_NOT_EDITABLE); Директор – отменяет с причиной; отмена освобождает время', async () => {
    const a = await newBranch();
    const adminId = await newStaff([a]);
    const self = ctx('admin', adminId, [a]);
    const past = '2026-11-10' as LocalDate;
    const shift = await create(adminId, a, at('10:00', past), at('12:00', past));
    await expect(tx((t) => cancelShift(t, self, shift.id, { rowVersion: 1, reason: 'забыл' }, meta(self), clock))).rejects.toMatchObject({ code: 'SHIFT_NOT_EDITABLE' });
    const director = ctx('director', randomUUID(), [a]);
    await expect(tx((t) => cancelShift(t, director, shift.id, { rowVersion: 1 }, meta(director), clock))).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    const cancelled = await tx((t) => cancelShift(t, director, shift.id, { rowVersion: 1, reason: 'ошибка' }, meta(director), clock));
    expect(cancelled.status).toBe('cancelled');
    expect((await create(adminId, a, at('10:00', past), at('12:00', past))).status).toBe('planned');
    await expect(tx((t) => cancelShift(t, director, shift.id, { rowVersion: 2, reason: 'ещё раз' }, meta(director), clock))).rejects.toMatchObject({ code: 'SHIFT_NOT_EDITABLE' });
    expect((await db.client.query(`SELECT count(*)::int AS n FROM app.staff_shifts WHERE id = $1`, [shift.id])).rows[0].n).toBe(1); // строка осталась
  });

  it('своя будущая смена отменяется, но не позже срока', async () => {
    const a = await newBranch();
    const adminId = await newStaff([a]);
    const self = ctx('admin', adminId, [a]);
    const shift = await create(adminId, a, at('10:00'), at('12:00'), self);
    const c = await tx((t) => cancelShift(t, self, shift.id, { rowVersion: 1, reason: 'заболел' }, meta(self), clock));
    expect(c.status).toBe('cancelled');
    const soon = new Date(new Date(NOW).getTime() + 3_600_000);
    const near = await create(adminId, a, soon.toISOString(), new Date(soon.getTime() + 3_600_000).toISOString());
    await expect(tx((t) => cancelShift(t, self, near.id, { rowVersion: 1, reason: 'заболел' }, meta(self), clock))).rejects.toMatchObject({ code: 'SHIFT_EDIT_DEADLINE' });
  });

  it('своя смена ближе срока не переносится на дальнюю дату: срок проверяется и по старому началу (K18 §4 п.7)', async () => {
    const a = await newBranch();
    const adminId = await newStaff([a]);
    const self = ctx('admin', adminId, [a]);
    const soon = new Date(new Date(NOW).getTime() + 3_600_000);
    const near = await create(adminId, a, soon.toISOString(), new Date(soon.getTime() + 3_600_000).toISOString());
    await expect(tx((t) => updateShift(t, self, near.id, { rowVersion: 1, start: at('10:00'), end: at('12:00') }, meta(self), clock))).rejects.toMatchObject({ code: 'SHIFT_EDIT_DEADLINE' });
    const far = await create(adminId, a, at('14:00'), at('16:00'));
    const moved = await tx((t) => updateShift(t, self, far.id, { rowVersion: 1, start: at('15:00') }, meta(self), clock));
    expect(moved.plannedMinutes).toBe(60);
  });

  it('переход времени: смена в сутках 25 ч – минуты по факту, сутки по зоне филиала; граница полуночи в новом смещении', async () => {
    const berlin = 'Europe/Berlin' as TimeZone;
    const { id: b } = await createTestBranch(db.client, { timezone: berlin });
    await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:59', '2026-01-01', $2 FROM generate_series(1, 7) d`, [b, randomUUID()]);
    const s = await newStaff([b]);
    const dstDay = '2027-10-31' as LocalDate; // в 03:00 часы переводят на 02:00
    const start = localToInstant(dstDay, '01:00' as LocalTime, berlin).toISOString();
    const end = localToInstant(dstDay, '04:00' as LocalTime, berlin).toISOString();
    const shift = await create(s, b, start, end);
    expect(shift).toMatchObject({ localDate: dstDay, plannedMinutes: 240 }); // четыре часа, а не три
    const late = localToInstant(dstDay, '22:00' as LocalTime, berlin).toISOString();
    const lateEnd = localToInstant(dstDay, '23:30' as LocalTime, berlin).toISOString();
    expect((await create(s, b, late, lateEnd)).localDate).toBe(dstDay);
    await expect(create(s, b, localToInstant(dstDay, '23:40' as LocalTime, berlin).toISOString(), localToInstant('2027-11-01' as LocalDate, '00:30' as LocalTime, berlin).toISOString())).rejects.toMatchObject({ code: 'INVALID_DURATION' });
  });

  it('смена с фактом: Администратор не правит, Директор правит – новая fact_version и событие начисления', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    const shift = await create(s, a, at('10:00'), at('12:00'));
    await db.client.query(`UPDATE app.staff_shifts SET status = 'worked', paid_minutes = 120, fact_version = 1 WHERE id = $1`, [shift.id]);
    const adminCtx = ctx('admin', s, [a]);
    await expect(tx((t) => updateShift(t, adminCtx, shift.id, { rowVersion: 1, end: at('13:00') }, meta(adminCtx), clock))).rejects.toMatchObject({ code: 'SHIFT_NOT_EDITABLE' });
    await tx((t) => updateShift(t, owner, shift.id, { rowVersion: 1, end: at('13:00'), reason: 'поправка' }, meta(owner), clock));
    const ev = await db.client.query<{ payload: { factVersion: number } }>(`SELECT payload FROM app.outbox_events WHERE event_type = 'shift.attendance_changed' AND aggregate_id = $1`, [shift.id]);
    expect(ev.rows.map((e) => e.payload.factVersion)).toEqual([2]);
  });

  it('DTO: прогноз по ставке на дату; ставки нет – null и rateMissing, не 0', async () => {
    const a = await newBranch();
    const s = await newStaff([a]);
    const shift = await create(s, a, at('10:00'), at('12:00'));
    expect(shift.plannedAccrualKop).toBeNull();
    expect(shift.flags.rateMissing).toBe(true);
    await tx((t) => setRate(t, owner, { staffId: s, validFrom: '2026-01-01', hourlyKop: 30_000, attendanceFeeKop: 10_000, reason: 'старт' }, meta(owner), clock));
    const again = await getShift(pool, shift.id, clock);
    expect(again?.plannedAccrualKop).toBe(70_000);
    expect(again?.factAccrualKop).toBeNull();
    expect(again?.flags.rateMissing).toBe(false);
  });
});
