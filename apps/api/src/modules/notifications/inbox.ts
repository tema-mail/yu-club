// K21 §3: центр уведомлений в ЛК (09 §11; карта сайта /account/notifications/). Только чтение своих строк и отметка прочтения.
// Видно: planned_at <= $now и статус sent_to_provider / no_channel / error / inbox_only, не старше
// notifications.inbox_retention_days (Q-132) от coalesce(sent_at, planned_at). Не видно: planned / queued / sending (не наступило),
// cancelled, skipped_* (показывать нечего). Реклама при выключенной «Рекламе» не показывается (иначе отказ обходится центром).
// Состояние связанной брони читается у booking через провайдер (BookingLookup), не хранится.
// Открыть центр не значит прочитать: прочтение – по нажатию на сообщение или «Отметить все» (K21 §3).
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { resolveSetting } from '../../core/settings.ts';

export type InboxCategory = 'service' | 'reminder' | 'marketing';
export type InboxBookingState = 'active' | 'cancelled' | 'finished' | 'unavailable';

export interface InboxItem {
  id: string;
  title: string;
  body: string;
  category: InboxCategory;
  kind: string;
  at: string;
  read: boolean;
  url: string | null;
  booking: { id: string; state: InboxBookingState } | null;
}

/** Состояние брони у booking (реализация – booking/providers.ts bookingLookup). */
export interface InboxBookingLookup {
  snapshot(db: Db, bookingId: string): Promise<{ clientId: string; state: 'active' | 'cancelled' | 'finished' } | null>;
}

export interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null;
  unread: number;
}

/** Статусы, которые клиент видит в центре (K21 §3). */
export const INBOX_STATUSES = ['sent_to_provider', 'no_channel', 'error', 'inbox_only'] as const;
const STATUSES_SQL = `ARRAY['sent_to_provider','no_channel','error','inbox_only']`;

/** Общее условие видимости: $1 – клиент, $2 – $now, $3 – граница срока показа. */
const VISIBLE = `n.client_id = $1 AND n.status = ANY(${STATUSES_SQL}) AND n.planned_at <= $2
  AND coalesce(n.sent_at, n.planned_at) >= $3
  AND (n.category <> 'marketing' OR coalesce((SELECT p.marketing_enabled FROM app.client_notification_prefs p WHERE p.client_id = n.client_id), false))`;

async function retentionFrom(db: Db, now: Date): Promise<Date> {
  const days = (await resolveSetting(db, 'notifications.inbox_retention_days', { network: true }, now)).value;
  return new Date(now.getTime() - days * 86_400_000);
}

interface CursorPos {
  at: Date;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeInboxCursor(c: CursorPos): string {
  return Buffer.from(JSON.stringify([c.at.toISOString(), c.id])).toString('base64url');
}

export function decodeInboxCursor(s: string): CursorPos {
  try {
    const [at, id] = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as [string, string];
    const d = new Date(at);
    if (Number.isNaN(d.getTime()) || typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('cursor');
    return { at: d, id };
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
  }
}

interface Row {
  id: string;
  title: string;
  body: string;
  category: InboxCategory;
  kind: string;
  at: Date;
  read_at: Date | null;
  url: string | null;
  booking_id: string | null;
  client_id: string;
}

async function bookingState(db: Db, bookings: InboxBookingLookup | undefined, row: Row): Promise<InboxItem['booking']> {
  if (!row.booking_id) return null;
  const s = bookings ? await bookings.snapshot(db, row.booking_id) : null;
  // нет брони или она другого клиента (перепривязка) – «недоступна» (09 §11.2)
  const state: InboxBookingState = !s || s.clientId !== row.client_id ? 'unavailable' : s.state;
  return { id: row.booking_id, state };
}

/** Число непрочитанных видимых строк – для значка в шапке (K5 №202). */
export async function unreadCount(db: Db, clientId: string, now: Date): Promise<number> {
  const from = await retentionFrom(db, now);
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.notifications n WHERE ${VISIBLE} AND n.read_at IS NULL`, [clientId, now, from]);
  return r.rows[0]?.n ?? 0;
}

/** Страница центра (K5 №201): порядок (coalesce(sent_at, planned_at) DESC, id DESC), limit 1..50. */
export async function listInbox(
  db: Db,
  clientId: string,
  opts: { cursor?: string | undefined; limit?: number | undefined; now: Date; bookings?: InboxBookingLookup | undefined },
): Promise<InboxPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 50);
  const from = await retentionFrom(db, opts.now);
  const params: unknown[] = [clientId, opts.now, from];
  let after = '';
  if (opts.cursor) {
    const c = decodeInboxCursor(opts.cursor);
    params.push(c.at, c.id);
    after = `AND (coalesce(n.sent_at, n.planned_at), n.id) < ($4::timestamptz, $5::uuid)`;
  }
  params.push(limit + 1);
  const r = await db.query<Row>(
    `SELECT n.id, n.title, n.body, n.category, n.kind, coalesce(n.sent_at, n.planned_at) AS at, n.read_at, n.url, n.booking_id, n.client_id
     FROM app.notifications n WHERE ${VISIBLE} ${after}
     ORDER BY coalesce(n.sent_at, n.planned_at) DESC, n.id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const items: InboxItem[] = [];
  for (const row of rows) {
    items.push({
      id: row.id,
      title: row.title,
      body: row.body,
      category: row.category,
      kind: row.kind,
      at: row.at.toISOString(),
      read: row.read_at !== null,
      url: row.url,
      booking: await bookingState(db, opts.bookings, row),
    });
  }
  const last = rows.at(-1);
  const nextCursor = r.rows.length > limit && last ? encodeInboxCursor({ at: last.at, id: last.id }) : null;
  return { items, nextCursor, unread: await unreadCount(db, clientId, opts.now) };
}

/** Прочтение одной строки (K5 №203). Чужая, скрытая или несуществующая – NOT_FOUND. Повтор – без изменений. */
export async function markRead(db: Db, clientId: string, id: string, now: Date): Promise<void> {
  if (!UUID_RE.test(id)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const from = await retentionFrom(db, now);
  const r = await db.query<{ id: string }>(
    `UPDATE app.notifications n SET read_at = coalesce(n.read_at, $2) WHERE n.id = $4 AND ${VISIBLE} RETURNING n.id`,
    [clientId, now, from, id],
  );
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 404, 'Не найдено');
}

/** «Отметить все прочитанными» (K5 №204): видимые непрочитанные не новее before. Возвращает число отмеченных. */
export async function markAllRead(db: Db, clientId: string, before: Date, now: Date): Promise<number> {
  const from = await retentionFrom(db, now);
  const r = await db.query(
    `UPDATE app.notifications n SET read_at = $2 WHERE ${VISIBLE} AND n.read_at IS NULL AND coalesce(n.sent_at, n.planned_at) <= $4`,
    [clientId, now, from, before],
  );
  return r.rowCount ?? 0;
}
