// S3-11. Планирование смен (K18 §2, §4, 05 §5): createShift, updateShift, cancelShift, setPlanningStatus.
// Порядок блокировок (K18 §6): FOR SHARE строк периодов (все затронутые даты) → строка сотрудника FOR NO KEY UPDATE →
// строка смены FOR UPDATE. Строка сотрудника ставит команды одного человека в очередь: иначе две незавершённые вставки
// ждут друг друга внутри EXCLUDE (40P01, как K6). Гарантия пересечений – база (staff_shifts_no_overlap), предварительный
// SELECT – только ради details. Чужая правка: строка staff_shift_changes и shift.changed (K18 §4, §11).
// Смена с фактом при переносе и отмене получает новую fact_version и shift.attendance_changed: начисление поедет за ней.
// Транзакцию открывает вызывающий; ошибка 23P01 оставляет её aborted – вызывающий откатывает.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { publish } from '../../core/outbox.ts';
import { assertCan, can, type AccessContext } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import { branchDay, contains, fromPgRange, instantToLocal, systemClock, toPgRange, type Clock, type Interval, type LocalDate } from '../../core/time.ts';
import { getBranch, openIntervals, type BranchInfo } from '../network/index.ts';
import { accrualParts, isUuid, lockPeriodsShared, notFound, requireReason, type PeriodLock } from './rates.ts';

export type ShiftStatus = 'planned' | 'worked' | 'no_show' | 'cancelled' | 'needs_review';

export interface ShiftDto {
  id: string;
  staffId: string;
  branchId: string;
  timezone: string;
  localDate: LocalDate;
  plannedStart: string;
  plannedEnd: string;
  plannedMinutes: number;
  status: ShiftStatus;
  factStart: string | null;
  factEnd: string | null;
  paidMinutes: number | null;
  paidMinutesSource: 'fact_time' | 'manual' | null;
  flags: { rateMissing: boolean; unpaidConfirmed: boolean; outsideHours: boolean; reviewReason: string | null };
  plannedAccrualKop: number | null;
  factAccrualKop: number | null;
  factVersion: number;
  comment: string | null;
  createdBy: string;
  rowVersion: number;
}

export interface ShiftRow {
  id: string;
  staff_id: string;
  branch_id: string;
  timezone: string;
  local_date: string;
  period: string;
  status: ShiftStatus;
  fact_start: Date | null;
  fact_end: Date | null;
  paid_minutes: number | null;
  paid_minutes_source: 'fact_time' | 'manual' | null;
  fact_version: number;
  outside_hours: boolean;
  unpaid_confirmed: boolean;
  review_reason: string | null;
  comment: string | null;
  created_by: string;
  row_version: number;
}

const COLS = `s.id, s.staff_id, s.branch_id, b.timezone, to_char(s.local_date, 'YYYY-MM-DD') AS local_date, s.period::text AS period, s.status,
  s.fact_start, s.fact_end, s.paid_minutes, s.paid_minutes_source, s.fact_version, s.outside_hours, s.unpaid_confirmed, s.review_reason, s.comment,
  s.created_by, s.row_version`;
export const SHIFT_SELECT = `SELECT ${COLS} FROM app.staff_shifts s JOIN app.branches b ON b.id = s.branch_id`;

function rowInterval(r: ShiftRow): Interval {
  return fromPgRange(r.period);
}

