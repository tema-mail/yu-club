// HTTP /api/public/v1 (K9 §ЛК): /me/push-subscriptions, /me/notification-settings, открытый ключ VAPID и центр уведомлений
// K21 §11 №201–204 (/me/notifications). Тонкий слой (ADR 0002 п.7).
// Всё, кроме открытого ключа VAPID, – за сессией клиента (кука yu_client, K9). Endpoint и ключи в лог не пишутся.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { systemClock } from '../../core/time.ts';
import { withTx } from '../clients/index.ts';
import { authenticateClient, type ClientPublicDeps } from '../clients/routes.public.ts';
import { applyUnsubscribe, checkUnsubscribe, unsubscribeRateLimiter } from './unsubscribe.ts';
import { listInbox, markAllRead, markRead, unreadCount, type InboxBookingLookup } from './inbox.ts';
import {
  DEFAULT_PUSH_HOSTS,
  getNotificationSettings,
  removePushSubscriptionByEndpoint,
  removePushSubscriptionById,
  savePushSubscription,
  updateNotificationSettings,
} from './index.ts';

export interface NotificationPublicDeps {
  clients: ClientPublicDeps;
  /** Открытый ключ VAPID (base64url) или null – push на сервере не настроен. */
  vapidPublicKey: string | null;
  allowedPushHosts?: readonly string[];
  /** Состояние связанной брони в центре (booking/providers.ts bookingLookup). Нет – брони показываются «недоступна». */
  bookings?: InboxBookingLookup;
  /** UNSUBSCRIBE_SECRET (K21 §13). Нет – отписка по ссылке отвечает 503, реклама не подтверждается. */
  unsubscribeSecret?: string | null;
}

export const READ_ALL_ROUTE = 'POST /api/public/v1/me/notifications/read-all';

const subscriptionBody = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().max(128), auth: z.string().max(64) }),
  expirationTime: z.number().nullable().optional(), // PushSubscription.toJSON() – принимаем и не храним
});
const deleteBody = z.object({ endpoint: z.string().min(1).max(2048) });
const unsubscribeQuery = z.object({ t: z.string().min(1).max(512) });
const unsubscribeBody = z.object({ t: z.string().min(1).max(512) });
const inboxQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const readAllBody = z.object({ before: z.iso.datetime({ offset: true }) });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const settingsBody = z.object({
  remindersEnabled: z.boolean(),
  marketingEnabled: z.boolean(),
  documentVersion: z.string().trim().min(1).max(64).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

function meta(request: FastifyRequest, s: { clientId: string; sessionId: string }): AuditRequestMeta {
  return { actor: { kind: 'client', clientId: s.clientId, sessionId: s.sessionId }, source: 'account', requestId: request.id, ip: request.ip };
}

export async function notificationPublicRoutes(app: FastifyInstance, deps: NotificationPublicDeps): Promise<void> {
  const { clients } = deps;
  const clock = clients.clock ?? systemClock;
  const hosts = deps.allowedPushHosts ?? DEFAULT_PUSH_HOSTS;
  const requireVapid = (): string => {
    if (!deps.vapidPublicKey) throw new AppError('PUSH_NOT_CONFIGURED', 503, 'Уведомления в браузере пока недоступны');
    return deps.vapidPublicKey;
  };

  // Ключ для pushManager.subscribe({ applicationServerKey }). Без сессии: нужен до входа, секрета в нём нет.
  app.get('/push/vapid-public-key', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return { publicKey: requireVapid() };
  });

  app.post('/me/push-subscriptions', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    requireVapid();
    const body = parse(subscriptionBody, request.body);
    const ua = request.headers['user-agent'];
    const r = await savePushSubscription(
      clients.pool,
      clock,
      session,
      { endpoint: body.endpoint, keys: body.keys, userAgent: ua },
      hosts,
      meta(request, session),
    );
    return reply.code(r.created ? 201 : 200).send({ id: r.id });
  });

  // Отписка этого браузера по endpoint (тело, не URL: адрес браузера – ПДн, в журнал запросов не идёт). 204 всегда.
  app.delete('/me/push-subscriptions', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    const body = parse(deleteBody, request.body);
    await removePushSubscriptionByEndpoint(clients.pool, clock, session.clientId, body.endpoint, meta(request, session));
    return reply.code(204).send();
  });

  // K9: 204 всегда – чужая, уже отозванная и несуществующая подписка неотличимы (не раскрываем чужие id).
  app.delete<{ Params: { id: string } }>('/me/push-subscriptions/:id', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    if (UUID_RE.test(request.params.id)) {
      await removePushSubscriptionById(clients.pool, clock, session.clientId, request.params.id.toLowerCase(), meta(request, session));
    }
    return reply.code(204).send();
  });

  app.get('/me/notification-settings', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    return getNotificationSettings(clients.pool, session.clientId);
  });

  app.put('/me/notification-settings', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(settingsBody, request.body);
    const r = await updateNotificationSettings(clients.pool, clock, session.clientId, body, key, meta(request, session));
    if (r.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(r.status).send(r.body);
  });

  // ---- центр уведомлений (K21 §3, §11 №201–204). Ответы личные – не кэшируются.
  app.get('/me/notifications', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    const q = parse(inboxQuery, request.query);
    reply.header('cache-control', 'no-store');
    return listInbox(clients.pool, session.clientId, { cursor: q.cursor, limit: q.limit, now: clock.now(), bookings: deps.bookings });
  });

  app.get('/me/notifications/unread-count', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    reply.header('cache-control', 'no-store');
    return { unread: await unreadCount(clients.pool, session.clientId, clock.now()) };
  });

  app.post<{ Params: { id: string } }>('/me/notifications/:id/read', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    await markRead(clients.pool, session.clientId, request.params.id.toLowerCase(), clock.now());
    return reply.code(204).send();
  });

  app.post('/me/notifications/read-all', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(readAllBody, request.body);
    const r = await withTx(clients.pool, (tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('client', session.clientId, READ_ALL_ROUTE), key, request: { route: READ_ALL_ROUTE, body }, clock },
        async () => ({ status: 200, body: { marked: await markAllRead(tx, session.clientId, new Date(body.before), clock.now()) } }),
      ),
    );
    if (r.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(r.status).send(r.body);
  });

  // ---- отписка без входа (K21 §4, §11 №205–206). GET ничего не меняет. Ошибка формата токена – 400 UNSUBSCRIBE_TOKEN_INVALID.
  const limit = unsubscribeRateLimiter(clock);
  const secret = deps.unsubscribeSecret ?? null;
  const token = (schema: typeof unsubscribeQuery, value: unknown): string => {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw new AppError('UNSUBSCRIBE_TOKEN_INVALID', 400, 'Ссылка отписки недействительна');
    return r.data.t;
  };

  app.get('/unsubscribe/check', async (request, reply) => {
    limit(request.ip);
    reply.header('cache-control', 'no-store');
    return checkUnsubscribe(clients.pool, secret, token(unsubscribeQuery, request.query), clock.now());
  });

  app.post('/unsubscribe', async (request, reply) => {
    limit(request.ip);
    reply.header('cache-control', 'no-store');
    return applyUnsubscribe(clients.pool, clock, secret, token(unsubscribeBody, request.body), { requestId: request.id, ip: request.ip });
  });
}
