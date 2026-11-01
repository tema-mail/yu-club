// K14. Планировщик уведомлений о брони (S1-15): расчёт моментов и плановые строки app.notifications.
// Привязка к событиям K4 (booking.confirmed / rescheduled / cancelled) – поток брони: его обработчики вызывают
// planBookingNotifications / skipPlannedForBooking в своей транзакции; внешних вызовов здесь нет (K4 п.4).
// Моменты: «накануне» – в notifications.reminder_day_before_time (21:00) по зоне филиала, «до начала» –
// за notifications.reminder_before_minutes (15) минут (K7, 09 §6.1–6.2). Момент уже прошёл к созданию брони –
// напоминание не создаётся: запись после 21:00 накануне получает только «за 15 минут» (R-17 по умолчанию).
// Текст – без лишних ПДн (09 §6.3): «Ю-Клуб», время по филиалу, филиал и ресурс, ссылка в ЛК.
import type { Tx } from '../../core/audit.ts';
import { resolveSettings } from '../../core/settings.ts';
import { formatLocal, parseLocalTime, reminderBeforeStart, reminderDayBefore, type LocalTime, type TimeZone } from '../../core/time.ts';

export type ReminderKind = 'reminder_day_before' | 'reminder_before_start';
export type BookingNotificationKind = 'booking_confirmed' | 'booking_cancelled' | 'booking_rescheduled' | ReminderKind;

export interface ReminderTimes {
  /** 'HH:mm' по зоне филиала, K7 notifications.reminder_day_before_time. */
  dayBeforeAt: LocalTime;
  /** K7 notifications.reminder_before_minutes. */
  beforeMinutes: number;
}

export interface PlannedMoment {
  kind: ReminderKind;
  plannedAt: Date;
}

/** Моменты напоминаний для сеанса, созданного (подтверждённого, перенесённого) в createdAt. Чистая функция. */
export function reminderMoments(start: Date, tz: TimeZone, createdAt: Date, times: ReminderTimes): PlannedMoment[] {
  const out: PlannedMoment[] = [];
  const dayBefore = reminderDayBefore(start, tz, times.dayBeforeAt, createdAt);
  if (dayBefore) out.push({ kind: 'reminder_day_before', plannedAt: dayBefore });
  const beforeStart = reminderBeforeStart(start, times.beforeMinutes, createdAt);
  if (beforeStart) out.push({ kind: 'reminder_before_start', plannedAt: beforeStart });
  return out;
}

/** Времена из K7 на момент события (сетевой уровень, значение на `at`). */
export async function reminderTimes(db: Tx, branchId: string, at: Date): Promise<ReminderTimes> {
  const s = await resolveSettings(
    db,
    ['notifications.reminder_day_before_time', 'notifications.reminder_before_minutes'],
    { branchId },
    at,
  );
  return {
    dayBeforeAt: parseLocalTime(s['notifications.reminder_day_before_time'].value),
    beforeMinutes: s['notifications.reminder_before_minutes'].value,
  };
}

/** Факты брони из события K4 (booking.confirmed / current у booking.rescheduled). */
export interface BookingFacts {
  bookingId: string;
  bookingVersion: number;
  clientId: string;
  branchId: string;
  branchTimezone: TimeZone;
  resourceName: string;
  start: Date;
  end: Date;
}

export interface NotificationDraft {
  kind: BookingNotificationKind;
  category: 'service' | 'reminder';
  plannedAt: Date;
  notAfter: Date | null;
  title: string;
  body: string;
  url: string;
}

export const ACCOUNT_BOOKINGS_URL = '/account/bookings/';

function place(branchName: string, resourceName: string): string {
  return `${branchName}, ${resourceName}`;
}

/** Тексты по виду (09 §6.3, §8). Время – только по зоне филиала (K8 formatLocal). */
export function draftText(
  kind: BookingNotificationKind,
  b: Pick<BookingFacts, 'branchTimezone' | 'resourceName' | 'start'>,
  branchName: string,
  previousStart?: Date,
): { title: string; body: string } {
  const when = formatLocal(b.start, b.branchTimezone, 'datetime');
  const where = place(branchName, b.resourceName);
  switch (kind) {
    case 'booking_confirmed':
      return { title: 'Ю-Клуб: запись подтверждена', body: `${when} – ${where}` };
    case 'booking_rescheduled': {
      const was = previousStart ? formatLocal(previousStart, b.branchTimezone, 'datetime') : null;
      return { title: 'Ю-Клуб: запись перенесена', body: was ? `Было: ${was}. Стало: ${when} – ${where}` : `Новое время: ${when} – ${where}` };
    }
    case 'booking_cancelled':
      return { title: 'Ю-Клуб: запись отменена клубом', body: `${when} – ${where}. Подробности в личном кабинете` };
    case 'reminder_day_before':
      return { title: 'Ю-Клуб: завтра у вас сеанс', body: `${when} – ${where}` };
    case 'reminder_before_start':
      return { title: 'Ю-Клуб: сеанс скоро начнётся', body: `В ${formatLocal(b.start, b.branchTimezone, 'time')} – ${where}` };
  }
}

