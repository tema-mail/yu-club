// Лента событий CRM (13 §11; S4-28, D4-46; таблицы 0420). Без push, почты и мессенджеров сотрудникам (Q-147 по умолчанию).
// Источники: обработчики outbox shift.changed (K18 §11) → адресно сотруднику смены; repair.registered / repair.closed (K19 §11) →
// зоне филиала с правом equipment.view; ошибка критичного сервисного клиенту (K21 §9) → зоне с notifications.view (триггер 0420);
// брони booking.confirmed / rescheduled / cancelled (K11) → зоне с schedule.view; resource_block.created (K6) → зоне с block.manage.
// Таймерные события (пустая смена, подготовка мероприятия, окончание гарантии) – staff-feed-events.ts, CHECK-списки – 0441.
// Каждый обработчик – в транзакции processEvent (processed_events гасит повторную доставку); dedupe_key '<kind>:<eventId>' UNIQUE
// гасит и повтор мимо processed_events. Видимость (K1): адресная строка – только адресату; строка зоны – по scopeFilter её права
// (роль и выданные права, сеть – всё); чужое – 404, как несуществующее. Прочтение – своё у каждого сотрудника (staff_feed_reads).
// Подключение: процесс worker вызывает registerStaffFeedHandlers(...) до startOutboxWorker (подписки замораживаются).
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { listSubscriptions, subscribe, type EventEnvelope, type Tx } from '../../core/outbox.ts';
import { branchScopeSql, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { formatLocal, isValidTimeZone, systemClock, type Clock, type TimeZone } from '../../core/time.ts';

export const FEED_HANDLERS = {
  shiftChanged: 'notifications.feedShiftChanged',
  repairRegistered: 'notifications.feedRepairRegistered',
  repairClosed: 'notifications.feedRepairClosed',
  bookingConfirmed: 'notifications.feedBookingConfirmed',
  bookingRescheduled: 'notifications.feedBookingRescheduled',
  bookingCancelled: 'notifications.feedBookingCancelled',
  blockCreated: 'notifications.feedBlockCreated',
} as const;

/** Права строк зоны (CHECK в 0420, расширен 0441). */
export const FEED_ACTIONS = ['equipment.view', 'notifications.view', 'schedule.view', 'block.manage', 'event.view', 'shift.manage'] as const;
export type FeedKind =
  | 'shift_changed' | 'repair_registered' | 'repair_closed' | 'service_notification_failed'
  | 'booking_created' | 'booking_rescheduled' | 'booking_cancelled' | 'block_created'
  | 'shift_unfilled' | 'event_preparation' | 'warranty_ending'; // три последних – таймеры staff-feed-events.ts
export type FeedRefType = 'shift' | 'repair' | 'client' | 'booking' | 'resource_block' | 'event' | 'equipment' | 'branch';

export interface FeedItem {
  id: string;
  kind: FeedKind;
  branchId: string;
  branchName: string;
  refType: FeedRefType;
  refId: string;
  title: string;
  body: string | null;
  occurredAt: string;
  read: boolean;
}
export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
  unread: number;
}

export interface FeedInsert {
  branchId: string;
  staffId: string | null;
  action: (typeof FEED_ACTIONS)[number] | null;
  kind: FeedKind;
  refType: FeedRefType;
  refId: string;
  title: string;
  body: string | null;
  dedupeKey: string;
  occurredAt: Date;
}

