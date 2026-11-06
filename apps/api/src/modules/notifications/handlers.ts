// K14 §Подписки: обработчики событий брони K4 → плановые строки уведомлений (reminders.ts). Каждый – в транзакции
// processEvent (processed_events гасит повторную доставку), без внешних вызовов. Порядок событий не гарантирован
// (K4 §Порядок): обработчик сверяется с текущим состоянием брони через BookingLookup (реализация – booking/providers.ts,
// таблица броней модулю notifications не принадлежит, ADR 0002 п.1) и устаревшее не планирует.
// S4-29 (K20 §12, K21 §2): event.cancelled и event.rescheduled → сервисное заказчику с профилем; без профиля – ничего (Q-116), общей аудитории – только кампанией (Q-143).
// dedupe_key = '<kind>:<eventId>:<version>': у отмены версия одна ('cancelled'), у переноса – id события outbox: он один на row_version мероприятия (K4, publish).
// Подключение: процесс worker вызывает registerNotificationHandlers(...) до startOutboxWorker (подписки замораживаются).
import type pg from 'pg';
import type { Tx } from '../../core/audit.ts';
import { listSubscriptions, subscribe, type EventEnvelope } from '../../core/outbox.ts';
import { formatLocal, systemClock, type Clock, type TimeZone } from '../../core/time.ts';
import { getBranch } from '../network/index.ts';
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
  eventCancelled: 'notifications.onEventCancelled',
  eventRescheduled: 'notifications.onEventRescheduled',
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

const EVENT_NOTICE_SQL = `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, dedupe_key, created_at, updated_at)
  VALUES ($1, $2, 'service', $3, 'system', $4, $5, $6, $7, $6, $6) ON CONFLICT (dedupe_key) DO NOTHING`;

const eventCancelKey = (eventId: string): string => `event_cancelled:${eventId}:cancelled`;

/** event.cancelled: сервисное заказчику с профилем. Причина – служебный текст сотрудника, в сообщение клиенту не идёт. */
export async function onEventCancelled(tx: Tx, e: EventEnvelope<'event.cancelled'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  if (!p.customerClientId) return;
  const branch = await getBranch(tx, p.branchId);
  const body = `${branch ? `${branch.name}. ` : ''}Подробности уточнит администратор клуба`;
  await tx.query(EVENT_NOTICE_SQL, [p.customerClientId, p.branchId, 'event_cancelled', 'Ю-Клуб: мероприятие отменено', body, deps.clock.now(), eventCancelKey(p.eventId)]);
}

/** event.rescheduled: «было/стало» по зоне филиала. Порядок событий не гарантирован (K4): дошедший после отмены перенос не пишет. */
export async function onEventRescheduled(tx: Tx, e: EventEnvelope<'event.rescheduled'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  if (!p.customerClientId) return;
  const done = await tx.query('SELECT 1 FROM app.notifications WHERE dedupe_key = $1', [eventCancelKey(p.eventId)]);
  if ((done.rowCount ?? 0) > 0) return;
  const branch = await getBranch(tx, p.branchId);
  if (!branch) return;
  const at = (iso: string) => formatLocal(new Date(iso), branch.timezone, 'datetime');
  const body = `Было: ${at(p.previous.start)}. Стало: ${at(p.current.start)} – ${branch.name}`;
  await tx.query(EVENT_NOTICE_SQL, [p.customerClientId, p.branchId, 'event_rescheduled', 'Ю-Клуб: мероприятие перенесено', body, deps.clock.now(), `event_rescheduled:${p.eventId}:${e.eventId}`]);
}

/** Регистрация подписок K14 (один раз на процесс; повторный вызов ничего не делает). */
export function registerNotificationHandlers(deps: { bookings: BookingFactsLookup; clock?: Clock }): void {
  if (listSubscriptions().some((s) => s.name === HANDLERS.confirmed)) return;
  const d = { bookings: deps.bookings, clock: deps.clock ?? systemClock };
  subscribe('booking.confirmed', HANDLERS.confirmed, (tx, e) => onBookingConfirmed(tx, e, d));
  subscribe('booking.rescheduled', HANDLERS.rescheduled, (tx, e) => onBookingRescheduled(tx, e, d));
  subscribe('booking.cancelled', HANDLERS.cancelled, (tx, e) => onBookingCancelled(tx, e, d));
  subscribe('event.cancelled', HANDLERS.eventCancelled, (tx, e) => onEventCancelled(tx, e, d));
  subscribe('event.rescheduled', HANDLERS.eventRescheduled, (tx, e) => onEventRescheduled(tx, e, d));
  subscribe('client.notification_prefs_changed', HANDLERS.prefs, async (tx, e) => {
    if (!e.payload.remindersEnabled) await skipRemindersForClient(tx, e.payload.clientId, d.clock.now());
  });
}
