// S1-10. Посещение, завершение сеанса, неявка вручную, исправление с причиной (K11 №8–11, 16 §5–6, R-08, Q-07).
// Правила команд K11: бронь FOR UPDATE → rowVersion → переход по dict_status_transitions → запись → row_version + 1,
// аудит, событие K4 – одна транзакция, без внешних вызовов. Строк занятости команды не меняют: время сеанса остаётся
// занятым в истории (завершение и неявка не освобождают слот задним числом).
// Повторная отметка прихода второго посещения не создаёт: переход arrived → arrived запрещён, а visits_one_active_idx
// держит это и на уровне базы. Неявка посещения не создаёт. Ошибочный приход / неявка – обратная запись
// (status 'reverted' с причиной и автором) и событие visit.reverted / no_show.reverted для Э2 (сторно баллов, штрафа).
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { durationMinutes, formatLocal, systemClock, type Clock, type TimeZone } from '../../core/time.ts';
import type { BookingStatus } from './confirm.ts';
import { assertTransition, checkRowVersion, guardStaff, lockBooking, notFound, reasonOf, requireText, type LockedBooking } from './change.ts';

declare module '../../core/outbox.ts' {
  interface EventRegistry {
    'visit.confirmed': {
      visitId: string;
      bookingId: string;
      branchId: string;
      clientId: string;
      arrivedAt: string;
      plannedStart: string;
      plannedEnd: string;
      plannedMinutes: number;
      resourceType: string;
    };
    'visit.reverted': { visitId: string; bookingId: string; clientId: string; reason: string };
    'no_show.marked': { noShowId: string; bookingId: string; branchId: string; clientId: string; plannedStart: string };
    'no_show.reverted': { noShowId: string; bookingId: string; clientId: string; reason: string };
  }
}

export interface VisitCommand {
  ctx: AccessContext;
  rowVersion: number;
}

/** Общий вход команды: бронь, зона и право, rowVersion, переход. */
async function begin(tx: Tx, bookingId: string, cmd: VisitCommand, action: 'booking.visit.mark' | 'booking.visit.correct', auditAction: string, to: BookingStatus): Promise<LockedBooking> {
  const b = await lockBooking(tx, bookingId);
  if (!b) throw notFound();
  guardStaff(cmd.ctx, b, action, auditAction);
  checkRowVersion(b, cmd.rowVersion);
  await assertTransition(tx, b.status, to);
  return b;
}

async function setStatus(tx: Tx, b: LockedBooking, to: BookingStatus): Promise<LockedBooking> {
  await tx.query('UPDATE app.bookings SET status = $2, row_version = row_version + 1 WHERE id = $1', [b.id, to]);
  return { ...b, status: to, rowVersion: b.rowVersion + 1 };
}

/** Q-101: с какого момента можно отметить приход – начало минус visit.arrive_early_min (значение на `at`, зона филиала). */
export async function arriveFrom(db: Db | Tx, branchId: string, start: Date, at: Date): Promise<Date> {
  const early = (await resolveSetting(db, 'visit.arrive_early_min', { branchId }, at)).value;
  return new Date(start.getTime() - early * 60_000);
}

