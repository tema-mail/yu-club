// K9 HTTP: /api/public/v1 – запрос и проверка кода, выход, профиль (GET /me). Тонкий слой (ADR 0002 п.7).
// Кука yu_client – токен сессии (HttpOnly, Secure, SameSite=Lax, срок client.session_days); в теле токена нет.
// Кука yu_visitor (K5) только читается: её id передаётся хуку входа (attach удержаний – модуль booking).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../core/errors.ts';
import { requireIdempotencyKey } from '../../core/idempotency.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import type { Pool } from './index.ts';
import {
  getMe,
  logoutClient,
  requestOtp,
  resolveClientSession,
  verifyOtp,
  type ClientAuthConfig,
  type ClientLoginHooks,
  type ClientReqInfo,
  type SmsSender,
} from './otp.ts';

export const CLIENT_COOKIE = 'yu_client';
export const VISITOR_COOKIE = 'yu_visitor';

export interface ClientPublicDeps {
  pool: Pool;
  auth: ClientAuthConfig;
  sms: SmsSender;
  clock?: Clock;
  hooks?: ClientLoginHooks;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function setClientCookie(reply: FastifyReply, token: string, maxAgeSec: number): void {
  reply.header('set-cookie', `${CLIENT_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

function clearClientCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${CLIENT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function reqInfo(request: FastifyRequest): ClientReqInfo {
  const ua = request.headers['user-agent'];
  return { requestId: request.id, ip: request.ip, userAgent: ua ? ua.slice(0, 512) : undefined };
}

const requestBody = z.object({ phone: z.string().max(32), purpose: z.literal('login') });
const verifyBody = z.object({
  challengeId: z.string().max(64),
  code: z.string().max(12),
  consents: z.object({ pdProcessing: z.boolean(), marketing: z.boolean().optional() }).optional(),
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

/** Кука → сессия клиента. Нет куки – AUTH_REQUIRED; отозвана/истекла/статус не пускает – SESSION_REVOKED. */
export async function authenticateClient(
  deps: ClientPublicDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ clientId: string; sessionId: string }> {
  const token = readCookie(request.headers.cookie, CLIENT_COOKIE);
  if (!token) throw new AppError('AUTH_REQUIRED', 401, 'Нужно войти');
  const session = await resolveClientSession(deps.pool, deps.auth, token, deps.clock ?? systemClock);
  if (!session) {
    clearClientCookie(reply);
    throw new AppError('SESSION_REVOKED', 401, 'Сессия завершена, войдите снова');
  }
  return session;
}

export async function clientPublicRoutes(app: FastifyInstance, deps: ClientPublicDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  app.post('/auth/otp/request', async (request, reply) => {
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(requestBody, request.body);
    const r = await requestOtp(deps.pool, deps.auth, clock, deps.sms, { phone: body.phone, idempotencyKey: key }, reqInfo(request));
    if (r.replayed) reply.header('idempotent-replay', 'true');
    if (r.status >= 400) {
      const saved = r.body as { error: { details?: { resendAfterSec?: number } } };
      const retry = saved.error.details?.resendAfterSec;
      if (typeof retry === 'number') reply.header('retry-after', String(retry));
      return reply.code(r.status).send({ error: { ...saved.error, requestId: request.id } });
    }
    return reply.code(r.status).send(r.body);
  });

  app.post('/auth/otp/verify', async (request, reply) => {
    const body = parse(verifyBody, request.body);
    const visitor = readCookie(request.headers.cookie, VISITOR_COOKIE);
    const r = await verifyOtp(
      deps.pool,
      deps.auth,
      clock,
      {
        challengeId: body.challengeId,
        code: body.code,
        consents: body.consents,
        documentVersion: body.documentVersion,
        visitorId: visitor && UUID_RE.test(visitor) ? visitor.toLowerCase() : null,
      },
      reqInfo(request),
      deps.hooks,
    );
    setClientCookie(reply, r.token, Math.floor((r.expiresAt.getTime() - clock.now().getTime()) / 1000));
    return { client: r.client, isNew: r.isNew };
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = readCookie(request.headers.cookie, CLIENT_COOKIE);
    const session = token ? await resolveClientSession(deps.pool, deps.auth, token, clock) : null;
    if (session) await logoutClient(deps.pool, clock, session, reqInfo(request));
    clearClientCookie(reply);
    return reply.code(204).send();
  });

  app.get('/me', async (request, reply) => {
    const session = await authenticateClient(deps, request, reply);
    const me = await getMe(deps.pool, session.clientId);
    if (!me) {
      clearClientCookie(reply);
      throw new AppError('SESSION_REVOKED', 401, 'Сессия завершена, войдите снова');
    }
    return me;
  });
}
