// K21 §9: журнал отправок CRM (фильтры 09 §12.2), блок в карточке клиента (09 §12.3), ручной повтор критичного сервисного (09 §10).
// Видимость: строки – по branch_id в пределах scopeFilter(notifications.view), строка без филиала – только зона сети;
// кампании – по области (сетевую видит только Владелец). Чужое – как несуществующее. Endpoint и ключи подписок наружу не отдаются.
// Повтор: новая строка с retry_of, исходная не меняется (журнал); реклама не повторяется – иначе ручной обход частоты.
// В аудит повтора текст не пишется: в нём может быть подставленное имя (K21 §15).
import { objectTimeline, writeAudit, type AuditEventRow, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, runIdempotent, type IdempotentResult } from '../../core/idempotency.ts';
import { assertCan, branchScopeSql, roleAllows, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import type { Clock } from '../../core/time.ts';
import { withTx, type Pool } from '../clients/index.ts';
import { campaignDto, campaignInZone, type CampaignDto, type CampaignRow, type CampaignStatus } from './campaigns.ts';

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const forbidden = (action: string) => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decodeCursor(s: string): { at: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as [string, string];
    const d = new Date(at);
    if (Number.isNaN(d.getTime()) || !UUID_RE.test(id)) throw new Error('cursor');
    return { at: d, id };
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
  }
}