/** Строка ленты; повтор ключа – без изменений. true – вставлена (таймеры staff-feed-events.ts считают новые). */
export async function insertFeed(tx: Db, f: FeedInsert, now: Date): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO app.staff_feed_events (branch_id, staff_id, action, kind, ref_type, ref_id, title, body, dedupe_key, occurred_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (dedupe_key) DO NOTHING`,
    [f.branchId, f.staffId, f.action, f.kind, f.refType, f.refId, f.title.slice(0, 200), f.body?.slice(0, 500) ?? null, f.dedupeKey, f.occurredAt, now],
  );
  return (r.rowCount ?? 0) > 0;
}

const SHIFT_TITLE = { created: 'Вам назначена смена', updated: 'Ваша смена изменена', cancelled: 'Ваша смена отменена' } as const;
const PRIORITY = { critical: 'критичный', high: 'высокий', medium: 'средний', low: 'низкий' } as const;
const IMPACT = { none: 'без простоя', partial: 'частичный простой', full: 'полный простой' } as const;

function slotText(s: { start: string; end: string }, tz: string): string {
  const zone: TimeZone = isValidTimeZone(tz) ? tz : ('UTC' as TimeZone);
  return `${formatLocal(new Date(s.start), zone, 'datetime')}–${formatLocal(new Date(s.end), zone, 'time')}`;
}

/** shift.changed (K18 §11): правка смены не её сотрудником → адресно ему; «было/стало» по зоне филиала, причина – как ввёл автор. */
export async function onShiftChanged(tx: Tx, e: EventEnvelope<'shift.changed'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  if (p.changedBy === p.staffId) return; // свою смену сотрудник правил сам – сообщать нечего (K18 §5)
  const parts = [p.before ? `Было: ${slotText(p.before, p.branchTimezone)}` : null, p.after ? `Стало: ${slotText(p.after, p.branchTimezone)}` : null, p.reason ? `Причина: ${p.reason}` : null];
  await insertFeed(tx, {
    branchId: p.after?.branchId ?? p.branchId, staffId: p.staffId, action: null, kind: 'shift_changed', refType: 'shift', refId: p.shiftId,
    title: SHIFT_TITLE[p.kind], body: parts.filter(Boolean).join('. ') || null, dedupeKey: `shift_changed:${e.eventId}`, occurredAt: new Date(e.occurredAt),
  }, deps.clock.now());
}

/** repair.registered (K19 §11): новый ремонт – зоне филиала с equipment.view. */
export async function onRepairRegistered(tx: Tx, e: EventEnvelope<'repair.registered'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  await insertFeed(tx, {
    branchId: p.branchId, staffId: null, action: 'equipment.view', kind: 'repair_registered', refType: 'repair', refId: p.repairId,
    title: `Новый ремонт № ${p.number}`, body: `Приоритет ${PRIORITY[p.priority]}, ${IMPACT[p.impact]}${p.autoBlockId ? ', ресурс заблокирован' : ''}`,
    dedupeKey: `repair_registered:${e.eventId}`, occurredAt: new Date(e.occurredAt),
  }, deps.clock.now());
}

/** repair.closed (K19 §11): номер – из строки регистрации (в payload его нет); оставшиеся блокировки – напоминанием. */
export async function onRepairClosed(tx: Tx, e: EventEnvelope<'repair.closed'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  const reg = await tx.query<{ title: string }>(`SELECT title FROM app.staff_feed_events WHERE kind = 'repair_registered' AND ref_id = $1 LIMIT 1`, [p.repairId]);
  const number = reg.rows[0]?.title.replace(/^Новый ремонт /, '') ?? '';
  const left = p.stillBlockedIds.length;
  await insertFeed(tx, {
    branchId: p.branchId, staffId: null, action: 'equipment.view', kind: 'repair_closed', refType: 'repair', refId: p.repairId,
    title: `Ремонт ${number ? `${number} ` : ''}закрыт`, body: left > 0 ? `Остались блокировки: ${left} – снимите их в карточке ремонта` : null,
    dedupeKey: `repair_closed:${e.eventId}`, occurredAt: new Date(e.occurredAt),
  }, deps.clock.now());
}

// ---- брони (13 §11 «новая бронь или изменение записи», «отмена/перенос»; события K11) → зона филиала с schedule.view.
// Источник записи (сайт / CRM) – в тексте: лента общая для зоны, а не только для автора (в отличие от смены K18 §5).

const bookingBase = (p: { bookingId: string; branchId: string }) => ({ branchId: p.branchId, staffId: null, action: 'schedule.view' as const, refType: 'booking' as const, refId: p.bookingId });

/** booking.confirmed: сайт или администратор в CRM. */
export async function onBookingConfirmed(tx: Tx, e: EventEnvelope<'booking.confirmed'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  await insertFeed(tx, {
    ...bookingBase(p), kind: 'booking_created', title: `Новая запись № ${p.number}`,
    body: `${p.resourceName}, ${slotText(p, p.branchTimezone)}, ${p.source === 'site' ? 'с сайта' : 'из CRM'}`,
    dedupeKey: `booking_created:${e.eventId}`, occurredAt: new Date(e.occurredAt),
  }, deps.clock.now());
}

/** booking.rescheduled: было/стало по зоне филиала, новый ресурс. */
export async function onBookingRescheduled(tx: Tx, e: EventEnvelope<'booking.rescheduled'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  await insertFeed(tx, {
    ...bookingBase(p), kind: 'booking_rescheduled', title: `Перенос записи № ${p.number}`,
    body: `Было: ${slotText(p.previous, p.branchTimezone)}. Стало: ${slotText(p.current, p.branchTimezone)}, ${p.current.resourceName}`,
    dedupeKey: `booking_rescheduled:${e.eventId}`, occurredAt: new Date(e.occurredAt),
  }, deps.clock.now());
}

/** booking.cancelled: кто отменил; публичная причина – только у отмены клубом (K11). */
export async function onBookingCancelled(tx: Tx, e: EventEnvelope<'booking.cancelled'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  const who = p.cancelledBy === 'client' ? 'отменил клиент' : `отменил клуб${p.publicReason ? `: ${p.publicReason}` : ''}`;
  await insertFeed(tx, {
    ...bookingBase(p), kind: 'booking_cancelled', title: `Отмена записи № ${p.number}`, body: `${slotText(p, p.branchTimezone)}, ${who}`,
    dedupeKey: `booking_cancelled:${e.eventId}`, occurredAt: new Date(e.occurredAt),
  }, deps.clock.now());
}

/** resource_block.created (K6, 13 §11 «блокировка ресурса») → зона с block.manage. Блокировка ремонта (repair_blocks, K19) – пропуск:
 *  о ней уже сказала строка repair_registered («ресурс заблокирован»). Связь пишется в той же транзакции, что и блокировка. */
export async function onBlockCreated(tx: Tx, e: EventEnvelope<'resource_block.created'>, deps: { clock: Clock }): Promise<void> {
  const p = e.payload;
  const linked = await tx.query(`SELECT 1 FROM app.repair_blocks WHERE block_id = $1`, [p.blockId]);
  if ((linked.rowCount ?? 0) > 0) return;
  const tz = (await tx.query<{ timezone: string }>(`SELECT timezone FROM app.branches WHERE id = $1`, [p.branchId])).rows[0]?.timezone ?? 'UTC';
  const names = (await tx.query<{ name: string }>(
    `SELECT name FROM app.rooms WHERE id = ANY($1::uuid[]) UNION ALL SELECT name FROM app.resources WHERE id = ANY($1::uuid[])
     UNION ALL SELECT name FROM app.occupancy_units WHERE id = ANY($1::uuid[])`,
    [p.targetIds],
  )).rows.map((r) => r.name);
  const target = names.length > 3 ? `${names.slice(0, 3).join(', ')} и ещё ${names.length - 3}` : names.join(', ');
  await insertFeed(tx, {
    branchId: p.branchId, staffId: null, action: 'block.manage', kind: 'block_created', refType: 'resource_block', refId: p.blockId,
    title: `Блокировка ресурса: ${p.reasonName}`, body: `${target ? `${target}, ` : ''}${slotText(p, tz)}${p.comment ? `. ${p.comment}` : ''}`,
    dedupeKey: `block_created:${e.eventId}`, occurredAt: new Date(e.occurredAt),
  }, deps.clock.now());
}

/** Регистрация подписок ленты (один раз на процесс; повторный вызов ничего не делает). */
export function registerStaffFeedHandlers(deps: { clock?: Clock } = {}): void {
  if (listSubscriptions().some((s) => s.name === FEED_HANDLERS.shiftChanged)) return;
  const d = { clock: deps.clock ?? systemClock };
  subscribe('shift.changed', FEED_HANDLERS.shiftChanged, (tx, e) => onShiftChanged(tx, e, d));
  subscribe('repair.registered', FEED_HANDLERS.repairRegistered, (tx, e) => onRepairRegistered(tx, e, d));
  subscribe('repair.closed', FEED_HANDLERS.repairClosed, (tx, e) => onRepairClosed(tx, e, d));
  subscribe('booking.confirmed', FEED_HANDLERS.bookingConfirmed, (tx, e) => onBookingConfirmed(tx, e, d));
  subscribe('booking.rescheduled', FEED_HANDLERS.bookingRescheduled, (tx, e) => onBookingRescheduled(tx, e, d));
  subscribe('booking.cancelled', FEED_HANDLERS.bookingCancelled, (tx, e) => onBookingCancelled(tx, e, d));
  subscribe('resource_block.created', FEED_HANDLERS.blockCreated, (tx, e) => onBlockCreated(tx, e, d));
}

// ---- чтение и прочтение (API CRM: GET /staff-feed, /staff-feed/unread-count, POST /staff-feed/:id/read, /staff-feed/read-all)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Условие видимости строки f для сотрудника: адресная – ему; зоны – право строки в зоне филиала. Добавляет параметры. */
function visibleSql(ctx: AccessContext, params: unknown[]): string {
  params.push(ctx.actor.staffId);
  const parts = [`f.staff_id = $${params.length}::uuid`];
  for (const action of FEED_ACTIONS) {
    const scope = scopeFilter(ctx, action);
    if (scope.kind !== 'none') parts.push(`(f.action = '${action}' AND ${branchScopeSql('f.branch_id', scope, params)})`);
  }
  return `(${parts.join(' OR ')})`;
}

const unreadSql = (staffParam: number) => `NOT EXISTS (SELECT 1 FROM app.staff_feed_reads r WHERE r.event_id = f.id AND r.staff_id = $${staffParam}::uuid)`;

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}
function decodeCursor(s: string): { at: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as [string, string];
    const d = new Date(at);
    if (Number.isNaN(d.getTime()) || typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('cursor');
    return { at: d, id };
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
  }
}

/** Число непрочитанных видимых строк – для значка в шапке CRM. */
export async function feedUnreadCount(db: Db, ctx: AccessContext): Promise<number> {
  const params: unknown[] = [];
  const vis = visibleSql(ctx, params);
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.staff_feed_events f WHERE ${vis} AND ${unreadSql(1)}`, params);
  return r.rows[0]?.n ?? 0;
}