/** dedupe_key = '<kind>:<bookingId>:<bookingVersion>' (K14): одно сообщение этапа на версию брони. */
export function dedupeKey(kind: BookingNotificationKind, bookingId: string, bookingVersion: number): string {
  return `${kind}:${bookingId}:${bookingVersion}`;
}

async function branchName(tx: Tx, branchId: string): Promise<string> {
  const r = await tx.query<{ name: string }>('SELECT name FROM app.branches WHERE id = $1', [branchId]);
  const name = r.rows[0]?.name;
  if (!name) throw new Error(`notifications: филиал ${branchId} не найден`);
  return name;
}

/** Черновики для подтверждённой (или перенесённой) брони: сервисное сообщение «сейчас» + напоминания. */
export function bookingDrafts(
  b: BookingFacts,
  now: Date,
  times: ReminderTimes,
  name: string,
  lead: { kind: 'booking_confirmed' | 'booking_rescheduled'; previousStart?: Date } | null,
): NotificationDraft[] {
  const drafts: NotificationDraft[] = [];
  if (lead) {
    drafts.push({
      kind: lead.kind,
      category: 'service',
      plannedAt: now,
      notAfter: b.end,
      url: ACCOUNT_BOOKINGS_URL,
      ...draftText(lead.kind, b, name, lead.previousStart),
    });
  }
  for (const m of reminderMoments(b.start, b.branchTimezone, now, times)) {
    // После начала сеанса напоминание не шлём (09 §6.2): not_after = start.
    drafts.push({ kind: m.kind, category: 'reminder', plannedAt: m.plannedAt, notAfter: b.start, url: ACCOUNT_BOOKINGS_URL, ...draftText(m.kind, b, name) });
  }
  return drafts;
}

const INSERT_SQL = `INSERT INTO app.notifications
  (client_id, branch_id, category, kind, booking_id, booking_version, source, title, body, url, planned_at, not_after, dedupe_key, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, 'system', $7, $8, $9, $10, $11, $12, $13, $13)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id`;

/** Вставка черновиков; повтор события не создаёт вторую строку (ON CONFLICT dedupe_key). Возвращает id новых. */
export async function insertDrafts(tx: Tx, b: BookingFacts, drafts: NotificationDraft[], now: Date): Promise<string[]> {
  const ids: string[] = [];
  for (const d of drafts) {
    const r = await tx.query<{ id: string }>(INSERT_SQL, [
      b.clientId,
      b.branchId,
      d.category,
      d.kind,
      b.bookingId,
      b.bookingVersion,
      d.title,
      d.body,
      d.url,
      d.plannedAt,
      d.notAfter,
      dedupeKey(d.kind, b.bookingId, b.bookingVersion),
      now,
    ]);
    if (r.rows[0]) ids.push(r.rows[0].id);
  }
  return ids;
}

/**
 * Интерфейс для потока брони (K14 onBookingConfirmed / onBookingRescheduled): в транзакции обработчика события.
 * lead – какое сервисное сообщение идёт сразу; null – только напоминания.
 */
export async function planBookingNotifications(
  tx: Tx,
  b: BookingFacts,
  now: Date,
  lead: { kind: 'booking_confirmed' | 'booking_rescheduled'; previousStart?: Date } | null = { kind: 'booking_confirmed' },
): Promise<string[]> {
  const [times, name] = await Promise.all([reminderTimes(tx, b.branchId, now), branchName(tx, b.branchId)]);
  return insertDrafts(tx, b, bookingDrafts(b, now, times, name, lead), now);
}

/** Сервисное «отменено клубом» (09 §3.1, §8): уходит независимо от настроек клиента. */
export async function planClubCancellation(tx: Tx, b: BookingFacts, now: Date): Promise<string[]> {
  const name = await branchName(tx, b.branchId);
  const text = draftText('booking_cancelled', b, name);
  return insertDrafts(tx, b, [{ kind: 'booking_cancelled', category: 'service', plannedAt: now, notAfter: null, url: ACCOUNT_BOOKINGS_URL, ...text }], now);
}

/** Перенос/отмена: плановые строки брони (кроме keepVersion) → skipped_booking_changed. Возвращает число. */
export async function skipPlannedForBooking(tx: Tx, bookingId: string, now: Date, keepVersion?: number): Promise<number> {
  const r = await tx.query(
    `UPDATE app.notifications SET status = 'skipped_booking_changed', skip_reason = 'booking_changed', updated_at = $2
     WHERE booking_id = $1 AND status IN ('planned','queued') AND ($3::int IS NULL OR booking_version <> $3)`,
    [bookingId, now, keepVersion ?? null],
  );
  return r.rowCount ?? 0;
}

/** Клиент выключил «Напоминания» (09 §5.4): запланированные напоминания → skipped_by_prefs; сервисные не трогаем. */
export async function skipRemindersForClient(tx: Tx, clientId: string, now: Date): Promise<number> {
  const r = await tx.query(
    `UPDATE app.notifications SET status = 'skipped_by_prefs', skip_reason = 'reminders_disabled', updated_at = $2
     WHERE client_id = $1 AND category = 'reminder' AND status IN ('planned','queued')`,
    [clientId, now],
  );
  return r.rowCount ?? 0;
}