/** Строки → DTO одним набором запросов: ставка на дату каждой смены, порог ставки за выход, проведённая сумма K3. Null ≠ 0. */
export async function shiftDtos(db: Db, rows: ShiftRow[], clock: Clock = systemClock): Promise<ShiftDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const rates = await db.query<{ id: string; hourly_kop: string; attendance_fee_kop: string }>(
    `SELECT s.id, r.hourly_kop, r.attendance_fee_kop FROM app.staff_shifts s
       CROSS JOIN LATERAL (SELECT hourly_kop, attendance_fee_kop FROM journal.staff_rates x WHERE x.staff_id = s.staff_id AND x.valid_from <= s.local_date
                           ORDER BY x.valid_from DESC, x.created_at DESC, x.id DESC LIMIT 1) r
      WHERE s.id = ANY($1::uuid[])`,
    [ids],
  );
  const facts = await db.query<{ ref_id: string; sum: string }>(
    `SELECT le.ref_id, sum(le.amount) AS sum FROM journal.ledger_entries le JOIN app.ledger_accounts a ON a.id = le.account_id
      WHERE a.kind = 'staff_payroll' AND le.ref_type = 'shift' AND le.ref_id = ANY($1::uuid[]) GROUP BY le.ref_id`,
    [ids],
  );
  const settings = await resolveSettings(db, ['payroll.attendance_fee_min_minutes'], { network: true }, clock.now());
  const feeMin = settings['payroll.attendance_fee_min_minutes'].value;
  const rateOf = new Map(rates.rows.map((r) => [r.id, { hourlyKop: Number(r.hourly_kop), attendanceFeeKop: Number(r.attendance_fee_kop) }]));
  const factOf = new Map(facts.rows.map((f) => [f.ref_id, Number(f.sum)]));
  return rows.map((r) => {
    const period = rowInterval(r);
    const plannedMinutes = Math.round((period.end.getTime() - period.start.getTime()) / 60_000);
    const rate = rateOf.get(r.id);
    const live = r.status !== 'cancelled' && r.status !== 'no_show';
    return {
      id: r.id,
      staffId: r.staff_id,
      branchId: r.branch_id,
      timezone: r.timezone,
      localDate: r.local_date as LocalDate,
      plannedStart: period.start.toISOString(),
      plannedEnd: period.end.toISOString(),
      plannedMinutes,
      status: r.status,
      factStart: r.fact_start?.toISOString() ?? null,
      factEnd: r.fact_end?.toISOString() ?? null,
      paidMinutes: r.paid_minutes,
      paidMinutesSource: r.paid_minutes_source,
      flags: { rateMissing: live && !r.unpaid_confirmed && !rate, unpaidConfirmed: r.unpaid_confirmed, outsideHours: r.outside_hours, reviewReason: r.review_reason },
      plannedAccrualKop: rate ? accrualParts(plannedMinutes, rate, feeMin).totalKop : null,
      factAccrualKop: r.status === 'worked' ? (factOf.get(r.id) ?? null) : null,
      factVersion: r.fact_version,
      comment: r.comment,
      createdBy: r.created_by,
      rowVersion: r.row_version,
    };
  });
}

/** Прогноз плановой смены – только на лету, в журнал не пишется (K18 §6). */
export async function getShift(db: Db, id: string, clock: Clock = systemClock): Promise<ShiftDto | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<ShiftRow>(`${SHIFT_SELECT} WHERE s.id = $1`, [id]);
  return r.rows[0] ? (await shiftDtos(db, [r.rows[0]], clock))[0]! : null;
}

// ---- общие проверки