export interface CampaignCounters {
  sent: number;
  inboxOnly: number;
  excluded: number;
  error: number;
}
export type CampaignListRow = CampaignDto & { counters: CampaignCounters };
export interface CampaignFilters {
  from?: Date | undefined;
  to?: Date | undefined;
  branchId?: string | undefined;
  category?: 'service' | 'marketing' | undefined;
  source?: 'system' | 'staff' | undefined;
  authorId?: string | undefined;
  status?: CampaignStatus | undefined;
  clientId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

const CAMPAIGN_COLUMNS = `c.id, c.status, c.purpose, c.category, c.title, c.body, c.url, c.push, c.audience, c.area_type, c.area_ids, c.planned_at, c.advertiser_note, c.erid, c.template_id,
  c.preview_snapshot, c.preview_at, c.total, c.created_by, c.created_at, c.confirmed_by, c.confirmed_at, c.cancelled_reason, c.row_version`;

async function countersOf(db: Db, ids: string[]): Promise<Map<string, { sent: number; inbox: number; error: number; rows: number }>> {
  const r = await db.query<{ campaign_id: string; sent: number; inbox: number; error: number; rows: number }>(
    `SELECT campaign_id,
       count(*) FILTER (WHERE status = 'sent_to_provider')::int AS sent,
       count(*) FILTER (WHERE status IN ('no_channel','inbox_only'))::int AS inbox,
       count(*) FILTER (WHERE status = 'error')::int AS error,
       count(*)::int AS rows
     FROM app.notifications WHERE campaign_id = ANY($1::uuid[]) AND retry_of IS NULL GROUP BY campaign_id`,
    [ids],
  );
  return new Map(r.rows.map((x) => [x.campaign_id, x]));
}

/** Исключено = снимок минус ещё не решённые: пропущенные при отправке и те, кому строка не создана. */
function counters(row: CampaignRow, c: { sent: number; inbox: number; error: number; rows: number } | undefined, pending: number): CampaignCounters {
  const sent = c?.sent ?? 0;
  const inboxOnly = c?.inbox ?? 0;
  const error = c?.error ?? 0;
  return { sent, inboxOnly, error, excluded: Math.max(0, (row.total ?? 0) - sent - inboxOnly - error - pending) };
}

async function pendingOf(db: Db, ids: string[]): Promise<Map<string, number>> {
  const r = await db.query<{ campaign_id: string; n: number }>(
    `SELECT campaign_id, count(*)::int AS n FROM app.notifications WHERE campaign_id = ANY($1::uuid[]) AND status IN ('planned','queued','sending') AND retry_of IS NULL GROUP BY campaign_id`,
    [ids],
  );
  return new Map(r.rows.map((x) => [x.campaign_id, x.n]));
}

/** K11 №201. Фильтр зоны – в SQL. */
export async function listCampaigns(db: Db, ctx: AccessContext, f: CampaignFilters): Promise<Page<CampaignListRow>> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 100);
  if (!roleAllows(ctx.role, 'notifications.view')) return { items: [], nextCursor: null };
  if (f.source === 'system') return { items: [], nextCursor: null }; // кампании всегда от сотрудника; системные – в списке строк
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (!ctx.network) {
    where.push(`((c.area_type = 'branch' AND c.area_ids <@ ${p([...ctx.branchIds])}::uuid[]) OR (c.area_type = 'city' AND c.area_ids <@ ${p([...ctx.cityIds])}::uuid[]))`);
  }
  if (f.from) where.push(`c.created_at >= ${p(f.from)}`);
  if (f.to) where.push(`c.created_at < ${p(f.to)}`);
  if (f.branchId) where.push(`c.area_ids @> ARRAY[${p(f.branchId)}::uuid]`);
  if (f.category) where.push(`c.category = ${p(f.category)}`);
  if (f.authorId) where.push(`c.created_by = ${p(f.authorId)}`);
  if (f.status) where.push(`c.status = ${p(f.status)}`);
  if (f.clientId) where.push(`EXISTS (SELECT 1 FROM journal.notification_campaign_recipients r WHERE r.campaign_id = c.id AND r.client_id = ${p(f.clientId)})`);
  if (f.cursor) {
    const cur = decodeCursor(f.cursor);
    where.push(`(c.created_at, c.id) < (${p(cur.at)}::timestamptz, ${p(cur.id)}::uuid)`);
  }
  const r = await db.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM app.notification_campaigns c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.created_at DESC, c.id DESC LIMIT ${p(limit + 1)}`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const ids = rows.map((x) => x.id);
  const [cnt, pending] = await Promise.all([countersOf(db, ids), pendingOf(db, ids)]);
  const last = rows.at(-1);
  return {
    items: rows.map((x) => ({ ...campaignDto(x), counters: counters(x, cnt.get(x.id), pending.get(x.id) ?? 0) })),
    nextCursor: r.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** K11 №203: кампания, счётчики и история. Вне зоны – NOT_FOUND. */
export async function getCampaignDetail(db: Db, ctx: AccessContext, id: string): Promise<CampaignListRow & { timeline: AuditEventRow[] }> {
  if (!UUID_RE.test(id)) throw notFound();
  const r = await db.query<CampaignRow>(`SELECT ${CAMPAIGN_COLUMNS} FROM app.notification_campaigns c WHERE c.id = $1`, [id]);
  const row = r.rows[0];
  if (!row || !campaignInZone(ctx, row)) throw notFound();
  const [cnt, pending, timeline] = await Promise.all([countersOf(db, [id]), pendingOf(db, [id]), objectTimeline(db, { objectType: 'notification_campaign', objectId: id }, { limit: 100 })]);
  return { ...campaignDto(row), counters: counters(row, cnt.get(id), pending.get(id) ?? 0), timeline: timeline.items };
}

export interface NotificationView {
  id: string;
  clientId: string;
  branchId: string | null;
  category: string;
  kind: string;
  bookingId: string | null;
  source: string;
  initiatorId: string | null;
  title: string;
  body: string;
  url: string | null;
  plannedAt: string;
  sentAt: string | null;
  status: string;
  skipReason: string | null;
  error: string | null;
  attempts: number;
  campaignId: string | null;
  retryOf: string | null;
  purpose: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationRow {
  id: string;
  client_id: string;
  branch_id: string | null;
  category: string;
  kind: string;
  booking_id: string | null;
  source: string;
  initiator_id: string | null;
  title: string;
  body: string;
  url: string | null;
  planned_at: Date;
  sent_at: Date | null;
  status: string;
  skip_reason: string | null;
  error: string | null;
  attempts: number;
  campaign_id: string | null;
  retry_of: string | null;
  purpose: string | null;
  read_at: Date | null;
  created_at: Date;
}

const NOTIFICATION_COLUMNS = `id, client_id, branch_id, category, kind, booking_id, source, initiator_id, title, body, url, planned_at, sent_at, status, skip_reason, error, attempts,
  campaign_id, retry_of, purpose, read_at, created_at`;

const view = (r: NotificationRow): NotificationView => ({
  id: r.id,
  clientId: r.client_id,
  branchId: r.branch_id,
  category: r.category,
  kind: r.kind,
  bookingId: r.booking_id,
  source: r.source,
  initiatorId: r.initiator_id,
  title: r.title,
  body: r.body,
  url: r.url,
  plannedAt: r.planned_at.toISOString(),
  sentAt: r.sent_at?.toISOString() ?? null,
  status: r.status,
  skipReason: r.skip_reason,
  error: r.error,
  attempts: r.attempts,
  campaignId: r.campaign_id,
  retryOf: r.retry_of,
  purpose: r.purpose,
  readAt: r.read_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export interface NotificationFilters {
  clientId?: string | undefined;
  bookingId?: string | undefined;
  branchId?: string | undefined;
  status?: string | undefined;
  category?: string | undefined;
  kind?: string | undefined;
  source?: 'system' | 'staff' | undefined;
  /** Строки одной рассылки (S4-80: ссылка «строки отправки» из карточки кампании). Индекс notifications_campaign_idx (0402). */
  campaignId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** K11 №208: строки журнала. Без филиала видит только зона сети (branchScopeSql: NULL = ANY не проходит). */
export async function listNotifications(db: Db, ctx: AccessContext, f: NotificationFilters): Promise<Page<NotificationView>> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 100);
  const params: unknown[] = [];
  const where: string[] = [branchScopeSql('branch_id', scopeFilter(ctx, 'notifications.view'), params)];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.clientId) where.push(`client_id = ${p(f.clientId)}`);
  if (f.bookingId) where.push(`booking_id = ${p(f.bookingId)}`);
  if (f.branchId) where.push(`branch_id = ${p(f.branchId)}`);
  if (f.status) where.push(`status = ${p(f.status)}`);
  if (f.category) where.push(`category = ${p(f.category)}`);
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.source) where.push(`source = ${p(f.source)}`);
  if (f.campaignId) where.push(`campaign_id = ${p(f.campaignId)}`);
  if (f.from) where.push(`planned_at >= ${p(f.from)}`);
  if (f.to) where.push(`planned_at < ${p(f.to)}`);
  if (f.cursor) {
    const cur = decodeCursor(f.cursor);
    where.push(`(planned_at, id) < (${p(cur.at)}::timestamptz, ${p(cur.id)}::uuid)`);
  }
  const r = await db.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM app.notifications WHERE ${where.join(' AND ')} ORDER BY planned_at DESC, id DESC LIMIT ${p(limit + 1)}`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const last = rows.at(-1);
  return { items: rows.map(view), nextCursor: r.rows.length > limit && last ? encodeCursor(last.planned_at, last.id) : null };
}

