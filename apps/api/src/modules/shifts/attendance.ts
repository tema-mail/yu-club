// S3-13. Факт выхода (K18 §5, 05 §7): checkIn и checkOut – сам сотрудник; setAttendance – руководитель с причиной.
// Плановая смена не становится фактом сама: задача shifts.review только ставит needs_review. Каждое изменение факта
// увеличивает fact_version и публикует shift.attendance_changed – по нему проводится начисление (accrual.ts, §6).
// Порядок блокировок (K18 §6): FOR SHARE периода → строка сотрудника (где статус входит в EXCLUDE) → строка смены.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { publish } from '../../core/outbox.ts';
import { assertCan, can, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { fromPgRange, systemClock, type Clock, type LocalDate } from '../../core/time.ts';
import { getShift, SHIFT_SELECT, type ShiftDto, type ShiftRow } from './plan.ts';
import { assertDatesOpen, isUuid, lockPeriodsShared, notFound, requireReason } from './rates.ts';

const Iso = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const Reason = z.string().max(2000).nullish();
const attendanceSchema = z.union([
  z.strictObject({ rowVersion: z.number().int(), status: z.literal('worked'), factStart: Iso, factEnd: Iso, reason: Reason }),
  z.strictObject({ rowVersion: z.number().int(), status: z.literal('worked'), paidMinutes: z.number().int().min(0).max(1440), reason: Reason }),
  z.strictObject({ rowVersion: z.number().int(), status: z.literal('no_show'), reason: Reason }),
  z.strictObject({ rowVersion: z.number().int(), unpaidConfirmed: z.literal(true), reason: Reason }),
]);

export type AttendanceInput = z.input<typeof attendanceSchema>;

async function readShift(db: Db, id: string): Promise<ShiftRow> {
  if (!isUuid(id)) throw notFound();
  const r = await db.query<ShiftRow>(`${SHIFT_SELECT} WHERE s.id = $1`, [id]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

async function lockRow(tx: Tx, id: string): Promise<ShiftRow> {
  const r = await tx.query<ShiftRow>(`${SHIFT_SELECT} WHERE s.id = $1 FOR UPDATE OF s`, [id]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

/** Запись нового факта: fact_version + 1, событие, аудит. set – столбцы и значения, начиная с $2. */
async function applyFact(
  tx: Tx,
  row: ShiftRow,
  set: { status: ShiftRow['status']; factStart: Date | null; factEnd: Date | null; paidMinutes: number | null; source: ShiftRow['paid_minutes_source']; unpaid: boolean },
  reason: string | null,
  meta: AuditRequestMeta,
  clock: Clock,
): Promise<void> {
  const now = clock.now();
  let factVersion: number;
  try {
    const r = await tx.query<{ fact_version: number }>(
      `UPDATE app.staff_shifts SET status = $2, fact_start = $3, fact_end = $4, paid_minutes = $5, paid_minutes_source = $6, unpaid_confirmed = $7,
              review_reason = NULL, fact_version = fact_version + 1, row_version = row_version + 1
        WHERE id = $1 RETURNING fact_version`,
      [row.id, set.status, set.factStart, set.factEnd, set.paidMinutes, set.source, set.unpaid],
    );
    factVersion = r.rows[0]!.fact_version;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23P01' && e.constraint === 'staff_shifts_no_overlap') throw new AppError('SHIFT_OVERLAP', 409, 'Смена пересекается с другой сменой сотрудника');
    throw err;
  }
  await publish(tx, {
    type: 'shift.attendance_changed',
    aggregateType: 'shift',
    aggregateId: row.id,
    aggregateVersion: factVersion,
    branchId: row.branch_id,
    payload: { shiftId: row.id, staffId: row.staff_id, branchId: row.branch_id, localDate: row.local_date, factVersion },
    occurredAt: now,
  });
  await writeAudit(
    tx,
    meta,
    {
      action: 'shift.attendance_set',
      object: { type: 'shift', id: row.id },
      branchId: row.branch_id,
      before: { status: row.status, factStart: row.fact_start, factEnd: row.fact_end, paidMinutes: row.paid_minutes, unpaidConfirmed: row.unpaid_confirmed },
      after: { status: set.status, factStart: set.factStart, factEnd: set.factEnd, paidMinutes: set.paidMinutes, paidMinutesSource: set.source, unpaidConfirmed: set.unpaid, factVersion },
      reason,
    },
    clock,
  );
}

/** Отметка за другого – FORBIDDEN в своей зоне, 404 вне её (K18 §5, Q-110). */
function assertOwn(ctx: AccessContext, row: ShiftRow): void {
  if (row.staff_id === ctx.actor.staffId) return;
  if (!can(ctx, 'shift.view', { branchId: row.branch_id })) throw notFound();
  throw new AppError('FORBIDDEN', 403, 'Отметить приход и уход может только сам сотрудник', { action: 'shift.attendance.self' });
}

/** Приход: не раньше shift.checkin_early_minutes до начала и не позже конца смены; повтор – без изменений. */
export async function checkIn(tx: Tx, ctx: AccessContext, shiftId: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ShiftDto> {
  const seen = await readShift(tx, shiftId);
  assertOwn(ctx, seen);
  await assertDatesOpen(tx, [seen.local_date as LocalDate]);
  const row = await lockRow(tx, seen.id);
  if (row.status !== 'planned') throw new AppError('SHIFT_NOT_EDITABLE', 409, 'Смена уже не плановая: отметку исправляет руководитель', { status: row.status });
  if (row.fact_start) return (await getShift(tx, row.id, clock))!;
  const period = fromPgRange(row.period);
  const now = clock.now();
  const early = (await resolveSetting(tx, 'shift.checkin_early_minutes', { network: true }, now)).value;
  if (now.getTime() < period.start.getTime() - early * 60_000 || now.getTime() >= period.end.getTime()) {
    throw new AppError('CHECKIN_WINDOW', 409, 'Приход отмечается перед началом смены и до её конца', { earlyMinutes: early });
  }
  await applyFact(tx, row, { status: 'planned', factStart: now, factEnd: null, paidMinutes: null, source: null, unpaid: row.unpaid_confirmed }, null, meta, clock);
  return (await getShift(tx, row.id, clock))!;
}

/** Уход: смена становится worked, оплачиваемые минуты = факт, целых минут (Q-61), плановым интервалом не обрезаются. */
export async function checkOut(tx: Tx, ctx: AccessContext, shiftId: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ShiftDto> {
  const seen = await readShift(tx, shiftId);
  assertOwn(ctx, seen);
  await assertDatesOpen(tx, [seen.local_date as LocalDate]);
  await tx.query('SELECT 1 FROM app.staff WHERE id = $1 FOR NO KEY UPDATE', [seen.staff_id]); // как setAttendance: команды одного сотрудника – по очереди
  const row = await lockRow(tx, seen.id);
  if (row.status === 'worked' && row.fact_end) return (await getShift(tx, row.id, clock))!; // двойное нажатие
  if (row.status !== 'planned') throw new AppError('SHIFT_NOT_EDITABLE', 409, 'Смена уже не плановая: отметку исправляет руководитель', { status: row.status });
  if (!row.fact_start) throw new AppError('CHECKIN_WINDOW', 409, 'Сначала отметьте приход');
  const now = clock.now();
  const paidMinutes = Math.max(0, Math.floor((now.getTime() - row.fact_start.getTime()) / 60_000));
  await applyFact(tx, row, { status: 'worked', factStart: row.fact_start, factEnd: now, paidMinutes, source: 'fact_time', unpaid: row.unpaid_confirmed }, null, meta, clock);
  return (await getShift(tx, row.id, clock))!;
}

/** Исправление факта с причиной: время, ручные минуты, невыход, «не оплачивается». Отметка worked снимает «не оплачивается». */
export async function setAttendance(tx: Tx, ctx: AccessContext, shiftId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ShiftDto> {
  const parsed = attendanceSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const input = parsed.data;
  const seen = await readShift(tx, shiftId);
  assertCan(ctx, 'shift.attendance.correct', { branchId: seen.branch_id });
  const reason = requireReason(input.reason);

  const periods = await lockPeriodsShared(tx, [seen.local_date as LocalDate]);
  await tx.query('SELECT 1 FROM app.staff WHERE id = $1 FOR NO KEY UPDATE', [seen.staff_id]);
  const row = await lockRow(tx, seen.id);
  const closed = periods.find((p) => p.status === 'closed');
  if (closed) throw new AppError('PAYROLL_PERIOD_CLOSED', 409, 'Расчётный период закрыт: исправление – корректировкой в открытом периоде', { periodId: closed.id });
  if (row.row_version !== input.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Смену уже изменили, обновите данные', { rowVersion: row.row_version });
  if (row.status === 'cancelled') throw new AppError('SHIFT_NOT_EDITABLE', 409, 'Смена отменена', { status: row.status });

  if ('unpaidConfirmed' in input) {
    await applyFact(tx, row, { status: row.status, factStart: row.fact_start, factEnd: row.fact_end, paidMinutes: row.paid_minutes, source: row.paid_minutes_source, unpaid: true }, reason, meta, clock);
    return (await getShift(tx, row.id, clock))!;
  }
  const now = clock.now();
  const started = fromPgRange(row.period).start.getTime() <= now.getTime();
  if (!started) throw new AppError('SHIFT_NOT_EDITABLE', 409, 'Смена ещё не началась', { status: row.status });
  if (input.status === 'no_show') {
    await applyFact(tx, row, { status: 'no_show', factStart: null, factEnd: null, paidMinutes: null, source: null, unpaid: row.unpaid_confirmed }, reason, meta, clock);
  } else if ('paidMinutes' in input) {
    await applyFact(tx, row, { status: 'worked', factStart: row.fact_start, factEnd: row.fact_end, paidMinutes: input.paidMinutes, source: 'manual', unpaid: false }, reason, meta, clock);
  } else {
    if (input.factStart.getTime() >= input.factEnd.getTime()) throw new AppError('INVALID_DURATION', 422, 'Приход должен быть раньше ухода');
    if (input.factEnd.getTime() > now.getTime()) throw new AppError('VALIDATION_FAILED', 400, 'Уход не может быть в будущем', { field: 'factEnd' });
    const paidMinutes = Math.floor((input.factEnd.getTime() - input.factStart.getTime()) / 60_000);
    await applyFact(tx, row, { status: 'worked', factStart: input.factStart, factEnd: input.factEnd, paidMinutes, source: 'fact_time', unpaid: false }, reason, meta, clock);
  }
  return (await getShift(tx, row.id, clock))!;
}

// ---- задача shifts.review (K18 §5)

const REVIEW_META = (): AuditRequestMeta => ({ actor: { kind: 'system', process: 'shifts.review' }, source: 'system', requestId: randomUUID() });

type ReviewPool = { connect(): Promise<Tx & { release(): void }> } & Db;

/** Смены planned, у которых конец + shift.review_grace_minutes прошёл, – в needs_review (no_checkout / no_checkin). Каждая – своей транзакцией. */
export async function reviewShifts(pool: ReviewPool, clock: Clock = systemClock, limit = 200): Promise<number> {
  const now = clock.now();
  const grace = (await resolveSetting(pool, 'shift.review_grace_minutes', { network: true }, now)).value;
  const due = await pool.query<{ id: string; local_date: string }>(
    `SELECT s.id, to_char(s.local_date, 'YYYY-MM-DD') AS local_date FROM app.staff_shifts s
      WHERE s.status = 'planned' AND upper(s.period) + make_interval(mins => $1) <= $2
        AND NOT EXISTS (SELECT 1 FROM app.payroll_periods p WHERE p.status = 'closed' AND s.local_date BETWEEN p.date_from AND p.date_to)
      ORDER BY s.local_date, s.id LIMIT $3`,
    [grace, now, limit],
  );
  let flagged = 0;
  for (const shift of due.rows) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const periods = await lockPeriodsShared(c, [shift.local_date as LocalDate]);
      if (!periods.some((p) => p.status === 'closed')) {
        // Перечитать под блокировкой: сотрудник мог отметить уход, а смену – перенести.
        const r = await c.query<{ id: string; branch_id: string; review_reason: string }>(
          `UPDATE app.staff_shifts SET status = 'needs_review', review_reason = CASE WHEN fact_start IS NULL THEN 'no_checkin' ELSE 'no_checkout' END, row_version = row_version + 1
            WHERE id = $1 AND status = 'planned' AND upper(period) + make_interval(mins => $2) <= $3
            RETURNING id, branch_id, review_reason`,
          [shift.id, grace, now],
        );
        const row = r.rows[0];
        if (row) {
          await writeAudit(c, REVIEW_META(), { action: 'shift.review_flagged', object: { type: 'shift', id: row.id }, branchId: row.branch_id, after: { status: 'needs_review', reviewReason: row.review_reason } }, clock);
          flagged += 1;
        }
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
  return flagged;
}

/** Запуск задачи в worker: по умолчанию раз в 15 минут (K18 §5). */
export function startShiftReview(opts: { pool: ReviewPool; clock?: Clock; intervalMs?: number; onError?: (err: unknown) => void }): { stop(): void } {
  const timer = setInterval(() => {
    reviewShifts(opts.pool, opts.clock).catch((err: unknown) => (opts.onError ?? ((e) => console.error('shifts.review', e)))(err));
  }, opts.intervalMs ?? 15 * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