const INVALID = (issues: z.ZodError) => new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: issues.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
const Iso = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const createSchema = z.object({ staffId: z.string().regex(/^[0-9a-f-]{36}$/i), branchId: z.string().regex(/^[0-9a-f-]{36}$/i), start: Iso, end: Iso, comment: z.string().max(2000).nullish() });
const updateSchema = z.object({ rowVersion: z.number().int(), start: Iso.optional(), end: Iso.optional(), branchId: z.string().regex(/^[0-9a-f-]{36}$/i).optional(), reason: z.string().max(2000).nullish() });
const cancelSchema = z.object({ rowVersion: z.number().int(), reason: z.string().max(2000).nullish() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw INVALID(r.error);
  return r.data;
}

/** Своя смена – shift.plan.own, чужая – shift.manage; филиал вне зоны – 404, без права – 403. */
function guardPlan(ctx: AccessContext, staffId: string, branchId: string): void {
  assertCan(ctx, staffId === ctx.actor.staffId ? 'shift.plan.own' : 'shift.manage', { branchId });
}

async function lockStaff(tx: Tx, staffId: string): Promise<{ status: string; planning_status: string; role: string }> {
  const r = await tx.query<{ status: string; planning_status: string; role: string }>(`SELECT status, planning_status, role FROM app.staff WHERE id = $1 FOR NO KEY UPDATE`, [staffId]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

async function isAssigned(db: Db, staffId: string, branch: BranchInfo, date: LocalDate): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM app.staff_assignments
      WHERE staff_id = $1 AND revoked_at IS NULL AND valid_from <= $4::date AND (valid_to IS NULL OR valid_to >= $4::date)
        AND (scope_type = 'network' OR (scope_type = 'branch' AND branch_id = $2) OR (scope_type = 'city' AND city_id = $3)) LIMIT 1`,
    [staffId, branch.id, branch.cityId, date],
  );
  return r.rows.length > 0;
}

/** Проверки K18 §4 №1–№6 и №8, в порядке таблицы. Блокировки уже взяты. Возвращает пометку outside_hours. */
async function assertSlot(
  tx: Tx,
  ctx: AccessContext,
  v: { staffId: string; staff: { status: string; planning_status: string; role: string }; branch: BranchInfo; period: Interval; date: LocalDate; selfShiftId: string | null; periods: PeriodLock[]; clock: Clock },
): Promise<boolean> {
  if (v.staff.status !== 'active') throw new AppError('STAFF_NOT_ACTIVE', 409, 'Сотрудник заблокирован или в архиве');
  if (v.staff.planning_status === 'on_leave') throw new AppError('STAFF_ON_LEAVE', 409, 'Сотрудник временно не работает');
  if (v.staff.role !== 'owner' && !(await isAssigned(tx, v.staffId, v.branch, v.date))) {
    throw new AppError('STAFF_NOT_ASSIGNED', 422, 'Сотрудник не назначен на этот филиал на эту дату');
  }
  if (!contains(branchDay(v.date, v.branch.timezone), v.period)) throw new AppError('INVALID_DURATION', 422, 'Смена не переходит через полночь');
  const minutes = (v.period.end.getTime() - v.period.start.getTime()) / 60_000;
  const s = await resolveSettings(tx, ['shift.min_minutes', 'shift.self_edit_deadline_hours'], { network: true }, v.clock.now());
  const min = s['shift.min_minutes'].value;
  if (min !== null && minutes < min) throw new AppError('SHIFT_TOO_SHORT', 422, 'Смена короче минимальной', { minMinutes: min });
  const open = await openIntervals(tx, { branchId: v.branch.id, date: v.date });
  const inside = open.some((i) => contains(i, v.period));
  if (!inside && !can(ctx, 'shift.outside_hours', { branchId: v.branch.id })) throw new AppError('OUTSIDE_SCHEDULE', 409, 'Вне графика филиала нужно отдельное разрешение', { open });
  const conflict = await tx.query<{ id: string; branch_id: string }>(
    `SELECT id, branch_id FROM app.staff_shifts WHERE staff_id = $1 AND status IN ('planned','worked','needs_review') AND period && $2::tstzrange AND ($3::uuid IS NULL OR id <> $3) LIMIT 1`,
    [v.staffId, toPgRange(v.period), v.selfShiftId],
  );
  if (conflict.rows[0]) {
    const details: Record<string, unknown> = { conflictShiftId: conflict.rows[0].id };
    if (can(ctx, 'shift.view', { branchId: conflict.rows[0].branch_id })) details.branchId = conflict.rows[0].branch_id;
    throw new AppError('SHIFT_OVERLAP', 409, 'Смена пересекается с другой сменой сотрудника', details);
  }
  if (v.staffId === ctx.actor.staffId) assertSelfDeadline(v.period.start, s['shift.self_edit_deadline_hours'].value, v.clock);
  const closed = v.periods.find((p) => p.status === 'closed');
  if (closed) throw new AppError('PAYROLL_PERIOD_CLOSED', 409, 'Расчётный период закрыт', { periodId: closed.id });
  return !inside;
}

function assertSelfDeadline(start: Date, hours: number, clock: Clock): void {
  if (start.getTime() < clock.now().getTime() + hours * 3_600_000) throw new AppError('SHIFT_EDIT_DEADLINE', 409, 'Изменить свою смену можно не позже срока', { deadlineHours: hours });
}

function period(start: Date, end: Date): Interval {
  if (start.getTime() >= end.getTime()) throw new AppError('INVALID_DURATION', 422, 'Начало смены должно быть раньше конца');
  return { start, end };
}

function mapOverlap(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23P01' && e.constraint === 'staff_shifts_no_overlap') return new AppError('SHIFT_OVERLAP', 409, 'Смена пересекается с другой сменой сотрудника');
  return err;
}

const slot = (i: Interval, branchId: string) => ({ start: i.start.toISOString(), end: i.end.toISOString(), branchId });

async function recordForeign(
  tx: Tx,
  ctx: AccessContext,
  v: { shiftId: string; staffId: string; branch: BranchInfo; rowVersion: number; kind: 'created' | 'updated' | 'cancelled'; before: ReturnType<typeof slot> | null; after: ReturnType<typeof slot> | null; reason: string | null; now: Date },
): Promise<void> {
  if (v.staffId === ctx.actor.staffId) return;
  await tx.query(`INSERT INTO journal.staff_shift_changes (shift_id, changed_by, changed_at, kind, before, after, reason) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`, [
    v.shiftId,
    ctx.actor.staffId,
    v.now,
    v.kind,
    v.before && JSON.stringify(v.before),
    v.after && JSON.stringify(v.after),
    v.reason,
  ]);
  await publish(tx, {
    type: 'shift.changed',
    aggregateType: 'shift',
    aggregateId: v.shiftId,
    aggregateVersion: v.rowVersion,
    branchId: v.branch.id,
    payload: { shiftId: v.shiftId, staffId: v.staffId, branchId: v.branch.id, branchTimezone: v.branch.timezone, changedBy: ctx.actor.staffId, kind: v.kind, before: v.before, after: v.after, reason: v.reason },
    occurredAt: v.now,
  });
}

/** Факт смены изменился косвенно (перенос или отмена): новая версия и событие для начисления. */
async function bumpFact(tx: Tx, row: ShiftRow, now: Date): Promise<void> {
  const r = await tx.query<{ fact_version: number; local_date: string; branch_id: string }>(
    `UPDATE app.staff_shifts SET fact_version = fact_version + 1 WHERE id = $1 RETURNING fact_version, to_char(local_date, 'YYYY-MM-DD') AS local_date, branch_id`,
    [row.id],
  );
  const u = r.rows[0]!;
  await publish(tx, {
    type: 'shift.attendance_changed',
    aggregateType: 'shift',
    aggregateId: row.id,
    aggregateVersion: u.fact_version,
    branchId: u.branch_id,
    payload: { shiftId: row.id, staffId: row.staff_id, branchId: u.branch_id, localDate: u.local_date, factVersion: u.fact_version },
    occurredAt: now,
  });
}

// ---- команды

export async function createShift(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ShiftDto> {
  const input = parse(createSchema, raw);
  const branch = await getBranch(tx, input.branchId);
  if (!branch) throw notFound();
  guardPlan(ctx, input.staffId, branch.id);
  const p = period(input.start, input.end);
  const date = instantToLocal(p.start, branch.timezone).date;
  const periods = await lockPeriodsShared(tx, [date]);
  const staff = await lockStaff(tx, input.staffId);
  const outside = await assertSlot(tx, ctx, { staffId: input.staffId, staff, branch, period: p, date, selfShiftId: null, periods, clock });
  const now = clock.now();
  const comment = input.comment?.trim() || null;
  let id: string;
  try {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.staff_shifts (staff_id, branch_id, local_date, period, outside_hours, comment, created_by, created_at)
       VALUES ($1, $2, $3::date, $4::tstzrange, $5, $6, $7, $8) RETURNING id`,
      [input.staffId, branch.id, date, toPgRange(p), outside, comment, ctx.actor.staffId, now],
    );
    id = r.rows[0]!.id;
  } catch (err) {
    throw mapOverlap(err);
  }
  await recordForeign(tx, ctx, { shiftId: id, staffId: input.staffId, branch, rowVersion: 1, kind: 'created', before: null, after: slot(p, branch.id), reason: comment, now });
  await writeAudit(tx, meta, { action: 'shift.created', object: { type: 'shift', id }, branchId: branch.id, cityId: branch.cityId, after: { staffId: input.staffId, ...slot(p, branch.id), outsideHours: outside, comment } }, clock);
  return (await getShift(tx, id, clock))!;
}