export interface ClientNotificationSummary {
  marketing: { enabled: boolean; changedAt: string | null; source: string | null };
  reminders: { enabled: boolean; changedAt: string | null };
  push: { activeDevices: number };
  recent: NotificationView[];
}

/** K11 №212 (09 §12.3): нужны notifications.view и client.view.basic; клиент вне зоны – NOT_FOUND. Endpoint и ключи не отдаются. */
export async function clientNotificationSummary(db: Db, ctx: AccessContext, clientId: string): Promise<ClientNotificationSummary> {
  if (!roleAllows(ctx.role, 'notifications.view')) throw forbidden('notifications.view');
  if (!roleAllows(ctx.role, 'client.view.basic')) throw forbidden('client.view.basic');
  if (!UUID_RE.test(clientId)) throw notFound();
  const known = await db.query(
    `SELECT 1 FROM app.clients c WHERE c.id = $1 AND ($2::boolean OR EXISTS (SELECT 1 FROM app.bookings b WHERE b.client_id = c.id AND b.branch_id = ANY($3::uuid[])))`,
    [clientId, ctx.network, [...ctx.branchIds]],
  );
  if (!known.rowCount) throw notFound();
  const prefs = (await db.query<{ reminders_enabled: boolean; marketing_enabled: boolean }>('SELECT reminders_enabled, marketing_enabled FROM app.client_notification_prefs WHERE client_id = $1', [clientId])).rows[0];
  const consent = async (kind: string) =>
    (await db.query<{ at: Date; source: string }>(`SELECT at, source FROM journal.client_consents WHERE client_id = $1 AND kind = $2 ORDER BY at DESC, id DESC LIMIT 1`, [clientId, kind])).rows[0];
  const [marketing, reminders, subs, recent] = await Promise.all([
    consent('marketing'),
    consent('reminders'),
    db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.push_subscriptions WHERE client_id = $1 AND revoked_at IS NULL', [clientId]),
    listNotifications(db, ctx, { clientId, limit: 20 }),
  ]);
  return {
    marketing: { enabled: prefs?.marketing_enabled ?? false, changedAt: marketing?.at.toISOString() ?? null, source: marketing?.source ?? null },
    reminders: { enabled: prefs?.reminders_enabled ?? true, changedAt: reminders?.at.toISOString() ?? null },
    push: { activeDevices: subs.rows[0]?.n ?? 0 },
    recent: recent.items,
  };
}

