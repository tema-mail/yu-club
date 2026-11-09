// HTTP /api/crm/v1 (K21 §11, K11 №201–212): кампании, журнал отправок, ручной повтор, шаблоны, сводка клиента. Тонкий слой (ADR 0002 п.7):
// Zod-разбор → функции модуля → AppError в ответ. Вход сотрудника (authenticate) передаёт server.ts.
// Изменяющие – с Idempotency-Key; PATCH кампании – без ключа, повтор останавливает row_version (K21 §6, K11). Предпросмотр по контракту – чтение.
// Отказ по правам (403) пишется в аудит отдельной транзакцией (ADR 0005 п.8). Чужой объект – 404 внутри функций модуля (K1).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeDenied, type AuditAction, type AuditObjectType, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { requireIdempotencyKey, type IdempotentResult } from '../../core/idempotency.ts';
import { roleAllows, type AccessContext, type NetworkLookup } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import type { Pool } from '../clients/index.ts';
import { cancelCampaign, confirmCampaign, createCampaign, inZone, previewCampaign, updateCampaign, type CampaignBookingLookup, type CampaignDeps, type CampaignInput } from './campaigns.ts';
import { clientNotificationSummary, getCampaignDetail, listCampaigns, listNotifications, retryNotification } from './journal.ts';
import { feedUnreadCount, listStaffFeed, markAllFeedRead, markFeedRead } from './staff-feed.ts';
import { createTemplate, listTemplates, updateTemplate } from './templates.ts';

export interface NotificationCrmDeps {
  pool: Pool;
  clock?: Clock;
  network: NetworkLookup;
  bookings: CampaignBookingLookup;
  unsubscribeSecret?: string | null;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
}

const uuid = z.uuid();
const category = z.enum(['service', 'marketing']);
const when = z.iso.datetime({ offset: true });
const page = { cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).optional() };
const campaignQuery = z.object({
  from: when.optional(),
  to: when.optional(),
  branchId: uuid.optional(),
  category: category.optional(),
  source: z.enum(['system', 'staff']).optional(),
  authorId: uuid.optional(),
  status: z.enum(['draft', 'confirmed', 'expanding', 'sending', 'done', 'cancelled']).optional(),
  clientId: uuid.optional(),
  ...page,
});
const notificationQuery = z.object({
  clientId: uuid.optional(),
  bookingId: uuid.optional(),
  branchId: uuid.optional(),
  status: z.string().max(32).optional(),
  category: z.enum(['service', 'reminder', 'marketing']).optional(),
  kind: z.string().max(32).optional(),
  source: z.enum(['system', 'staff']).optional(),
  from: when.optional(),
  to: when.optional(),
  ...page,
});
const audience = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('client'), clientId: uuid, bookingId: uuid.optional(), branchId: uuid.optional() }).strict(),
  z.object({ kind: z.literal('booking'), bookingId: uuid }).strict(),
  z.object({ kind: z.literal('segment'), segment: z.unknown() }).strict(), // segment.v1 разбирает модуль: ошибка – SEGMENT_INVALID
]);
const text = {
  purpose: z.string().trim().max(200).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(500).optional(),
  url: z.string().regex(/^\/([^/\\]|$)/).max(500).nullable().optional(),
  plannedAt: when.nullable().optional(),
  push: z.boolean().optional(),
  advertiserNote: z.string().trim().max(200).nullable().optional(),
  erid: z.string().trim().min(1).max(64).nullable().optional(),
};
const createBody = z.object({ category: category.optional(), templateId: uuid.optional(), audience, ...text });
const patchBody = z.object({ rowVersion: z.number().int().min(1), category: category.optional(), audience: audience.optional(), ...text });
const confirmBody = z.object({ rowVersion: z.number().int().min(1), expectedTotal: z.number().int().min(0).optional() });
const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) });
const templateCreate = z.object({ name: z.string().trim().min(1).max(120), category, title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(500) });
const templatePatch = z.object({
  rowVersion: z.number().int().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(500).optional(),
  status: z.enum(['active', 'archived']).optional(),
});
const templateQuery = z.object({ status: z.enum(['active', 'archived']).optional() });
const feedQuery = z.object({ cursor: page.cursor, limit: z.coerce.number().int().min(1).max(50).optional(), unread: z.enum(['true', 'false']).optional() });
const feedReadAll = z.object({ before: when });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/** Id из пути: не UUID – как несуществующий (K1), а не ошибка базы. */
function idOf(request: FastifyRequest): string {
  const id = (request.params as { id?: string }).id ?? '';
  if (!uuid.safeParse(id).success) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  return id.toLowerCase();
}

const dateOf = (s: string | undefined) => (s ? new Date(s) : undefined);

function send(reply: FastifyReply, r: IdempotentResult) {
  if (r.replayed) reply.header('idempotent-replay', 'true');
  return reply.code(r.status).send(r.body);
}