export async function updateShift(tx: Tx, ctx: AccessContext, shiftId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ShiftDto> {
  const input = parse(updateSchema, raw);
  const seen = await readShift(tx, shiftId);
  guardPlan(ctx, seen.staff_id, seen.branch_id);
  const self = seen.staff_id === ctx.actor.staffId;
  const reason = self ? input.reason?.trim() || null : requireReason(input.reason);
  const targetBranch = await getBranch(tx, input.branchId ?? seen.branch_id);
  if (!targetBranch) throw notFound();
  guardPlan(ctx, seen.staff_id, targetBranch.id);
  const old = rowInterval(seen);
  const next = period(input.start ?? old.start, input.end ?? old.end);
  const date = instantToLocal(next.start, targetBranch.timezone).date;

  const periods = await lockPeriodsShared(tx, [seen.local_date as LocalDate, date]);
  const staff = await lockStaff(tx, seen.staff_id);
  const row = await lockShift(tx, shiftId, input.rowVersion);
  assertEditable(ctx, row, old, clock);
  // K18 §4 п.7: срок своей правки – и по старому началу, иначе близкую смену можно «унести» переносом на дальнюю дату.
  if (row.staff_id === ctx.actor.staffId) {
    const deadline = await resolveSettings(tx, ['shift.self_edit_deadline_hours'], { network: true }, clock.now());
    assertSelfDeadline(old.start, deadline['shift.self_edit_deadline_hours'].value, clock);
  }
  const outside = await assertSlot(tx, ctx, { staffId: row.staff_id, staff, branch: targetBranch, period: next, date, selfShiftId: row.id, periods, clock });
  const now = clock.now();
  try {
    await tx.query(`UPDATE app.staff_shifts SET branch_id = $2, local_date = $3::date, period = $4::tstzrange, outside_hours = $5, row_version = row_version + 1 WHERE id = $1`, [
      row.id,
      targetBranch.id,
      date,
      toPgRange(next),
      outside,
    ]);
  } catch (err) {
    throw mapOverlap(err);
  }
  if (row.status === 'worked') await bumpFact(tx, row, now);
  const before = slot(old, row.branch_id);
  const after = slot(next, targetBranch.id);
  await recordForeign(tx, ctx, { shiftId: row.id, staffId: row.staff_id, branch: targetBranch, rowVersion: row.row_version + 1, kind: 'updated', before, after, reason, now });
  await writeAudit(tx, meta, { action: 'shift.updated', object: { type: 'shift', id: row.id }, branchId: targetBranch.id, cityId: targetBranch.cityId, before, after, reason }, clock);
  return (await getShift(tx, row.id, clock))!;
}

export async function cancelShift(tx: Tx, ctx: AccessContext, shiftId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ShiftDto> {
  const input = parse(cancelSchema, raw);
  const seen = await readShift(tx, shiftId);
  guardPlan(ctx, seen.staff_id, seen.branch_id);
  const reason = requireReason(input.reason);
  const periods = await lockPeriodsShared(tx, [seen.local_date as LocalDate]);
  await lockStaff(tx, seen.staff_id);
  const row = await lockShift(tx, shiftId, input.rowVersion);
  const old = rowInterval(row);
  assertEditable(ctx, row, old, clock);
  if (row.staff_id === ctx.actor.staffId) {
    const s = await resolveSettings(tx, ['shift.self_edit_deadline_hours'], { network: true }, clock.now());
    assertSelfDeadline(old.start, s['shift.self_edit_deadline_hours'].value, clock);
  }
  const closed = periods.find((p) => p.status === 'closed');
  if (closed) throw new AppError('PAYROLL_PERIOD_CLOSED', 409, 'Расчётный период закрыт', { periodId: closed.id });
  const now = clock.now();
  await tx.query(`UPDATE app.staff_shifts SET status = 'cancelled', row_version = row_version + 1 WHERE id = $1`, [row.id]);
  if (row.fact_version > 0 || row.status === 'worked') await bumpFact(tx, row, now);
  const branch = await getBranch(tx, row.branch_id);
  const before = slot(old, row.branch_id);
  await recordForeign(tx, ctx, { shiftId: row.id, staffId: row.staff_id, branch: branch!, rowVersion: row.row_version + 1, kind: 'cancelled', before, after: null, reason, now });
  await writeAudit(tx, meta, { action: 'shift.cancelled', object: { type: 'shift', id: row.id }, branchId: row.branch_id, cityId: branch!.cityId, before: { ...before, status: row.status }, reason }, clock);
  return (await getShift(tx, row.id, clock))!;
}

async function readShift(db: Db, id: string): Promise<ShiftRow> {
  if (!isUuid(id)) throw notFound();
  const r = await db.query<ShiftRow>(`${SHIFT_SELECT} WHERE s.id = $1`, [id]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

async function lockShift(tx: Tx, id: string, rowVersion: number): Promise<ShiftRow> {
  const r = await tx.query<ShiftRow>(`${SHIFT_SELECT} WHERE s.id = $1 FOR UPDATE OF s`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound();
  if (row.row_version !== rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Смену уже изменили, обновите данные', { rowVersion: row.row_version });
  return row;
}

/** Отменённая и с невыходом через план не правятся; с фактом – только с shift.attendance.correct; прошедшую свою сотрудник не трогает (05 §5.6). */
function assertEditable(ctx: AccessContext, row: ShiftRow, p: Interval, clock: Clock): void {
  const notEditable = (why: string) => new AppError('SHIFT_NOT_EDITABLE', 409, why, { status: row.status });
  if (row.status === 'cancelled') throw notEditable('Смена отменена');
  if ((row.status === 'worked' || row.status === 'no_show') && !can(ctx, 'shift.attendance.correct', { branchId: row.branch_id })) throw notEditable('Смену с фактом исправляет руководитель');
  if (row.staff_id === ctx.actor.staffId && p.start.getTime() <= clock.now().getTime() && !can(ctx, 'shift.attendance.correct', { branchId: row.branch_id })) {
    throw notEditable('Прошедшую смену исправляет руководитель');
  }
}

/** «Временно не работает» (K18 §2): вход не трогает; будущие смены не отменяются, а показываются как требующие решения (Q-119). */
export async function setPlanningStatus(
  tx: Tx,
  ctx: AccessContext,
  staffId: string,
  raw: { planningStatus?: unknown },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ planningStatus: 'available' | 'on_leave'; futureShiftsNeedingDecision: ShiftDto[] }> {
  if (!isUuid(staffId)) throw notFound();
  const status = raw.planningStatus;
  if (status !== 'available' && status !== 'on_leave') throw new AppError('VALIDATION_FAILED', 400, 'planningStatus – available или on_leave', { field: 'planningStatus' });
  const target = await staffTargets(tx, staffId);
  if (!target) throw notFound();
  if (!ctx.network) {
    const inZone = target.branchIds.filter((b) => ctx.branchIds.has(b));
    if (inZone.length === 0) throw notFound();
    assertCan(ctx, 'staff.planning_status', { branchId: inZone[0]! });
  } else {
    assertCan(ctx, 'staff.planning_status', { network: true });
  }
  const before = await tx.query<{ planning_status: string }>(`SELECT planning_status FROM app.staff WHERE id = $1 FOR NO KEY UPDATE`, [staffId]);
  const prev = before.rows[0]!.planning_status;
  const now = clock.now();
  if (prev !== status) {
    await tx.query(`UPDATE app.staff SET planning_status = $2, row_version = row_version + 1 WHERE id = $1`, [staffId, status]);
    await writeAudit(tx, meta, { action: 'staff.planning_changed', object: { type: 'staff', id: staffId }, before: { planningStatus: prev }, after: { planningStatus: status } }, clock);
  }
  const future = status === 'on_leave'
    ? await tx.query<ShiftRow>(`${SHIFT_SELECT} WHERE s.staff_id = $1 AND s.status = 'planned' AND lower(s.period) > $2 ORDER BY lower(s.period)`, [staffId, now])
    : { rows: [] as ShiftRow[] };
  return { planningStatus: status, futureShiftsNeedingDecision: await shiftDtos(tx, future.rows, clock) };
}

/** Действующие филиалы сотрудника (назначения branch и city). */
export async function staffTargets(db: Db, staffId: string): Promise<{ branchIds: string[] } | null> {
  const s = await db.query('SELECT 1 FROM app.staff WHERE id = $1', [staffId]);
  if (s.rows.length === 0) return null;
  const r = await db.query<{ branch_id: string }>(
    `SELECT DISTINCT b.id AS branch_id FROM app.staff_assignments a JOIN app.branches b ON (a.scope_type = 'branch' AND b.id = a.branch_id) OR (a.scope_type = 'city' AND b.city_id = a.city_id)
      WHERE a.staff_id = $1 AND a.revoked_at IS NULL`,
    [staffId],
  );
  return { branchIds: r.rows.map((x) => x.branch_id) };
}
