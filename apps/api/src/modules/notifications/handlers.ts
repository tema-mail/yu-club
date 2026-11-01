// K14 §Подписки: обработчики событий брони K4 → плановые строки уведомлений (reminders.ts). Каждый – в транзакции
// processEvent (processed_events гасит повторную доставку), без внешних вызовов. Порядок событий не гарантирован
// (K4 §Порядок): обработчик сверяется с текущим состоянием брони через BookingLookup (реализация – booking/providers.ts,
// таблица броней модулю notifications не принадлежит, ADR 0002 п.1) и устаревшее не планирует.
// Подключение: процесс worker вызывает registerNotificationHandlers(...) до startOutboxWorker (подписки замораживаются).
import type pg from 'pg';
import type { Tx } from '../../core/audit.ts';
import { listSubscriptions, subscribe, type EventEnvelope } from '../../core/outbox.ts';
import { systemClock, type Clock, type TimeZone } from '../../core/time.ts';
import { planBookingNotifications, planClubCancellation, skipPlannedForBooking, skipRemindersForClient, type BookingFacts } from './reminders.ts';
import type { BookingLookup } from './sender.ts';

/** Факты брони для текста отмены (в payload booking.cancelled нет названия ресурса). */
export interface BookingFactsLookup extends BookingLookup {
  facts(tx: pg.ClientBase, bookingId: string): Promise<BookingFacts | null>;
}

export const HANDLERS = {
  confirmed: 'notifications.onBookingConfirmed',
  rescheduled: 'notifications.onBookingRescheduled',
  cancelled: 'notifications.onBookingCancelled',
  prefs: 'notifications.onPrefsChanged',
} as const;

const client = (tx: Tx) => tx as unknown as pg.ClientBase;

/** booking.confirmed: подтверждение + напоминания, если бронь всё ещё v1 и действует. */
export async function onBookingConfirmed(tx: Tx, e: EventEnvelope<'booking.confirmed'>, deps: { bookings: BookingFactsLookup; clock: Clock }): Promise<void> {
  const p = e.payload;
  const s = await deps.bookings.snapshot(client(tx), p.bookingId);
  if (!s || s.state !== 'active' || s.version !== p.bookingVersion) return; // уже перенесена или отменена – план даст её событие
  const facts: BookingFacts = {
    bookingId: p.bookingId, bookingVersion: p.bookingVersion, clientId: p.clientId, branchId: p.branchId, branchTimezone: p.branchTimezone as TimeZone,
    resourceName: p.resourceName, start: new Date(p.start), end: new Date(p.end),
  };
  await planBookingNotifications(tx, facts, deps.clock.now(), { kind: 'booking_confirmed' });
}

/** booking.rescheduled: плановые строки прежних версий → skipped; «было/стало» и напоминания для текущей версии. */
export async function onBookingRescheduled(tx: Tx, e: EventEnvelope<'booking.rescheduled'>, deps: { bookings: BookingFactsLookup; clock: Clock }): Promise<void> {
  const p = e.payload;
  const now = deps.clock.now();
  const s = await deps.bookings.snapshot(client(tx), p.bookingId);
  if (!s) return;
  await skipPlannedForBooking(tx, p.bookingId, now, s.state === 'active' ? s.version : undefined);
  if (s.state !== 'active' || s.version !== p.current.version) return; // есть более новая версия – её событие спланирует
  const facts: BookingFacts = {
    bookingId: p.bookingId, bookingVersion: p.current.version, clientId: p.clientId, branchId: p.branchId, branchTimezone: p.branchTimezone as TimeZone,
    resourceName: p.current.resourceName, start: new Date(p.current.start), end: new Date(p.current.end),
  };
  await planBookingNotifications(tx, facts, now, { kind: 'booking_rescheduled', previousStart: new Date(p.previous.start) });
}

/** booking.cancelled: все плановые строки брони → skipped; отмена клубом – сервисное сообщение независимо от настроек. */
export async function onBookingCancelled(tx: Tx, e: EventEnvelope<'booking.cancelled'>, deps: { bookings: BookingFactsLookup; clock: Clock }): Promise<void> {
  const p = e.payload;
  const now = deps.clock.now();
  await skipPlannedForBooking(tx, p.bookingId, now);
  if (p.cancelledBy !== 'club') return; // клиент отменил сам – видит в ЛК (K14, решение)
  const facts = await deps.bookings.facts(client(tx), p.bookingId);
  if (facts) await planClubCancellation(tx, facts, now);
}

/** Регистрация подписок K14 (один раз на процесс; повторный вызов ничего не делает). */
export function registerNotificationHandlers(deps: { bookings: BookingFactsLookup; clock?: Clock }): void {
  if (listSubscriptions().some((s) => s.name === HANDLERS.confirmed)) return;
  const d = { bookings: deps.bookings, clock: deps.clock ?? systemClock };
  subscribe('booking.confirmed', HANDLERS.confirmed, (tx, e) => onBookingConfirmed(tx, e, d));
  subscribe('booking.rescheduled', HANDLERS.rescheduled, (tx, e) => onBookingRescheduled(tx, e, d));
  subscribe('booking.cancelled', HANDLERS.cancelled, (tx, e) => onBookingCancelled(tx, e, d));
  subscribe('client.notification_prefs_changed', HANDLERS.prefs, async (tx, e) => {
    if (!e.payload.remindersEnabled) await skipRemindersForClient(tx, e.payload.clientId, d.clock.now());
  });
}
