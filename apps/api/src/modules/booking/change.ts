// S1-09. Отмена и перенос брони (K5 №13, K11 №6–7, K6 release/occupy, 01 §11–12, R-12).
// Одна транзакция на команду, порядок замков: бронь FOR UPDATE → клиент → ресурсы FOR SHARE → единицы FOR NO KEY UPDATE
// (lockUnitsForWrite – перед любой записью в occupancy). Внешних вызовов в транзакции нет: запись, аудит, outbox (K4).
// Отмена гасит только строки своей брони (release_reason 'cancelled') – соседние брони на тех же ресурсах (VR-место
// при отмене комнаты и наоборот) не трогаются (18 §5.3 п.5–6). Перенос – новая версия брони: строки старой гасятся
// ('rescheduled') и вставляются строки новой в той же транзакции; ошибка занятия откатывает всё, старая версия
// действует (01 §11 п.2–3). Комментарий сотрудника обязателен (01 §12); клиенту причина не обязательна (K5 №13).
import { randomUUID } from 'node:crypto';
import { writeAudit, type AuditRequestMeta, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import { can, type AccessContext, type Action } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { durationMinutes, systemClock, toPgRange, type Clock, type Interval } from '../../core/time.ts';
import { assertCanBook, findOrCreateGuest, lockClients } from '../clients/index.ts';
import { getBranch, isAcceptingBookings, type BranchInfo } from '../network/index.ts';
import { quote } from '../pricing/tariff.ts';
import { lockCompositions } from '../resources/index.ts';
import type { BookingStatus } from './confirm.ts';
import { checkItem, releaseExpiredHolds, serviceGrantFor, type GrantAccess, type ServiceGrant } from './hold.ts';
import { lockUnitsForWrite, occupyMany, releaseSources } from './occupancy.ts';

declare module '../../core/outbox.ts' {
  interface EventRegistry {
    'booking.cancelled': {
      bookingId: string;
      number: number;
      branchId: string;
      branchTimezone: string;
      clientId: string;
      start: string;
      end: string;
      bookingVersion: number;
      cancelledBy: 'client' | 'club';
      reasonCode: string | null;
      publicReason: string | null;
    };
    'booking.rescheduled': {
      bookingId: string;
      number: number;
      branchId: string;
      branchTimezone: string;
      clientId: string;
      previous: { version: number; resourceId: string; start: string; end: string };
      current: { version: number; resourceId: string; resourceName: string; start: string; end: string; priceKop: number };
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

// ---- общее для команд над бронью (K11 «Правила команд над бронью»; visit.ts, routes.crm.ts)

export interface LockedBooking {
  id: string;
  number: number;
  branchId: string;
  clientId: string;
  status: BookingStatus;
  currentVersion: number;
  resourceId: string;
  start: Date;
  end: Date;
  priceKop: number;
  rowVersion: number;
  timezone: string;
  unitIds: string[];
  resourceType: string;
}

/** K11 шаг 1: строка брони FOR UPDATE с единицами текущей версии. Нет / неверный id → null. */
export async function lockBooking(tx: Tx, bookingId: string): Promise<LockedBooking | null> {
  if (!UUID_RE.test(bookingId)) return null;
  const r = await tx.query<{
    id: string; number: string; branch_id: string; client_id: string; status: BookingStatus; current_version: number; resource_id: string;
    s: Date; e: Date; price_kop: string; row_version: number; branch_timezone: string; unit_ids: string[]; resource_type: string;
  }>(
    `SELECT b.id, b.number, b.branch_id, b.client_id, b.status, b.current_version, b.resource_id, lower(b.period) AS s, upper(b.period) AS e,
            b.price_kop, b.row_version, v.branch_timezone, v.unit_ids, v.resource_snapshot ->> 'type' AS resource_type
     FROM app.bookings b JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
     WHERE b.id = $1 FOR UPDATE OF b`,
    [bookingId],
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    id: x.id, number: Number(x.number), branchId: x.branch_id, clientId: x.client_id, status: x.status, currentVersion: x.current_version,
    resourceId: x.resource_id, start: x.s, end: x.e, priceKop: Number(x.price_kop), rowVersion: x.row_version, timezone: x.branch_timezone,
    unitIds: x.unit_ids, resourceType: x.resource_type,
  };
}

export interface StaffDenial {
  action: string;
  bookingId: string | null;
  branchId: string;
  reason: string;
}
const DENIED = new WeakMap<AppError, StaffDenial>();
/** Отказ по правам (для writeDenied в HTTP-слое, ADR 0005 п.8) или undefined. */
export const staffDenialOf = (err: unknown): StaffDenial | undefined => (err instanceof AppError ? DENIED.get(err) : undefined);

/** Вне зоны (нет schedule.view на филиал брони) – 404 как у несуществующей; в зоне без права – 403. */
export function guardStaff(ctx: AccessContext, b: { id: string | null; branchId: string }, action: Action, auditAction: string): void {
  const fail = (err: AppError, why: string): never => {
    DENIED.set(err, { action: auditAction, bookingId: b.id, branchId: b.branchId, reason: `${err.code}: ${why}` });
    throw err;
  };
  if (!can(ctx, 'schedule.view', { branchId: b.branchId })) fail(notFound(), 'schedule.view');
  if (!can(ctx, action, { branchId: b.branchId })) fail(new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action }), action);
}

/** K11 шаг 2: устаревшая форма (16 §15.4). */
export function checkRowVersion(b: LockedBooking, rowVersion: number): void {
  if (b.rowVersion !== rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Запись уже изменили – обновите карточку', { current: b.rowVersion });
}

/** K11 шаг 3: переход по dict_status_transitions (model-dannyh 0109). */
export async function assertTransition(tx: Tx, from: BookingStatus, to: BookingStatus): Promise<void> {
  const r = await tx.query(`SELECT 1 FROM app.dict_status_transitions WHERE domain = 'booking' AND from_code = $1 AND to_code = $2`, [from, to]);
  if (r.rowCount !== 1) throw new AppError('INVALID_STATUS_TRANSITION', 409, 'Это действие недоступно для записи в текущем статусе', { from, to });
}

/** Обязательный текст сотрудника (01 §12): пустой → COMMENT_REQUIRED. */
export function requireText(value: string | undefined, field: string): string {
  const s = (value ?? '').trim();
  if (s === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите комментарий', { field });
  if (s.length > 1000) throw new AppError('VALIDATION_FAILED', 400, 'Слишком длинный комментарий', { field });
  return s;
}

/** Причина из справочника нужного домена, не в архиве; requires_comment у причины уже покрыт обязательным комментарием. */
export async function reasonOf(tx: Tx, reasonId: string, domain: string): Promise<{ id: string; code: string; name: string }> {
  const r = UUID_RE.test(reasonId)
    ? await tx.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM app.dict_reasons WHERE id = $1 AND domain = $2 AND archived_at IS NULL`, [reasonId, domain])
    : { rows: [] };
  const row = r.rows[0];
  if (!row) throw new AppError('VALIDATION_FAILED', 400, 'Причина не найдена', { field: 'reasonId' });
  return row;
}

// ---- отмена (K5 №13, K11 №6)

export type CancelBy =
  | { kind: 'client'; clientId: string; reason?: string | undefined }
  | { kind: 'staff'; ctx: AccessContext; rowVersion: number; initiator: 'club' | 'client_by_phone'; reasonId: string; comment: string | undefined };

/** Клиент – только своя (иначе 404), из confirmed, до начала, при booking.client_cancel_enabled (R-12, денег нет).
 *  Сотрудник – booking.cancel по филиалу брони, rowVersion, причина из справочника и комментарий обязательны. */
export async function cancelBooking(tx: Tx, bookingId: string, by: CancelBy, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<LockedBooking> {
  const now = clock.now();
  const b = await lockBooking(tx, bookingId);
  if (!b) throw notFound();
  let to: BookingStatus;
  let reason: { id: string; code: string; name: string } | null = null;
  let comment: string | null;
  if (by.kind === 'client') {
    if (b.clientId !== by.clientId) throw notFound();
    const enabled = (await resolveSetting(tx, 'booking.client_cancel_enabled', { branchId: b.branchId }, now)).value;
    if (b.status !== 'confirmed' || b.start.getTime() <= now.getTime() || !enabled) {
      throw new AppError('BOOKING_NOT_CANCELLABLE', 409, 'Эту запись уже нельзя отменить онлайн');
    }
    to = 'cancelled_by_client';
    comment = by.reason?.trim() ? by.reason.trim() : null;
  } else {
    guardStaff(by.ctx, b, 'booking.cancel', 'booking.cancelled');
    checkRowVersion(b, by.rowVersion);
    comment = requireText(by.comment, 'comment');
    to = by.initiator === 'club' ? 'cancelled_by_club' : 'cancelled_by_client';
    await assertTransition(tx, b.status, to);
    reason = await reasonOf(tx, by.reasonId, by.initiator === 'club' ? 'booking_cancel_club' : 'booking_cancel_client');
  }
  await lockUnitsForWrite(tx, b.branchId, b.unitIds, { forRelease: true });
  await releaseSources(tx, { type: 'booking', ids: [b.id] }, 'cancelled', now);
  const actor = by.kind === 'client' ? { type: 'client', id: by.clientId } : { type: 'staff', id: by.ctx.actor.staffId };
  await tx.query(
    `UPDATE app.bookings SET status = $2, cancelled_at = $3, cancelled_by_type = $4, cancelled_by_id = $5, cancel_reason_id = $6, cancel_comment = $7,
       row_version = row_version + 1 WHERE id = $1`,
    [b.id, to, now, actor.type, actor.id, reason?.id ?? null, comment],
  );
  await writeAudit(
    tx,
    meta,
    {
      action: 'booking.cancelled',
      object: { type: 'booking', id: b.id },
      branchId: b.branchId,
      before: { status: b.status },
      after: { status: to, reasonCode: reason?.code ?? null, comment },
      reason: comment,
    },
    clock,
  );
  const cancelledBy = to === 'cancelled_by_club' ? 'club' : 'client';
  await publish(tx as OutboxTx, {
    type: 'booking.cancelled',
    aggregateType: 'booking',
    aggregateId: b.id,
    aggregateVersion: 'cancelled',
    branchId: b.branchId,
    occurredAt: now,
    payload: {
      bookingId: b.id, number: b.number, branchId: b.branchId, branchTimezone: b.timezone, clientId: b.clientId,
      start: b.start.toISOString(), end: b.end.toISOString(), bookingVersion: b.currentVersion, cancelledBy,
      reasonCode: reason?.code ?? null, publicReason: cancelledBy === 'club' ? (reason?.name ?? null) : null,
    },
  });
  return { ...b, status: to, rowVersion: b.rowVersion + 1 };
}

// ---- перенос (K11 №7, 01 §11)

export interface RescheduleInput {
  ctx: AccessContext;
  rowVersion: number;
  resourceId: string;
  start: Date;
  end: Date;
  reason: string | undefined;
  /** K5 грант (S3-58). Бронь уже на служебном ресурсе проверяется валидатором и без него: маршрут K11 №7 о подарке не знает. */
  serviceGrant?: ServiceGrant | undefined;
}

/** Снимок версии (как в confirm): ресурс, комната, филиал на момент версии. */
export function resourceSnapshot(r: { name: string; type: string; roomName: string | null }, branch: BranchInfo) {
  return { name: r.name, type: r.type, roomName: r.roomName, branchName: branch.name, branchAddress: branch.address };
}

/** Новая версия брони: проверки 01 §8.2 как у удержания (ресурс, окно, шаг, график, блокировки), занятие одним INSERT,
 *  цена по тарифу на новое время. Только из confirmed. Тот же ресурс и время – ничего не меняется. */
export async function rescheduleBooking(tx: Tx, bookingId: string, input: RescheduleInput, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<LockedBooking> {
  const now = clock.now();
  const b = await lockBooking(tx, bookingId);
  if (!b) throw notFound();
  guardStaff(input.ctx, b, 'booking.reschedule', 'booking.rescheduled');
  checkRowVersion(b, input.rowVersion);
  const reason = requireText(input.reason, 'reason');
  if (b.status !== 'confirmed') throw new AppError('INVALID_STATUS_TRANSITION', 409, 'Перенести можно только подтверждённую запись', { from: b.status, to: 'rescheduled' });
  // сеанс уже начался – переносить нечего: приход/неявка/отмена, а не новая версия (ревизия S1-08..13)
  if (b.start.getTime() <= now.getTime()) {
    throw new AppError('INVALID_STATUS_TRANSITION', 409, 'Сеанс уже начался – перенос невозможен', { from: b.status, to: 'rescheduled', startedAt: b.start.toISOString() });
  }
  if (b.resourceId === input.resourceId.toLowerCase() && b.start.getTime() === input.start.getTime() && b.end.getTime() === input.end.getTime()) return b;
  const branch = await getBranch(tx, b.branchId);
  if (!branch) throw notFound();
  const maxDays = (await resolveSetting(tx, 'booking.window_max_days', { branchId: branch.id }, now)).value;
  await lockClients(tx, [b.clientId]);
  const access: GrantAccess | null =
    input.serviceGrant || serviceGrantFor(b.resourceType) ? { phase: 'reschedule', grant: input.serviceGrant ?? null, clientId: b.clientId, holdId: null, bookingId: b.id } : null;
  const c = await checkItem(tx, branch, now, maxDays, { resourceId: input.resourceId, start: input.start, end: input.end }, access);
  const period: Interval = c.period;
  // замки: ресурсы → единицы (старые и новые одним запросом в порядке id), затем гашение старой версии
  await lockCompositions(tx, [{ resourceId: c.resource.id, unitIds: c.units.unitIds, at: period.start }]);
  await lockUnitsForWrite(tx, branch.id, [...b.unitIds, ...c.units.unitIds], { forRelease: true });
  const q = await quote(tx, { branchId: branch.id, resourceType: c.resource.type, start: period.start, durationMinutes: durationMinutes(period) });
  await releaseSources(tx, { type: 'booking', ids: [b.id] }, 'rescheduled', now);
  await releaseExpiredHolds(tx, now, { unitIds: c.units.unitIds, clientId: b.clientId, period });
  const version = b.currentVersion + 1;
  await occupyMany(tx, branch.id, [{ units: c.units, period, source: { type: 'booking', id: b.id, version }, clientId: b.clientId }]);
  const staffId = input.ctx.actor.staffId;
  await tx.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, tariff_id, price_kop, price_snapshot, reason, created_by_type, created_by_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'staff', $12, $13)`,
    [b.id, version, c.resource.id, toPgRange(period), branch.timezone, c.units.unitIds, JSON.stringify(resourceSnapshot(c.resource, branch)), q.tariffId, q.priceKop, JSON.stringify(q.snapshot), reason, staffId, now],
  );
  await tx.query(
    `UPDATE app.bookings SET current_version = $2, resource_id = $3, period = $4, price_kop = $5, row_version = row_version + 1 WHERE id = $1`,
    [b.id, version, c.resource.id, toPgRange(period), q.priceKop],
  );
  const previous = { version: b.currentVersion, resourceId: b.resourceId, start: b.start.toISOString(), end: b.end.toISOString() };
  const current = { version, resourceId: c.resource.id, resourceName: c.resource.name, start: period.start.toISOString(), end: period.end.toISOString(), priceKop: q.priceKop };
  await writeAudit(tx, meta, { action: 'booking.rescheduled', object: { type: 'booking', id: b.id }, branchId: b.branchId, before: previous, after: current, reason }, clock);
  await publish(tx as OutboxTx, {
    type: 'booking.rescheduled',
    aggregateType: 'booking',
    aggregateId: b.id,
    aggregateVersion: version,
    branchId: b.branchId,
    occurredAt: now,
    payload: { bookingId: b.id, number: b.number, branchId: b.branchId, branchTimezone: branch.timezone, clientId: b.clientId, previous, current },
  });
  return { ...b, currentVersion: version, resourceId: c.resource.id, start: period.start, end: period.end, priceKop: q.priceKop, rowVersion: b.rowVersion + 1, unitIds: c.units.unitIds, resourceType: c.resource.type, timezone: branch.timezone };
}

// ---- бронь администратором (K11 №4, K9 «Бронь администратором без профиля», S1-13)

export interface StaffCreateInput {
  ctx: AccessContext;
  branchId: string;
  resourceId: string;
  start: Date;
  end: Date;
  client: { clientId: string } | { phone: string; firstName: string; lastName?: string | undefined };
  internalComment?: string | undefined;
  /** Э2 (K11 изменение №4, K15 §8, R-13): бронь клиенту на −50 – только с правом loyalty.book_below_limit и причиной. */
  overrideLoyaltyLimit?: { reason: string } | undefined;
  /** K5 грант (S3-58): бронь на служебный ресурс. */
  serviceGrant?: ServiceGrant | undefined;
}

/** Ворота записи для брони сотрудником: при LOYALTY_LIMIT_REACHED обход – только с причиной и правом
 *  loyalty.book_below_limit (Владелец, Директор), иначе FORBIDDEN. Возвращает причину обхода (для аудита) или null. */
async function assertCanBookByStaff(tx: Tx, input: StaffCreateInput, branchId: string, clientId: string, now: Date): Promise<string | null> {
  try {
    await assertCanBook(tx, clientId, now);
    return null;
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'LOYALTY_LIMIT_REACHED' || input.overrideLoyaltyLimit === undefined) throw err;
  }
  if (!can(input.ctx, 'loyalty.book_below_limit', { branchId })) {
    throw new AppError('FORBIDDEN', 403, 'Записать клиента с балансом −50 может только Владелец или Директор', { action: 'loyalty.book_below_limit' });
  }
  const reason = requireText(input.overrideLoyaltyLimit.reason, 'overrideLoyaltyLimit.reason');
  await assertCanBook(tx, clientId, now, { override: { loyaltyLimit: { reason, staffId: input.ctx.actor.staffId } } });
  return reason;
}

/** Те же проверки, что K5 confirm, без удержания (01 §9 п.6, §10.2): ресурс, окно, шаг, график, блокировки,
 *  ограничения клиента, пересечения по базе (occupancy и client_time) – принудительного исключения нет. Клиент без
 *  профиля – findOrCreateGuest по телефону: пересечение «по телефону» ловит client_time той же карточки (Q-09).
 *  Порядок замков: клиент → ресурсы → единицы. Событие booking.confirmed (source 'crm') – уведомления как у сайта. */
export async function createStaffBooking(tx: Tx, input: StaffCreateInput, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<string> {
  const now = clock.now();
  const branch = UUID_RE.test(input.branchId) ? await getBranch(tx, input.branchId) : null;
  if (!branch) throw notFound();
  guardStaff(input.ctx, { id: null, branchId: branch.id }, 'booking.create', 'booking.created');
  if (!isAcceptingBookings(branch, now)) throw new AppError('BRANCH_NOT_ACTIVE', 409, 'Филиал сейчас не принимает записи');
  let clientId: string;
  if ('clientId' in input.client) {
    if (!UUID_RE.test(input.client.clientId)) throw new AppError('VALIDATION_FAILED', 400, 'Клиент не найден', { field: 'client.clientId' });
    clientId = input.client.clientId.toLowerCase(); // нет карточки – NOT_FOUND из assertCanBook
  } else {
    clientId = (await findOrCreateGuest(tx, input.client, meta, clock)).id;
  }
  await lockClients(tx, [clientId]);
  const belowLimitReason = await assertCanBookByStaff(tx, input, branch.id, clientId, now);
  const maxDays = (await resolveSetting(tx, 'booking.window_max_days', { branchId: branch.id }, now)).value;
  const access: GrantAccess | null = input.serviceGrant ? { phase: 'staff', grant: input.serviceGrant, clientId, holdId: null, bookingId: null } : null;
  const c = await checkItem(tx, branch, now, maxDays, { resourceId: input.resourceId, start: input.start, end: input.end }, access);
  const q = await quote(tx, { branchId: branch.id, resourceType: c.resource.type, start: c.period.start, durationMinutes: durationMinutes(c.period) });
  await releaseExpiredHolds(tx, now, { unitIds: c.units.unitIds, clientId, period: c.period });
  const bookingId = randomUUID();
  await occupyMany(tx, branch.id, [{ units: c.units, period: c.period, source: { type: 'booking', id: bookingId, version: 1 }, clientId }]);
  const checkoutId = randomUUID();
  const staffId = input.ctx.actor.staffId;
  const comment = input.internalComment?.trim() ? input.internalComment.trim() : null;
  const b = await tx.query<{ number: string }>(
    `INSERT INTO app.bookings (id, checkout_id, branch_id, client_id, resource_id, period, price_kop, source, internal_comment, created_by_type, created_by_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'crm', $8, 'staff', $9, $10) RETURNING number`,
    [bookingId, checkoutId, branch.id, clientId, c.resource.id, toPgRange(c.period), q.priceKop, comment, staffId, now],
  );
  await tx.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, tariff_id, price_kop, price_snapshot, created_by_type, created_by_id, created_at)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, 'staff', $10, $11)`,
    [bookingId, c.resource.id, toPgRange(c.period), branch.timezone, c.units.unitIds, JSON.stringify(resourceSnapshot(c.resource, branch)), q.tariffId, q.priceKop, JSON.stringify(q.snapshot), staffId, now],
  );
  await writeAudit(
    tx,
    meta,
    { action: 'booking.created', object: { type: 'booking', id: bookingId }, branchId: branch.id, after: { clientId, resourceId: c.resource.id, start: c.period.start, end: c.period.end, priceKop: q.priceKop, source: 'crm' } },
    clock,
  );
  if (belowLimitReason !== null) {
    await writeAudit(tx, meta, { action: 'loyalty.booked_below_limit', object: { type: 'booking', id: bookingId }, branchId: branch.id, after: { clientId }, reason: belowLimitReason }, clock);
  }
  await publish(tx as OutboxTx, {
    type: 'booking.confirmed',
    aggregateType: 'booking',
    aggregateId: bookingId,
    aggregateVersion: 1,
    branchId: branch.id,
    occurredAt: now,
    payload: {
      bookingId, number: Number(b.rows[0]!.number), checkoutId, branchId: branch.id, branchTimezone: branch.timezone, clientId, resourceId: c.resource.id,
      resourceName: c.resource.name, start: c.period.start.toISOString(), end: c.period.end.toISOString(), priceKop: q.priceKop, source: 'crm', bookingVersion: 1,
    },
  });
  return bookingId;
}