/** K11 №8: клиент пришёл – посещение и событие visit.confirmed (начисление баллов в Э2, ключ по visitId). */
export async function markArrived(tx: Tx, bookingId: string, cmd: VisitCommand, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<LockedBooking> {
  const now = clock.now();
  const b = await begin(tx, bookingId, cmd, 'booking.visit.mark', 'visit.confirmed', 'arrived');
  const from = await arriveFrom(tx, b.branchId, b.start, now);
  if (now.getTime() < from.getTime()) {
    const hm = formatLocal(from, b.timezone as TimeZone, 'time');
    throw new AppError('ARRIVAL_TOO_EARLY', 409, `Приход можно отметить с ${hm} – не раньше чем за ${Math.round((b.start.getTime() - from.getTime()) / 60_000)} мин до начала`, { arriveFrom: from.toISOString() });
  }
  const v = await tx.query<{ id: string }>(
    `INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [b.id, b.branchId, b.clientId, now, cmd.ctx.actor.staffId],
  );
  const visitId = v.rows[0]!.id;
  await writeAudit(tx, meta, { action: 'visit.confirmed', object: { type: 'booking', id: b.id }, branchId: b.branchId, before: { status: b.status }, after: { status: 'arrived', visitId } }, clock);
  await publish(tx as OutboxTx, {
    type: 'visit.confirmed',
    aggregateType: 'booking',
    aggregateId: b.id,
    aggregateVersion: visitId,
    branchId: b.branchId,
    occurredAt: now,
    payload: {
      visitId, bookingId: b.id, branchId: b.branchId, clientId: b.clientId, arrivedAt: now.toISOString(),
      plannedStart: b.start.toISOString(), plannedEnd: b.end.toISOString(), plannedMinutes: durationMinutes({ start: b.start, end: b.end }), resourceType: b.resourceType,
    },
  });
  return setStatus(tx, b, 'arrived');
}

/** K11 №9: сеанс завершён (arrived → completed), время завершения – в посещении. */
export async function completeVisit(tx: Tx, bookingId: string, cmd: VisitCommand, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<LockedBooking> {
  const now = clock.now();
  const b = await begin(tx, bookingId, cmd, 'booking.visit.mark', 'visit.completed', 'completed');
  await tx.query(`UPDATE app.visits SET completed_at = greatest($2, arrived_at) WHERE booking_id = $1 AND status = 'active'`, [b.id, now]);
  await writeAudit(tx, meta, { action: 'visit.completed', object: { type: 'booking', id: b.id }, branchId: b.branchId, before: { status: b.status }, after: { status: 'completed' } }, clock);
  return setStatus(tx, b, 'completed');
}

/** K11 №10: неявка вручную (R-08) – только после начала сеанса; посещения не создаёт; событие no_show.marked. */
export async function markNoShow(tx: Tx, bookingId: string, cmd: VisitCommand & { reasonId?: string | undefined }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<LockedBooking> {
  const now = clock.now();
  const b = await begin(tx, bookingId, cmd, 'booking.visit.mark', 'no_show.marked', 'no_show');
  if (b.start.getTime() > now.getTime()) {
    throw new AppError('INVALID_STATUS_TRANSITION', 409, 'Неявку можно отметить только после начала сеанса', { from: b.status, to: 'no_show', reason: 'not_started' });
  }
  const reason = cmd.reasonId ? await reasonOf(tx, cmd.reasonId, 'no_show') : null;
  const n = await tx.query<{ id: string }>(
    `INSERT INTO app.no_shows (booking_id, branch_id, client_id, marked_at, marked_by, reason_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [b.id, b.branchId, b.clientId, now, cmd.ctx.actor.staffId, reason?.id ?? null],
  );
  const noShowId = n.rows[0]!.id;
  await writeAudit(tx, meta, { action: 'no_show.marked', object: { type: 'booking', id: b.id }, branchId: b.branchId, before: { status: b.status }, after: { status: 'no_show', noShowId, reasonCode: reason?.code ?? null } }, clock);
  await publish(tx as OutboxTx, {
    type: 'no_show.marked',
    aggregateType: 'booking',
    aggregateId: b.id,
    aggregateVersion: noShowId,
    branchId: b.branchId,
    occurredAt: now,
    payload: { noShowId, bookingId: b.id, branchId: b.branchId, clientId: b.clientId, plannedStart: b.start.toISOString() },
  });
  return setStatus(tx, b, 'no_show');
}

/** K11 №11: исправление ошибочной отметки с причиной – arrived/no_show → confirmed, обратная запись и событие. */
export async function revertVisit(tx: Tx, bookingId: string, cmd: VisitCommand & { reason: string | undefined }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<LockedBooking> {
  const now = clock.now();
  const reason = requireText(cmd.reason, 'reason');
  const b = await begin(tx, bookingId, cmd, 'booking.visit.correct', 'visit.reverted', 'confirmed'); // только arrived / no_show
  const kind = b.status === 'no_show' ? 'no_show' : 'visit';
  const table = kind === 'visit' ? 'app.visits' : 'app.no_shows';
  const r = await tx.query<{ id: string }>(
    `UPDATE ${table} SET status = 'reverted', reverted_at = $2, reverted_by = $3, revert_reason = $4 WHERE booking_id = $1 AND status = 'active' RETURNING id`,
    [b.id, now, cmd.ctx.actor.staffId, reason],
  );
  const markId = r.rows[0]?.id;
  if (!markId) throw new Error(`revertVisit: у брони ${b.id} в статусе ${b.status} нет активной отметки`);
  await writeAudit(tx, meta, { action: `${kind}.reverted`, object: { type: 'booking', id: b.id }, branchId: b.branchId, before: { status: b.status }, after: { status: 'confirmed' }, reason }, clock);
  const common = { aggregateType: 'booking' as const, aggregateId: b.id, aggregateVersion: `reverted:${markId}`, branchId: b.branchId, occurredAt: now };
  if (kind === 'visit') await publish(tx as OutboxTx, { ...common, type: 'visit.reverted', payload: { visitId: markId, bookingId: b.id, clientId: b.clientId, reason } });
  else await publish(tx as OutboxTx, { ...common, type: 'no_show.reverted', payload: { noShowId: markId, bookingId: b.id, clientId: b.clientId, reason } });
  return setStatus(tx, b, 'confirmed');
}