export async function notificationCrmRoutes(app: FastifyInstance, deps: NotificationCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const campaign: CampaignDeps = { pool: deps.pool, clock, network: deps.network, bookings: deps.bookings, unsubscribeSecret: deps.unsubscribeSecret ?? null };

  /** 403 команды → запись отказа в аудит (ADR 0005 п.8), ответ остаётся 403. */
  const denied = async <T>(meta: AuditRequestMeta, action: AuditAction, object: { type: AuditObjectType; id: string | null }, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        await writeDenied(deps.pool, meta, { action, object, reason: `${err.code}: ${String(err.details?.action ?? '')}`, result: 'denied' }, clock);
      }
      throw err;
    }
  };

  const assertBranchFilter = (access: AccessContext, branchId: string | undefined): void => {
    if (branchId && !inZone(access, branchId)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  };

  // №201
  app.get('/notifications/campaigns', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = parse(campaignQuery, request.query);
    assertBranchFilter(access, q.branchId);
    return listCampaigns(deps.pool, access, { ...q, from: dateOf(q.from), to: dateOf(q.to) });
  });

  // №202
  app.post('/notifications/campaigns', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(createBody, request.body) as CampaignInput;
    return send(reply, await denied(meta, 'notification.campaign_created', { type: 'notification_campaign', id: null }, () => createCampaign(campaign, access, meta, body, key)));
  });

  // №203
  app.get('/notifications/campaigns/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return getCampaignDetail(deps.pool, access, idOf(request));
  });

  // №204
  app.patch('/notifications/campaigns/:id', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const id = idOf(request);
    const body = parse(patchBody, request.body) as Partial<CampaignInput> & { rowVersion: number };
    return denied(meta, 'notification.campaign_updated', { type: 'notification_campaign', id }, () => updateCampaign(campaign, access, meta, id, body));
  });

  // №205
  app.post('/notifications/campaigns/:id/preview', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const id = idOf(request);
    return denied(meta, 'notification.campaign_updated', { type: 'notification_campaign', id }, () => previewCampaign(campaign, access, id));
  });

  // №206
  app.post('/notifications/campaigns/:id/confirm', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = idOf(request);
    const body = parse(confirmBody, request.body);
    return send(reply, await denied(meta, 'notification.campaign_confirmed', { type: 'notification_campaign', id }, () => confirmCampaign(campaign, access, meta, id, body, key)));
  });

  // №207
  app.post('/notifications/campaigns/:id/cancel', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = idOf(request);
    const body = parse(reasonBody, request.body);
    return send(reply, await denied(meta, 'notification.campaign_cancelled', { type: 'notification_campaign', id }, () => cancelCampaign(campaign, access, meta, id, body, key)));
  });

  // №208
  app.get('/notifications', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = parse(notificationQuery, request.query);
    assertBranchFilter(access, q.branchId);
    return listNotifications(deps.pool, access, { ...q, from: dateOf(q.from), to: dateOf(q.to) });
  });

  // №209
  app.post('/notifications/:id/retry', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = idOf(request);
    const body = parse(reasonBody, request.body);
    return send(reply, await denied(meta, 'notification.retried', { type: 'notification', id }, () => retryNotification(deps.pool, clock, access, meta, id, body, key)));
  });

  // №210
  app.get('/notifications/templates', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    if (!roleAllows(access.role, 'notifications.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'notifications.view' });
    const q = parse(templateQuery, request.query);
    return { items: await listTemplates(deps.pool, q.status ? { status: q.status } : {}) };
  });

  // №211
  app.post('/notifications/templates', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(templateCreate, request.body);
    return send(reply, await denied(meta, 'notification.template_created', { type: 'notification_template', id: null }, () => createTemplate(deps.pool, clock, access, meta, body, key)));
  });

  app.patch('/notifications/templates/:id', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = idOf(request);
    const body = parse(templatePatch, request.body);
    return send(reply, await denied(meta, 'notification.template_updated', { type: 'notification_template', id }, () => updateTemplate(deps.pool, clock, access, meta, id, body, key)));
  });

  // №212
  app.get<{ Params: { clientId: string } }>('/clients/:clientId/notification-summary', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return clientNotificationSummary(deps.pool, access, request.params.clientId.toLowerCase());
  });

  // ---- лента событий CRM (13 §11, S4-28, D4-46): своё и своей зоны; чужое – 404. Прочтение естественно идемпотентно – без ключа.
  app.get('/staff-feed', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = parse(feedQuery, request.query);
    reply.header('cache-control', 'no-store');
    return listStaffFeed(deps.pool, access, { cursor: q.cursor, limit: q.limit, unreadOnly: q.unread === 'true' });
  });

  app.get('/staff-feed/unread-count', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    reply.header('cache-control', 'no-store');
    return { unread: await feedUnreadCount(deps.pool, access) };
  });

  app.post('/staff-feed/:id/read', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    await markFeedRead(deps.pool, access, idOf(request), clock.now());
    return reply.code(204).send();
  });

  app.post('/staff-feed/read-all', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const body = parse(feedReadAll, request.body);
    return { marked: await markAllFeedRead(deps.pool, access, new Date(body.before), clock.now()) };
  });
}
