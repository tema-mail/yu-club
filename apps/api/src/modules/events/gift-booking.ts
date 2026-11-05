// S3-59. Запись по подарку (K20 §8.2, 11 §9.3, TC-14): бронь – обычная K5/K6 на служебный ресурс gift_vr (VR1+VR2, без PS4),
// закрытый для обычной записи, – через грант бронирования (S3-58). Восемь проверок: активен и не истёк, будний день филиала,
// не праздник, оба шлема свободны (K6 occupy), состав без PS4, одна живая запись (gift_uses_one_live), «использован» после
// прихода (обработчик), клиент брони = gift.clientId в holdGift, bookGiftByStaff, переносе и attachHold.
// Порядок замков: удержание/бронь → клиент → подарок → ресурсы → единицы; обработчики: бронь FOR SHARE → подарок. Команды одного
// клиента идут по очереди (строка клиента), поэтому два holdGift не ждут друг друга на EXCLUDE.
// Жизненный цикл gift_uses ведут обработчики событий K4: идемпотентны, состояние берут из базы, а не из порядка доставки.
import type { Db, Tx as AuditTx } from '../../core/audit.ts';
import { writeAudit, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/outbox.ts';
import { subscribe } from '../../core/outbox.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { durationMinutes, instantToLocal, systemClock, todayIn, type Clock, type LocalDate, type TimeZone } from '../../core/time.ts';
import { createStaffBooking } from '../booking/change.ts';
import { createHold, registerServiceGrant, type GrantCheck, type HoldDto, type HoldOwner } from '../booking/hold.ts';
import { paymentBookingProvider } from '../booking/providers.ts';
import { lockClients } from '../clients/index.ts';
import { isHoliday } from '../network/holidays.ts';
import { expandToUnits } from '../resources/index.ts';
import { listUnits } from '../resources/composite.ts';
import { notFound, UUID_RE } from './events.ts';
import { getGiftRow, type GiftRow } from './gifts.ts';

export const GIFT_RESOURCE_TYPE = 'gift_vr';
const LIVE = `status IN ('held','booked','used')`;
const SYSTEM_META: AuditRequestMeta = { actor: { kind: 'system', process: 'events.gift' }, source: 'system', requestId: 'events.gift' };

const clientMismatch = () => new AppError('GIFT_CLIENT_MISMATCH', 422, 'Подарок записан на другого клиента');
const notActive = (status: string) => new AppError('GIFT_NOT_ACTIVE', 409, 'Подарок уже не действует', { status });
const alreadyReserved = () => new AppError('GIFT_ALREADY_RESERVED', 409, 'По подарку уже есть запись');
const compositionInvalid = (reason: string) => new AppError('GIFT_COMPOSITION_INVALID', 422, 'В подарок входят только 2 шлема Meta Quest 3S', { reason });

/** Пн–Пт и праздники считаются по дате филиала (K8, K20 §8.2 п.2–3); день недели – чистая функция: 1 = Пн … 7 = Вс. */
export function weekdayOf(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** Подарочный день: срок → будни → праздник. Одна проверка для записи, переноса, подтверждения и слотов (K20 №377). */
export async function assertGiftDay(db: Db, gift: Pick<GiftRow, 'valid_until' | 'terms'>, branchId: string, date: LocalDate): Promise<void> {
  if (date > gift.valid_until) throw new AppError('GIFT_EXPIRED', 409, 'Срок подарка истёк', { validUntil: gift.valid_until });
  if (!gift.terms.weekdays.includes(weekdayOf(date) as 1)) throw new AppError('GIFT_WEEKDAY_ONLY', 422, 'Подарком можно воспользоваться с понедельника по пятницу');
  if (await isHoliday(db, { branchId, date })) throw new AppError('GIFT_HOLIDAY', 422, 'В праздничные дни подарок не действует');
}

/** Состав ресурса на дату: ровно terms.devices единиц, ни одной PS (данные K6, K20 §8.2 п.5). */
async function assertComposition(tx: AuditTx, gift: Pick<GiftRow, 'terms'>, c: GrantCheck): Promise<void> {
  const set = await expandToUnits(tx, c.resource.id, c.period.start, { serviceGrant: true });
  const codes = (await listUnits(tx, c.branch.id)).filter((u) => set.unitIds.includes(u.id)).map((u) => u.code);
  if (codes.length !== gift.terms.devices || codes.some((code) => /^PS/i.test(code))) throw compositionInvalid('units');
}

/** Живая запись подарка; если подарка не передали – ищем по брони или удержанию (перенос и подтверждение идут без гранта). */
async function liveUse(tx: AuditTx, by: { giftId?: string; bookingId?: string | null; holdId?: string | null }): Promise<{ id: string; gift_id: string; status: string; hold_id: string | null; booking_id: string | null } | null> {
  const where = by.giftId ? 'gift_id = $1' : by.bookingId ? 'booking_id = $1' : 'hold_id = $1';
  const value = by.giftId ?? by.bookingId ?? by.holdId;
  const r = await tx.query<{ id: string; gift_id: string; status: string; hold_id: string | null; booking_id: string | null }>(`SELECT id, gift_id, status, hold_id, booking_id FROM app.gift_uses WHERE ${where} AND ${LIVE}`, [value]);
  return r.rows[0] ?? null;
}

/** Валидатор гранта gift_vr: вызывает booking в транзакции команды, до occupy. Ошибки проходят как есть. */
async function checkGiftGrant(tx: AuditTx, c: GrantCheck): Promise<void> {
  if (c.phase === 'add_item') throw compositionInvalid('extra_item'); // PS4 и всё прочее в удержании подарка (K20 §8.2 п.5)
  const use = c.grant ? null : await liveUse(tx, c.phase === 'reschedule' ? { bookingId: c.bookingId } : { holdId: c.holdId });
  const giftId = c.grant?.id ?? use?.gift_id;
  const gift = giftId ? await getGiftRow(tx, giftId, { forUpdate: true }) : null;
  if (!gift) throw new AppError('GIFT_NOT_ACTIVE', 409, 'Подарок не найден');
  if (c.clientId !== gift.client_id) throw clientMismatch(); // проверка 8 – раньше статусов: чужому подарку не отвечаем о его состоянии
  if (c.phase === 'attach') return;
  if (c.phase === 'hold' || c.phase === 'staff') {
    assertGiftFree(gift);
  } else {
    // перенос и подтверждение – только по своей живой записи
    const own = use ?? (await liveUse(tx, { giftId: gift.id }));
    const sameRecord = own && (c.phase === 'reschedule' ? own.booking_id === c.bookingId : own.hold_id === c.holdId);
    if (!sameRecord || gift.status !== 'reserved') throw notActive(gift.status);
  }
  const date = instantToLocal(c.period.start, c.branch.timezone).date;
  await assertGiftDay(tx, gift, c.branch.id, date);
  if (durationMinutes(c.period) !== gift.terms.roomMinutes) throw compositionInvalid('duration');
  const align = (await resolveSetting(tx, 'gift.start_align_minutes', { branchId: c.branch.id }, c.now)).value;
  const [hh, mm] = instantToLocal(c.period.start, c.branch.timezone).time.split(':').map(Number) as [number, number];
  if ((hh * 60 + mm) % align !== 0) throw new AppError('INVALID_DURATION', 422, `Начало – кратно ${align} минутам`, { reason: 'start_align', stepMinutes: align });
  await assertComposition(tx, gift, c);
}

/** Проверки 1 и 6 до команд booking: занятое удержание клиента не должно заслонить ответ про сам подарок. */
function assertGiftFree(gift: GiftRow): void {
  if (gift.status === 'expired') throw new AppError('GIFT_EXPIRED', 409, 'Срок подарка истёк', { validUntil: gift.valid_until });
  if (gift.status === 'reserved') throw alreadyReserved();
  if (gift.status !== 'issued') throw notActive(gift.status);
}

/** Подключает сервер при старте (S3-60). */
export function registerGiftGrant(): void {
  registerServiceGrant(GIFT_RESOURCE_TYPE, {
    check: checkGiftGrant,
    onHoldClosed: async (tx, holdId, now) => {
      await releaseByHold(tx, holdId, now, SYSTEM_META, { now: () => now });
    },
  });
}

// ---- поиск ресурса

/** Подарочный ресурс филиала (K20 §8.2; создаёт ensureGiftResource, S3-62). Использовать подарок можно в любом филиале с ним (Q-114). */
export async function giftResourceOf(db: Db, branchId: string): Promise<{ id: string; roomId: string | null } | null> {
  const r = await db.query<{ id: string; room_id: string | null }>(`SELECT id, room_id FROM app.resources WHERE branch_id = $1 AND resource_type = $2 AND status = 'active' ORDER BY id LIMIT 1`, [branchId, GIFT_RESOURCE_TYPE]);
  const row = r.rows[0];
  return row ? { id: row.id, roomId: row.room_id } : null;
}

async function requireGiftResource(db: Db, branchId: string): Promise<string> {
  const r = await giftResourceOf(db, branchId);
  if (!r) throw new AppError('RESOURCE_UNAVAILABLE', 409, 'В этом филиале подарок недоступен', { branchId });
  return r.id;
}

// ---- запись

async function markReserved(tx: AuditTx, gift: GiftRow, use: { holdId: string | null; bookingId: string | null; status: 'held' | 'booked' }, branchId: string, now: Date, meta: AuditRequestMeta, clock: Clock): Promise<void> {
  await tx.query('SAVEPOINT gift_use');
  try {
    await tx.query(`INSERT INTO app.gift_uses (gift_id, hold_id, booking_id, status, changed_at) VALUES ($1, $2, $3, $4, $5)`, [gift.id, use.holdId, use.bookingId, use.status, now]);
    await tx.query('RELEASE SAVEPOINT gift_use');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT gift_use');
    if ((err as { code?: string }).code === '23505') throw alreadyReserved();
    throw err;
  }
  await tx.query(`UPDATE app.birthday_gifts SET status = 'reserved', row_version = row_version + 1 WHERE id = $1`, [gift.id]);
  await writeAudit(tx, meta, { action: 'gift.reserved', object: { type: 'gift', id: gift.id }, branchId, before: { status: gift.status }, after: { status: 'reserved', holdId: use.holdId, bookingId: use.bookingId } }, clock);
}

/** Удержание по подарку из ЛК: обычное K5 на подарочный ресурс, дальше – обычное оформление с ценой 0. Клиент – владелец подарка. */
export async function holdGift(tx: Tx, owner: HoldOwner, giftId: string, input: { branchId: string; start: Date }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<HoldDto> {
  if (!UUID_RE.test(giftId)) throw notFound();
  const first = await getGiftRow(tx as AuditTx, giftId);
  if (!first) throw notFound();
  if (owner.clientId === null || owner.clientId !== first.client_id) throw clientMismatch();
  await lockClients(tx as AuditTx, [owner.clientId]);
  const gift = (await getGiftRow(tx as AuditTx, giftId, { forUpdate: true }))!;
  const now = clock.now();
  await healStaleHold(tx as AuditTx, gift, now, clock);
  const fresh = (await getGiftRow(tx as AuditTx, giftId))!;
  assertGiftFree(fresh);
  const resourceId = await requireGiftResource(tx as AuditTx, input.branchId);
  const end = new Date(input.start.getTime() + fresh.terms.roomMinutes * 60_000);
  const hold = await createHold(tx as AuditTx, owner, { branchId: input.branchId, items: [{ resourceId, start: input.start, end }], serviceGrant: { kind: 'gift', id: gift.id } }, clock);
  await markReserved(tx as AuditTx, fresh, { holdId: hold.id, bookingId: null, status: 'held' }, input.branchId, now, meta, clock);
  return hold;
}

/** Удержание истекло, а задача и обработчик ещё не прошли: подарок не держим – иначе клиент ждал бы воркера. */
async function healStaleHold(tx: AuditTx, gift: GiftRow, now: Date, clock: Clock): Promise<void> {
  if (gift.status !== 'reserved') return;
  const r = await tx.query<{ hold_id: string }>(
    `SELECT u.hold_id FROM app.gift_uses u JOIN app.holds h ON h.id = u.hold_id WHERE u.gift_id = $1 AND u.status = 'held' AND (h.status <> 'active' OR h.expires_at <= $2)`,
    [gift.id, now],
  );
  if (r.rows[0]) await releaseByHold(tx, r.rows[0].hold_id, now, SYSTEM_META, clock);
}

/** Запись подарка из CRM: бронь сразу (K20 №378). clientId формы, если есть, сверяется с подарком (проверка 8). */
export async function bookGiftByStaff(tx: Tx, ctx: AccessContext, giftId: string, input: { branchId: string; start: Date; comment?: string | undefined; clientId?: string | undefined }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<string> {
  if (!UUID_RE.test(giftId) || !UUID_RE.test(input.branchId)) throw notFound();
  if (!can(ctx, 'event.view', { branchId: input.branchId })) throw notFound();
  if (!can(ctx, 'gift.book', { branchId: input.branchId })) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'gift.book' });
  const first = await getGiftRow(tx as AuditTx, giftId);
  if (!first) throw notFound();
  if (input.clientId !== undefined && input.clientId !== first.client_id) throw clientMismatch();
  await lockClients(tx as AuditTx, [first.client_id]);
  const gift = (await getGiftRow(tx as AuditTx, giftId, { forUpdate: true }))!;
  const now = clock.now();
  await healStaleHold(tx as AuditTx, gift, now, clock);
  const fresh = (await getGiftRow(tx as AuditTx, giftId))!;
  assertGiftFree(fresh);
  const resourceId = await requireGiftResource(tx as AuditTx, input.branchId);
  const end = new Date(input.start.getTime() + fresh.terms.roomMinutes * 60_000);
  const bookingId = await createStaffBooking(
    tx as AuditTx,
    { ctx, branchId: input.branchId, resourceId, start: input.start, end, client: { clientId: fresh.client_id }, internalComment: input.comment, serviceGrant: { kind: 'gift', id: gift.id } },
    meta,
    clock,
  );
  await markReserved(tx as AuditTx, fresh, { holdId: null, bookingId, status: 'booked' }, input.branchId, now, meta, clock);
  return bookingId;
}

// ---- жизненный цикл (K20 §8.2, таблица)

/** Подарок снова доступен: issued, а если срок прошёл – expired. */
async function returnGift(tx: AuditTx, gift: GiftRow, now: Date, meta: AuditRequestMeta, clock: Clock): Promise<void> {
  const today = todayIn({ now: () => now }, gift.timezone as TimeZone);
  const to = gift.valid_until < today ? 'expired' : 'issued';
  await tx.query(`UPDATE app.birthday_gifts SET status = $2, row_version = row_version + 1 WHERE id = $1`, [gift.id, to]);
  await writeAudit(tx, meta, { action: 'gift.released', object: { type: 'gift', id: gift.id }, branchId: gift.issue_branch_id, before: { status: gift.status }, after: { status: to } }, clock);
}

/** held → released: истечение, снятие позиции, отпускание удержания. Идемпотентно. */
export async function releaseByHold(tx: AuditTx, holdId: string, now: Date, meta: AuditRequestMeta, clock: Clock): Promise<void> {
  const r = await tx.query<{ id: string; gift_id: string }>(`SELECT id, gift_id FROM app.gift_uses WHERE hold_id = $1 AND status = 'held'`, [holdId]);
  const use = r.rows[0];
  if (!use) return;
  const gift = (await getGiftRow(tx, use.gift_id, { forUpdate: true }))!;
  await tx.query(`UPDATE app.gift_uses SET status = 'released', changed_at = $2 WHERE id = $1 AND status = 'held'`, [use.id, now]);
  if (gift.status === 'reserved') await returnGift(tx, gift, now, meta, clock);
}

/** Привести запись подарка к состоянию брони. Порядок доставки не важен: визит, пришедший раньше подтверждения, тоже сходится.
 *  Освобождённую запись поднимает только снятая неявка (no_show.reverted): бронь снова живая, подарок ещё свободен. */
async function syncBooking(tx: AuditTx, bookingId: string, clientId: string | null, now: Date, clock: Clock): Promise<void> {
  const booking = await paymentBookingProvider.payableBooking(tx, bookingId); // бронь FOR SHARE – раньше подарка
  if (!booking) return;
  let use = await liveUse(tx, { bookingId });
  if (!use && clientId) {
    const held = await tx.query<{ id: string; gift_id: string; hold_id: string }>(
      `SELECT u.id, u.gift_id, u.hold_id FROM app.gift_uses u JOIN app.birthday_gifts g ON g.id = u.gift_id WHERE g.client_id = $1 AND u.status = 'held' ORDER BY u.id`,
      [clientId],
    );
    for (const h of held.rows) {
      const bookings = await paymentBookingProvider.holdBookings(tx, h.hold_id);
      if (!bookings.some((b) => b.bookingId === bookingId)) continue;
      await tx.query(`UPDATE app.gift_uses SET booking_id = $2, status = 'booked', changed_at = $3 WHERE id = $1 AND status = 'held'`, [h.id, bookingId, now]);
      use = await liveUse(tx, { bookingId });
      break;
    }
  }
  if (!use) {
    if (booking.status === 'confirmed' && booking.resourceType === GIFT_RESOURCE_TYPE) await reviveAfterNoShow(tx, bookingId, now, clock);
    return;
  }
  const gift = (await getGiftRow(tx, use.gift_id, { forUpdate: true }))!;
  const current = (await liveUse(tx, { bookingId }))!;
  const moved = booking.resourceType !== GIFT_RESOURCE_TYPE;
  if (booking.status.startsWith('cancelled') || booking.status === 'no_show' || (booking.status === 'confirmed' && moved)) {
    await tx.query(`UPDATE app.gift_uses SET status = 'released', changed_at = $2 WHERE id = $1`, [current.id, now]);
    if (booking.status === 'no_show' && !(await resolveSetting(tx, 'gift.no_show_returns', { branchId: booking.branchId }, now)).value) {
      await tx.query(`UPDATE app.birthday_gifts SET status = 'cancelled', cancel_reason = 'no_show', row_version = row_version + 1 WHERE id = $1`, [gift.id]);
      await writeAudit(tx, SYSTEM_META, { action: 'gift.cancelled', object: { type: 'gift', id: gift.id }, branchId: gift.issue_branch_id, before: { status: gift.status }, after: { status: 'cancelled' }, reason: 'no_show' }, clock);
      return;
    }
    await returnGift(tx, gift, now, SYSTEM_META, clock);
    return;
  }
  if (booking.status === 'arrived' || booking.status === 'completed') {
    if (current.status === 'used') return;
    await tx.query(`UPDATE app.gift_uses SET status = 'used', changed_at = $2 WHERE id = $1`, [current.id, now]);
    await tx.query(`UPDATE app.birthday_gifts SET status = 'used', row_version = row_version + 1 WHERE id = $1`, [gift.id]);
    await writeAudit(tx, SYSTEM_META, { action: 'gift.used', object: { type: 'gift', id: gift.id }, branchId: gift.issue_branch_id, before: { status: gift.status }, after: { status: 'used', bookingId } }, clock);
    return;
  }
  // confirmed на подарочном ресурсе: исправление прихода возвращает запись
  if (current.status === 'used') {
    await tx.query(`UPDATE app.gift_uses SET status = 'booked', changed_at = $2 WHERE id = $1`, [current.id, now]);
    await tx.query(`UPDATE app.birthday_gifts SET status = 'reserved', row_version = row_version + 1 WHERE id = $1`, [gift.id]);
    await writeAudit(tx, SYSTEM_META, { action: 'gift.reserved', object: { type: 'gift', id: gift.id }, branchId: gift.issue_branch_id, before: { status: 'used' }, after: { status: 'reserved', bookingId } }, clock);
  }
}

async function reviveAfterNoShow(tx: AuditTx, bookingId: string, now: Date, clock: Clock): Promise<void> {
  const r = await tx.query<{ gift_id: string }>(`SELECT gift_id FROM app.gift_uses WHERE booking_id = $1 AND status = 'released' ORDER BY changed_at DESC LIMIT 1`, [bookingId]);
  const giftId = r.rows[0]?.gift_id;
  if (!giftId) return;
  const gift = (await getGiftRow(tx, giftId, { forUpdate: true }))!;
  if (gift.status !== 'issued') return;
  await markReserved(tx, gift, { holdId: null, bookingId, status: 'booked' }, gift.issue_branch_id, now, SYSTEM_META, clock);
}

export const GIFT_HANDLERS = {
  holdExpired: 'events.gift.hold_expired',
  bookingConfirmed: 'events.gift.booking_confirmed',
  bookingCancelled: 'events.gift.booking_cancelled',
  bookingRescheduled: 'events.gift.booking_rescheduled',
  visitConfirmed: 'events.gift.visit_confirmed',
  visitReverted: 'events.gift.visit_reverted',
  noShowMarked: 'events.gift.no_show_marked',
  noShowReverted: 'events.gift.no_show_reverted',
} as const;

/** Подписки K4 (K20 §12): до startOutboxWorker. Обработчики идемпотентны: повтор доставки ничего не меняет. */
export function registerGiftHandlers(deps: { clock?: Clock } = {}): void {
  const clock = deps.clock ?? systemClock;
  subscribe('hold.expired', GIFT_HANDLERS.holdExpired, async (tx, e) => {
    await releaseByHold(tx as AuditTx, e.payload.holdId, clock.now(), SYSTEM_META, clock);
  });
  subscribe('booking.confirmed', GIFT_HANDLERS.bookingConfirmed, async (tx, e) => syncBooking(tx as AuditTx, e.payload.bookingId, e.payload.clientId, clock.now(), clock));
  subscribe('booking.cancelled', GIFT_HANDLERS.bookingCancelled, async (tx, e) => syncBooking(tx as AuditTx, e.payload.bookingId, e.payload.clientId, clock.now(), clock));
  subscribe('booking.rescheduled', GIFT_HANDLERS.bookingRescheduled, async (tx, e) => syncBooking(tx as AuditTx, e.payload.bookingId, e.payload.clientId, clock.now(), clock));
  subscribe('visit.confirmed', GIFT_HANDLERS.visitConfirmed, async (tx, e) => syncBooking(tx as AuditTx, e.payload.bookingId, e.payload.clientId, clock.now(), clock));
  subscribe('visit.reverted', GIFT_HANDLERS.visitReverted, async (tx, e) => syncBooking(tx as AuditTx, e.payload.bookingId, e.payload.clientId, clock.now(), clock));
  subscribe('no_show.marked', GIFT_HANDLERS.noShowMarked, async (tx, e) => syncBooking(tx as AuditTx, e.payload.bookingId, e.payload.clientId, clock.now(), clock));
  subscribe('no_show.reverted', GIFT_HANDLERS.noShowReverted, async (tx, e) => syncBooking(tx as AuditTx, e.payload.bookingId, e.payload.clientId, clock.now(), clock));
}
