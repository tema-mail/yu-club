// K15 §3 (07 §6.2–6.3, TC-05/06): резерв баллов на время удержания и брони.
// Резерв 'hold' своего срока не хранит: занят, пока удержание active, не истекло и подпись его активных позиций
// (items_signature представления booking app.booking_hold_points, миграция 0208) совпадает с записанной – перезапуск таймера удержания продлевает резерв сам, изменение позиций
// (добавление, удаление, отказ) снимает лениво: статус released(...) проставляется при следующем обращении к счёту
// под блокировкой или обработчиком события. Подтверждение брони: резерв удержания с неизменной подписью (по позициям
// 'converted') → converted, на каждую бронь – резерв 'booking' в пределах доступного; подпись разошлась – hold_changed. Снятие: отмена брони, неявка (без списания, Q-46), перенос (не хватает – rescheduled_short),
// оплата не баллами (paid_other). Списание (spent) – способ оплаты points (S2-37).
// Порядок везде: openAccount (блокировка счёта – до строк брони и удержания, K17 «Решения 02.11») → перечитать → проверить.
import { writeAudit, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { listSubscriptions, subscribe } from '../../core/outbox.ts';
import { resolveSetting } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { holdReserveMatchSql, openAccount, POINTS_MIN_BALANCE, reservedCenti } from './account.ts';
import type { LoyaltyBookings, PaymentLookup } from './accrual.ts';
import { LIMIT_MESSAGE } from './gate.ts';

export type ReleaseReason = 'hold_expired' | 'hold_released' | 'hold_changed' | 'booking_cancelled' | 'no_show' | 'rescheduled_short' | 'replaced' | 'paid_other' | 'insufficient';

export interface ReserveBookings extends Pick<LoyaltyBookings, 'payableBooking' | 'bookingClient'> {
  /** Брони, созданные подтверждением удержания (booking/providers.ts holdBookings). */
  holdBookings(tx: Tx, holdId: string): Promise<Array<{ bookingId: string; clientId: string; status: string; minutes: number }>>;
}

const invalidHold = () => new AppError('RESERVE_HOLD_INVALID', 409, 'Удержание истекло, уже подтверждено или не ваше');

async function release(tx: Tx, reserveId: string, reason: ReleaseReason, now: Date): Promise<void> {
  await tx.query(`UPDATE app.loyalty_reserves SET status = 'released', release_reason = $2, closed_at = $3 WHERE id = $1 AND status IN ('hold','booking')`, [reserveId, reason, now]);
}

/** Ленивое снятие (K15 §3): резервы удержаний клиента, которые уже не держат баллы, получают статус и причину. */
export async function settleStaleReserves(tx: Tx, clientId: string, now: Date): Promise<number> {
  const stale = await tx.query<{ id: string; reason: ReleaseReason }>(
    `SELECT r.id,
            CASE WHEN h.status = 'released' THEN 'hold_released'
                 WHEN h.status = 'expired' OR h.expires_at <= $2 THEN 'hold_expired'
                 ELSE 'hold_changed' END AS reason
     FROM app.loyalty_reserves r JOIN app.booking_hold_points h ON h.hold_id = r.hold_id
     WHERE r.client_id = $1 AND r.status = 'hold' AND NOT ${holdReserveMatchSql('r', 'h', '$2')}
     FOR UPDATE OF r`,
    [clientId, now],
  );
  for (const r of stale.rows) await release(tx, r.id, r.reason, now);
  return stale.rows.length;
}

/** Активные позиции удержания: минуты и типы ресурсов (резерв = Σ минут × 100, 1 балл = 1 минута, 07 §6.1).
 *  Представление booking (миграция 0208), не таблицы удержаний (ADR 0002). */
async function holdItems(tx: Tx, holdId: string): Promise<Array<{ minutes: number; resourceType: string }>> {
  const r = await tx.query<{ minutes: number; resource_type: string }>(
    `SELECT minutes, resource_type FROM app.booking_hold_point_items WHERE hold_id = $1 ORDER BY item_id`,
    [holdId],
  );
  return r.rows.map((x) => ({ minutes: x.minutes, resourceType: x.resource_type }));
}

/** POST /holds/{holdId}/points-reserve (K15 §11): резерв на удержание клиента. Повтор на то же удержание – старый replaced. */
export async function reserveForHold(
  tx: Tx,
  input: { clientId: string; holdId: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ reserveId: string; amountCenti: number; availableCenti: number }> {
  const now = clock.now();
  const acc = await openAccount(tx, input.clientId, now);
  const h = (
    // без блокировки строки удержания (ADR 0002 – только представление booking): изменение удержания после проверки
    // меняет подпись, и резерв снимается лениво; подтверждение сохраняет подпись (позиции 'converted') – резерв переходит
    await tx.query<{ id: string; branch_id: string; client_id: string | null; status: string; expires_at: Date }>(
      'SELECT hold_id AS id, branch_id, client_id, status, expires_at FROM app.booking_hold_points WHERE hold_id = $1',
      [input.holdId],
    )
  ).rows[0];
  if (!h || h.client_id !== acc.clientId || h.status !== 'active' || h.expires_at <= now) throw invalidHold();
  await settleStaleReserves(tx, acc.clientId, now);
  if (acc.balance <= POINTS_MIN_BALANCE) throw new AppError('LOYALTY_LIMIT_REACHED', 403, LIMIT_MESSAGE, { balanceCenti: acc.balance });
  const items = await holdItems(tx, h.id);
  if (items.length === 0) throw invalidHold();
  const allowed = (await resolveSetting(tx, 'loyalty.points_resource_types', { branchId: h.branch_id }, now)).value;
  const denied = items.find((i) => !allowed.includes(i.resourceType));
  if (denied) throw new AppError('POINTS_NOT_ALLOWED', 422, 'Этот вид посещения баллами не оплачивается', { resourceType: denied.resourceType });
  const required = items.reduce((s, i) => s + i.minutes, 0) * 100;
  const available = Math.max(0, Math.max(0, acc.balance) - (await reservedCenti(tx, acc.clientId, now, { holdId: h.id })));
  if (available < required) {
    throw new AppError('POINTS_INSUFFICIENT', 409, 'Баллов недостаточно для оплаты выбранного времени', { availableCenti: available, requiredCenti: required });
  }
  const prev = await tx.query<{ id: string }>(`SELECT id FROM app.loyalty_reserves WHERE hold_id = $1 AND status = 'hold' FOR UPDATE`, [h.id]);
  for (const p of prev.rows) await release(tx, p.id, 'replaced', now);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO app.loyalty_reserves (client_id, amount_centi, hold_id, hold_signature, status, created_at)
     VALUES ($1, $2, $3, (SELECT items_signature FROM app.booking_hold_points WHERE hold_id = $3::uuid), 'hold', $4) RETURNING id`,
    [acc.clientId, required, h.id, now],
  );
  const reserveId = r.rows[0]!.id;
  await writeAudit(tx, meta, { action: 'loyalty.reserve.created', object: { type: 'hold', id: h.id }, branchId: h.branch_id, after: { reserveId, amountCenti: required } }, clock);
  return { reserveId, amountCenti: required, availableCenti: available - required };
}

/** DELETE /holds/{holdId}/points-reserve: клиент передумал – резерв released('hold_changed'). Нет резерва – без ошибки. */
export async function releaseHoldReserve(tx: Tx, input: { clientId: string; holdId: string }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<boolean> {
  const now = clock.now();
  const acc = await openAccount(tx, input.clientId, now);
  const r = await tx.query<{ id: string }>(`SELECT id FROM app.loyalty_reserves WHERE hold_id = $1 AND client_id = $2 AND status = 'hold' FOR UPDATE`, [input.holdId, acc.clientId]);
  const row = r.rows[0];
  if (!row) return false;
  await release(tx, row.id, 'hold_changed', now);
  await writeAudit(tx, meta, { action: 'loyalty.reserve.released', object: { type: 'hold', id: input.holdId }, after: { reserveId: row.id, reason: 'hold_changed' } }, clock);
  return true;
}

// ---- обработчики событий

/** booking.confirmed: резервы подтверждённых удержаний клиента с неизменной подписью → converted, на каждую живую
 *  бронь – резерв 'booking', если доступных баллов хватает на все брони удержания; иначе – released('insufficient'),
 *  при смене позиций до подтверждения – released('hold_changed'). Резервы брони никогда не превышают доступный баланс. */
export async function convertReserves(tx: Tx, clientId: string, deps: { bookings: ReserveBookings; clock: Clock }): Promise<number> {
  const now = deps.clock.now();
  const acc = await openAccount(tx, clientId, now);
  const holds = await tx.query<{ id: string; hold_id: string }>(
    `SELECT r.id, r.hold_id FROM app.loyalty_reserves r JOIN app.booking_hold_points h ON h.hold_id = r.hold_id
     WHERE r.client_id = $1 AND r.status = 'hold' AND h.status = 'converted' AND ${holdReserveMatchSql('r', 'h', '$2')}
     ORDER BY r.created_at, r.id FOR UPDATE OF r`,
    [acc.clientId, now],
  );
  let made = 0;
  for (const res of holds.rows) {
    const bookings = (await deps.bookings.holdBookings(tx, res.hold_id)).filter((b) => b.status === 'confirmed' && b.minutes > 0);
    const need = bookings.reduce((s, b) => s + b.minutes * 100, 0);
    const available = Math.max(0, Math.max(0, acc.balance) - (await reservedCenti(tx, acc.clientId, now, { holdId: res.hold_id })));
    if (available < need) {
      await release(tx, res.id, 'insufficient', now); // позиции не менялись – баллов меньше нужного (миграция 0209)
      continue;
    }
    await tx.query(`UPDATE app.loyalty_reserves SET status = 'converted', closed_at = $2 WHERE id = $1`, [res.id, now]);
    for (const b of bookings) {
      const ins = await tx.query(
        `INSERT INTO app.loyalty_reserves (client_id, amount_centi, hold_id, booking_id, status, created_at) VALUES ($1, $2, $3, $4, 'booking', $5)
         ON CONFLICT (booking_id) WHERE status = 'booking' DO NOTHING`,
        [acc.clientId, b.minutes * 100, res.hold_id, b.bookingId, now],
      );
      made += ins.rowCount ?? 0;
    }
  }
  await settleStaleReserves(tx, acc.clientId, now);
  return made;
}

/** Резерв брони по её текущему состоянию из базы: отмена, неявка, перенос, оплата не баллами. */
export async function reconcileBookingReserve(
  tx: Tx,
  bookingId: string,
  deps: { bookings: ReserveBookings; payments?: PaymentLookup; clock: Clock },
): Promise<ReleaseReason | 'resized' | 'none'> {
  const now = deps.clock.now();
  const clientId = await deps.bookings.bookingClient(tx, bookingId);
  if (!clientId) return 'none';
  const acc = await openAccount(tx, clientId, now); // счёт до брони (K17 02.11) → перечитать бронь → проверить
  const b = await deps.bookings.payableBooking(tx, bookingId);
  if (!b || b.clientId !== acc.clientId) return 'none';
  const r = (await tx.query<{ id: string; amount_centi: string }>(`SELECT id, amount_centi FROM app.loyalty_reserves WHERE booking_id = $1 AND status = 'booking' FOR UPDATE`, [bookingId])).rows[0];
  if (!r) return 'none';
  if (b.status.startsWith('cancelled')) {
    await release(tx, r.id, 'booking_cancelled', now);
    return 'booking_cancelled';
  }
  if (b.status === 'no_show') {
    await release(tx, r.id, 'no_show', now); // без списания – по умолчанию, ждёт заказчика (Q-46)
    return 'no_show';
  }
  if (deps.payments) {
    const p = await deps.payments.livePayment(tx, bookingId);
    if (p && !p.methods.includes('points')) {
      await release(tx, r.id, 'paid_other', now);
      return 'paid_other';
    }
  }
  const need = b.minutes * 100;
  if (need === Number(r.amount_centi)) return 'none';
  const available = Math.max(0, Math.max(0, acc.balance) - (await reservedCenti(tx, acc.clientId, now, { bookingId })));
  if (available < need) {
    await release(tx, r.id, 'rescheduled_short', now);
    return 'rescheduled_short';
  }
  await tx.query('UPDATE app.loyalty_reserves SET amount_centi = $2 WHERE id = $1', [r.id, need]);
  return 'resized';
}

export const RESERVE_HANDLERS = {
  bookingConfirmed: 'loyalty.reserve.onBookingConfirmed',
  holdExpired: 'loyalty.reserve.onHoldExpired',
  bookingCancelled: 'loyalty.reserve.onBookingCancelled',
  bookingRescheduled: 'loyalty.reserve.onBookingRescheduled',
  noShowMarked: 'loyalty.reserve.onNoShowMarked',
  paymentRecorded: 'loyalty.reserve.onPaymentRecorded',
} as const;

/** Подписки (worker.ts, до startOutboxWorker). payment.recorded – только при PaymentLookup finance. Повтор – ничего. */
export function registerReserveHandlers(input: { bookings: ReserveBookings; payments?: PaymentLookup; clock?: Clock }): void {
  if (listSubscriptions().some((x) => x.name === RESERVE_HANDLERS.bookingConfirmed)) return;
  const deps = { bookings: input.bookings, clock: input.clock ?? systemClock, ...(input.payments ? { payments: input.payments } : {}) };
  subscribe('booking.confirmed', RESERVE_HANDLERS.bookingConfirmed, async (tx, e) => void (await convertReserves(tx, e.payload.clientId, deps)));
  subscribe('hold.expired', RESERVE_HANDLERS.holdExpired, async (tx, e) => {
    if (e.payload.clientId) {
      await openAccount(tx, e.payload.clientId, deps.clock.now());
      await settleStaleReserves(tx, e.payload.clientId, deps.clock.now());
    }
  });
  subscribe('booking.cancelled', RESERVE_HANDLERS.bookingCancelled, async (tx, e) => void (await reconcileBookingReserve(tx, e.payload.bookingId, deps)));
  subscribe('booking.rescheduled', RESERVE_HANDLERS.bookingRescheduled, async (tx, e) => void (await reconcileBookingReserve(tx, e.payload.bookingId, deps)));
  subscribe('no_show.marked', RESERVE_HANDLERS.noShowMarked, async (tx, e) => void (await reconcileBookingReserve(tx, e.payload.bookingId, deps)));
  if (input.payments) {
    subscribe('payment.recorded', RESERVE_HANDLERS.paymentRecorded, async (tx, e) => void (await reconcileBookingReserve(tx, e.payload.bookingId, deps)));
  }
}
