// K5 №5–11 (S1-06): доступность и удержания на /api/public/v1. Тонкий слой: разбор → команда в транзакции → ответ.
// Кука yu_visitor ставится на GET availability, если её нет (K5 §Общее); владелец удержания – клиент (сессия K9,
// её даёт server.ts через identify) или посетитель. Изменяющие маршруты – с Idempotency-Key (ADR 0004), команда
// занятия – с одним повтором при 40P01/40001 (runOccupancyCommand). Лимиты K5: /holds* – 30/мин на посетителя и
// 60/мин на IP, /availability – 120/мин на IP (в памяти процесса – решение: один процесс API в Э1).
// CSRF (X-Requested-With + Origin) проверяет прокси сайта (S1-17d), не этот слой.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { parseLocalDate, systemClock, type Clock } from '../../core/time.ts';
import { availability } from './availability.ts';
import { confirmHold } from './confirm.ts';
import { addHoldItem, attachHold, createHold, getHold, ownHoldItems, releaseHold, removeHoldItem, type HoldOwner } from './hold.ts';
import { runOccupancyCommand } from './occupancy.ts';

export const VISITOR_COOKIE = 'yu_visitor';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BookingPublicDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  clock?: Clock;
  /** Сессия клиента по куке yu_client или null (без ошибки). Реализация – modules/clients (server.ts). */
  identify: (request: FastifyRequest, reply: FastifyReply) => Promise<{ clientId: string } | null>;
  /** Лимиты в минуту; тесты задают свои. */
  limits?: { holdsPerVisitor: number; holdsPerIp: number; availabilityPerIp: number };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
const visitorOf = (request: FastifyRequest): string | null => {
  const v = readCookie(request.headers.cookie, VISITOR_COOKIE);
  return v && UUID_RE.test(v) ? v.toLowerCase() : null;
};

/** Окно в минуту на ключ (фиксированное). */
function limiter(clock: Clock) {
  const hits = new Map<string, { minute: number; n: number }>();
  return (key: string, max: number): void => {
    const minute = Math.floor(clock.now().getTime() / 60_000);
    const cur = hits.get(key);
    const n = cur && cur.minute === minute ? cur.n + 1 : 1;
    hits.set(key, { minute, n });
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.minute !== minute) hits.delete(k);
    if (n > max) throw new AppError('RATE_LIMITED', 429, 'Слишком много запросов, подождите минуту', { retryAfterSec: 60 - (Math.floor(clock.now().getTime() / 1000) % 60) });
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Проверьте данные', { fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

const ISO = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const itemSchema = z.strictObject({ resourceId: z.uuid(), start: ISO, end: ISO });
const createSchema = z.strictObject({ branchId: z.uuid(), items: z.array(itemSchema).min(1).max(20) });
const availabilityQuery = z.object({ date: z.string().max(10), resourceIds: z.string().max(50 * 37).optional() });

export async function bookingPublicRoutes(app: FastifyInstance, deps: BookingPublicDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const limits = deps.limits ?? { holdsPerVisitor: 30, holdsPerIp: 60, availabilityPerIp: 120 };
  const hit = limiter(clock);

  async function owner(request: FastifyRequest, reply: FastifyReply): Promise<HoldOwner> {
    const client = await deps.identify(request, reply);
    const visitorId = visitorOf(request);
    hit(`ip:${request.ip}`, limits.holdsPerIp);
    if (visitorId) hit(`v:${visitorId}`, limits.holdsPerVisitor);
    return { clientId: client?.clientId ?? null, visitorId };
  }

  /** Команда удержания: ключ → транзакция занятия (повтор при 40P01) → runIdempotent. */
  function command(operation: string, status: number, run: (tx: pg.PoolClient, o: HoldOwner, params: Record<string, string>, body: unknown) => Promise<unknown>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const o = await owner(request, reply);
      if (!o.clientId && !o.visitorId) throw new AppError('VISITOR_REQUIRED', 400, 'Нужна кука посетителя');
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const scope = o.clientId ? idempotencyScope('client', o.clientId, `booking.${operation}`) : idempotencyScope('visitor', o.visitorId!, `booking.${operation}`);
      const result = await runOccupancyCommand(deps.pool, (tx) =>
        runIdempotent(tx, { scope, key, request: { route: `${request.method} ${request.routeOptions.url}`, params, body: request.body ?? null }, clock }, async () => ({
          status,
          body: await run(tx, o, params, request.body),
        })),
      );
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }

  app.get('/branches/:branchId/availability', async (request, reply) => {
    hit(`a:${request.ip}`, limits.availabilityPerIp);
    let visitorId = visitorOf(request);
    if (!visitorId) {
      visitorId = randomUUID();
      reply.header('set-cookie', `${VISITOR_COOKIE}=${visitorId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
    }
    const q = parse(availabilityQuery, request.query);
    const resourceIds = q.resourceIds ? q.resourceIds.split(',').filter((x) => x !== '') : undefined;
    if (resourceIds && (resourceIds.length > 50 || !resourceIds.every((x) => UUID_RE.test(x)))) throw new AppError('VALIDATION_FAILED', 400, 'Проверьте данные', { field: 'resourceIds' });
    let date;
    try {
      date = parseLocalDate(q.date);
    } catch {
      throw new AppError('VALIDATION_FAILED', 400, 'Проверьте данные', { field: 'date' });
    }
    const client = await deps.identify(request, reply);
    const branchId = (request.params as { branchId: string }).branchId;
    if (!UUID_RE.test(branchId)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return availability(
      deps.pool,
      { branchId, date, viewer: { visitorId, ...(client ? { clientId: client.clientId } : {}) }, ...(resourceIds ? { resourceIds } : {}) },
      { clock, ownHoldItems },
    );
  });

  app.post(
    '/holds',
    command('hold.create', 201, (tx, o, _p, body) => {
      const input = parse(createSchema, body);
      return createHold(tx, o, input, clock);
    }),
  );
  app.get('/holds/:holdId', async (request, reply) => getHold(deps.pool, await owner(request, reply), (request.params as { holdId: string }).holdId, clock));
  app.post('/holds/:holdId/items', command('hold.add', 200, (tx, o, p, body) => addHoldItem(tx, o, p.holdId!, parse(itemSchema, body), clock)));
  app.delete('/holds/:holdId/items/:itemId', command('hold.remove', 200, (tx, o, p) => removeHoldItem(tx, o, p.holdId!, p.itemId!, clock)));
  app.post('/holds/:holdId/release', command('hold.release', 200, (tx, o, p) => releaseHold(tx, o, p.holdId!, clock)));
  app.post(
    '/holds/:holdId/confirm',
    command('hold.confirm', 201, (tx, o, p, body) => {
      parse(z.strictObject({ comment: z.string().max(500).optional() }), body);
      if (!o.clientId) throw new AppError('AUTH_REQUIRED', 401, 'Войдите, чтобы завершить запись');
      return confirmHold(tx, o.clientId, p.holdId!, clock);
    }),
  );
  app.post(
    '/holds/:holdId/attach',
    command('hold.attach', 200, (tx, o, p) => {
      if (!o.clientId) throw new AppError('AUTH_REQUIRED', 401, 'Войдите, чтобы завершить запись');
      return attachHold(tx, o.clientId, o.visitorId, p.holdId!, clock);
    }),
  );
}