interface FeedRow {
  id: string; kind: FeedKind; branch_id: string; branch_name: string | null; ref_type: FeedRefType; ref_id: string;
  title: string; body: string | null; occurred_at: Date; read: boolean;
}

/** Страница ленты: порядок (occurred_at DESC, id DESC), limit 1..50; unreadOnly – только непрочитанные. */
export async function listStaffFeed(db: Db, ctx: AccessContext, opts: { cursor?: string | undefined; limit?: number | undefined; unreadOnly?: boolean | undefined } = {}): Promise<FeedPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 50);
  const params: unknown[] = [];
  const vis = visibleSql(ctx, params);
  const cond = [vis];
  if (opts.unreadOnly) cond.push(unreadSql(1));
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    params.push(c.at, c.id);
    cond.push(`(f.occurred_at, f.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const r = await db.query<FeedRow>(
    `SELECT f.id, f.kind, f.branch_id, b.name AS branch_name, f.ref_type, f.ref_id, f.title, f.body, f.occurred_at, NOT ${unreadSql(1)} AS read
     FROM app.staff_feed_events f LEFT JOIN app.branches b ON b.id = f.branch_id
     WHERE ${cond.join(' AND ')} ORDER BY f.occurred_at DESC, f.id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((x) => ({
      id: x.id, kind: x.kind, branchId: x.branch_id, branchName: x.branch_name ?? '', refType: x.ref_type, refId: x.ref_id,
      title: x.title, body: x.body, occurredAt: x.occurred_at.toISOString(), read: x.read,
    })),
    nextCursor: r.rows.length > limit && last ? encodeCursor(last.occurred_at, last.id) : null,
    unread: await feedUnreadCount(db, ctx),
  };
}

