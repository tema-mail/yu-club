// HTTP /api/public/v1: подписка Web Push и настройки уведомлений клиента. Тонкий слой (ADR 0002 п.7).
// Всё, кроме открытого ключа VAPID, – за сессией клиента (кука yu_client, K9). Endpoint и ключи в лог не пишутся.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { requireIdempotencyKey } from '../../core/idempotency.ts';
import { systemClock } from '../../core/time.ts';
import { authenticateClient, type ClientPublicDeps } from '../clients/routes.public.ts';
import {
  DEFAULT_PUSH_HOSTS,
  getNotificationSettings,
  removePushSubscription,
  savePushSubscription,
  updateNotificationSettings,
} from './index.ts';

export interface NotificationPublicDeps {
  clients: ClientPublicDeps;
  /** Открытый ключ VAPID (base64url) или null – push на сервере не настроен. */
  vapidPublicKey: string | null;
  allowedPushHosts?: readonly string[];
}

const subscriptionBody = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().max(128), auth: z.string().max(64) }),
  expirationTime: z.number().nullable().optional(), // PushSubscription.toJSON() – принимаем и не храним
});
const deleteBody = z.object({ endpoint: z.string().min(1).max(2048) });
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

  app.post('/push/subscription', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    requireVapid();
    const body = parse(subscriptionBody, request.body);
    const ua = request.headers['user-agent'];
    const r = await savePushSubscription(
      clients.pool,
      clock,
      session.clientId,
      { endpoint: body.endpoint, keys: body.keys, userAgent: ua },
      hosts,
      meta(request, session),
    );
    return reply.code(r.created ? 201 : 200).send({ id: r.id });
  });

  app.delete('/push/subscription', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    const body = parse(deleteBody, request.body);
    await removePushSubscription(clients.pool, clock, session.clientId, body.endpoint, meta(request, session));
    return reply.code(204).send();
  });

  app.get('/notification-settings', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    return getNotificationSettings(clients.pool, session.clientId);
  });

  app.put('/notification-settings', async (request, reply) => {
    const session = await authenticateClient(clients, request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(settingsBody, request.body);
    const r = await updateNotificationSettings(clients.pool, clock, session.clientId, body, key, meta(request, session));
    if (r.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(r.status).send(r.body);
  });
}