export const RETRY_ROUTE = 'POST /api/crm/v1/notifications/:id/retry';

/** K11 №209. Новая строка с retry_of; исходная не меняется. Реклама и не error/no_channel → RETRY_NOT_ALLOWED. */
export async function retryNotification(pool: Pool, clock: Clock, ctx: AccessContext, meta: AuditRequestMeta, id: string, input: { reason: string }, key: string): Promise<IdempotentResult> {
  const reason = input.reason?.trim();
  if (!reason) throw new AppError('VALIDATION_FAILED', 400, 'Укажите причину повтора', { field: 'reason' });
  if (!UUID_RE.test(id)) throw notFound();
  return withTx(pool, (tx) =>
    runIdempotent(tx, { scope: idempotencyScope('staff', ctx.actor.staffId, RETRY_ROUTE), key, request: { route: RETRY_ROUTE, params: { id }, body: input }, clock }, async () => {
      const now = clock.now();
      const src = (await tx.query<NotificationRow & { booking_version: number | null; dedupe_key: string }>(`SELECT ${NOTIFICATION_COLUMNS}, booking_version, dedupe_key FROM app.notifications WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!src) throw notFound();
      assertCan(ctx, 'notifications.retry', src.branch_id ? { branchId: src.branch_id } : { network: true });
      if (src.category !== 'service' || (src.status !== 'error' && src.status !== 'no_channel')) {
        throw new AppError('RETRY_NOT_ALLOWED', 409, 'Повторить можно только сервисное сообщение с ошибкой или без канала');
      }
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.notifications WHERE retry_of = $1', [id])).rows[0]!.n + 1;
      const r = await tx.query<NotificationRow>(
        `INSERT INTO app.notifications (client_id, branch_id, category, kind, booking_id, booking_version, source, initiator_id, title, body, url, planned_at, status, push, campaign_id, retry_of, purpose, dedupe_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'staff', $7, $8, $9, $10, $11, 'planned', true, $12, $13, $14, $15, $11, $11) RETURNING ${NOTIFICATION_COLUMNS}`,
        [src.client_id, src.branch_id, src.category, src.kind, src.booking_id, src.booking_version, ctx.actor.staffId, src.title, src.body, src.url, now, src.campaign_id, id, src.purpose, `${src.dedupe_key}:retry:${n}`],
      );
      const row = r.rows[0]!;
      await writeAudit(tx, meta, { action: 'notification.retried', object: { type: 'notification', id: row.id }, branchId: src.branch_id, reason, after: { retryOf: id, kind: src.kind } }, clock);
      return { status: 201, body: view(row) };
    }),
  );
}