/** Прочтение одной строки. Чужая или несуществующая – NOT_FOUND (K1). Повтор – без изменений (время первого прочтения). */
export async function markFeedRead(db: Db, ctx: AccessContext, id: string, now: Date): Promise<void> {
  if (!UUID_RE.test(id)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const params: unknown[] = [];
  const vis = visibleSql(ctx, params);
  params.push(id.toLowerCase(), now);
  const r = await db.query<{ id: string }>(
    `WITH v AS (SELECT f.id FROM app.staff_feed_events f WHERE ${vis} AND f.id = $${params.length - 1}::uuid),
          ins AS (INSERT INTO app.staff_feed_reads (event_id, staff_id, read_at) SELECT v.id, $1::uuid, $${params.length} FROM v ON CONFLICT DO NOTHING)
     SELECT id FROM v`,
    params,
  );
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 404, 'Не найдено');
}

/** «Отметить все прочитанными»: видимые непрочитанные не новее before. Возвращает число отмеченных. */
export async function markAllFeedRead(db: Db, ctx: AccessContext, before: Date, now: Date): Promise<number> {
  const params: unknown[] = [];
  const vis = visibleSql(ctx, params);
  params.push(before, now);
  const r = await db.query(
    `INSERT INTO app.staff_feed_reads (event_id, staff_id, read_at)
     SELECT f.id, $1::uuid, $${params.length} FROM app.staff_feed_events f WHERE ${vis} AND f.occurred_at <= $${params.length - 1} AND ${unreadSql(1)}
     ON CONFLICT DO NOTHING`,
    params,
  );
  return r.rowCount ?? 0;
}
