// K5 №5–11 (S1-06): доступность и удержания на /api/public/v1. Тонкий слой: разбор → команда в транзакции → ответ.
// Кука yu_visitor ставится на GET availability, если её нет (K5 §Общее); владелец удержания – клиент (сессия K9,
// её даёт server.ts через identify) или посетитель. Изменяющие маршруты – с Idempotency-Key (ADR 0004), команда
// занятия – с одним повтором при 40P01/40001 (runOccupancyCommand). Лимиты K5: /holds* – 30/мин на посетителя и
// 60/мин на IP, /availability – 120/мин на IP (в памяти процесса – решение: один процесс API в Э1).
// CSRF (X-Requested-With + Origin) проверяет прокси сайта (S1-17d), не этот слой.
// S1-08: схемы тел и запросов – packages/contracts/src/booking.ts (тот же файл импортирует сайт, по нему контракт-тест);
// K5 №13 отмена клиентом (change.ts), K9 «мои записи» и «мои посещения» для ЛК – только свои, без служебного
// комментария (03 §8.3); курсор – base64url(JSON [момент, id]), 20 на страницу (17 §4.4).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { AvailabilityQuery, CancelBody, ConfirmBody, CreateHoldBody, HoldItemInput, MyBookingsQuery, MyVisitsQuery, type MyBookingDto, type MyVisitDto } from '../../../../../packages/contracts/src/booking.ts';
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { parseLocalDate, systemClock, type Clock } from '../../core/time.ts';
import { availability } from './availability.ts';
import type { AuditRequestMeta } from '../../core/audit.ts';
import { cancelBooking } from './change.ts';
import { bookingDtos, confirmHold } from './confirm.ts';
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
const authRequired = () => new AppError('AUTH_REQUIRED', 401, 'Войдите, чтобы завершить запись');
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

const toItem = (i: { resourceId: string; start: string; end: string }) => ({ resourceId: i.resourceId, start: new Date(i.start), end: new Date(i.end) });
const PAGE = 20;
const CURSOR = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);

function decodeCursor(s: string | undefined): [Date, string] | null {
  if (s === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    v = undefined;
  }
  const r = CURSOR.safeParse(v);
  if (!r.success) throw new AppError('VALIDATION_FAILED', 400, 'Проверьте данные', { field: 'cursor' });
  return [new Date(r.data[0]), r.data[1]];
}
const encodeCursor = (at: Date, id: string) => Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');

/** K9: вкладки ЛК. upcoming – действующие, ещё не закончились (идущий сеанс – тоже здесь), по возрастанию;
 *  past – завершённые, неявки и закончившиеся без отметки, по убыванию; cancelled – отменённые, по убыванию. */
const TABS = {
  upcoming: { where: `b.status IN ('confirmed','arrived') AND upper(b.period) > $2`, asc: true },
  past: { where: `(b.status IN ('completed','no_show') OR (b.status IN ('confirmed','arrived') AND upper(b.period) <= $2))`, asc: false },
  cancelled: { where: `b.status IN ('cancelled_by_client','cancelled_by_club') AND $2::timestamptz IS NOT NULL`, asc: false }, // $2 – тип параметра
} as const;

async function myBookings(db: Db, clientId: string, tab: keyof typeof TABS, cursor: string | undefined, now: Date): Promise<{ items: MyBookingDto[]; nextCursor: string | null }> {
  const t = TABS[tab];
  const c = decodeCursor(cursor);
  const r = await db.query<{ id: string; s: Date; city_name: string; room_name: string | null; arrived_at: Date | null }>(
    `SELECT b.id, lower(b.period) AS s, ci.name AS city_name, v.resource_snapshot ->> 'roomName' AS room_name, vi.arrived_at
     FROM app.bookings b JOIN app.branches br ON br.id = b.branch_id JOIN app.cities ci ON ci.id = br.city_id
     JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
     LEFT JOIN app.visits vi ON vi.booking_id = b.id AND vi.status = 'active'
     WHERE b.client_id = $1 AND ${t.where}
       AND ($3::timestamptz IS NULL OR (lower(b.period), b.id) ${t.asc ? '>' : '<'} ($3::timestamptz, $4::uuid))
     ORDER BY lower(b.period) ${t.asc ? 'ASC' : 'DESC'}, b.id ${t.asc ? 'ASC' : 'DESC'} LIMIT ${PAGE + 1}`,
    [clientId, now, c?.[0] ?? null, c?.[1] ?? null],
  );
  const rows = r.rows.slice(0, PAGE);
  const dto = new Map((await bookingDtos(db, rows.map((x) => x.id), now)).map((d) => [d.id, d]));
  const items = rows.map((x) => ({ ...dto.get(x.id)!, cityName: x.city_name, roomName: x.room_name, visit: x.arrived_at ? { arrivedAt: x.arrived_at.toISOString() } : null }));
  const last = rows.at(-1);
  return { items, nextCursor: r.rows.length > PAGE && last ? encodeCursor(last.s, last.id) : null };
}

/** K9: только фактические посещения (03 §8.4), новые сверху. */
async function myVisits(db: Db, clientId: string, cursor: string | undefined): Promise<{ items: MyVisitDto[]; nextCursor: string | null }> {
  const c = decodeCursor(cursor);
  const r = await db.query<{ id: string; booking_id: string; number: string; branch_name: string; resource_name: string; s: Date; e: Date; arrived_at: Date }>(
    `SELECT vi.id, vi.booking_id, b.number, br.name AS branch_name, v.resource_snapshot ->> 'name' AS resource_name, lower(b.period) AS s, upper(b.period) AS e, vi.arrived_at
     FROM app.visits vi JOIN app.bookings b ON b.id = vi.booking_id JOIN app.branches br ON br.id = b.branch_id
     JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
     WHERE vi.client_id = $1 AND vi.status = 'active' AND ($2::timestamptz IS NULL OR (vi.arrived_at, vi.id) < ($2::timestamptz, $3::uuid))
     ORDER BY vi.arrived_at DESC, vi.id DESC LIMIT ${PAGE + 1}`,
    [clientId, c?.[0] ?? null, c?.[1] ?? null],
  );
  const rows = r.rows.slice(0, PAGE);
  const items = rows.map((x) => ({
    bookingId: x.booking_id, number: Number(x.number), branchName: x.branch_name, resourceName: x.resource_name,
    plannedStart: x.s.toISOString(), plannedEnd: x.e.toISOString(), arrivedAt: x.arrived_at.toISOString(), status: 'visited' as const,
  }));
  const last = rows.at(-1);
  return { items, nextCursor: r.rows.length > PAGE && last ? encodeCursor(last.arrived_at, last.id) : null };
}

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
  function command(operation: string, status: number, run: (tx: pg.PoolClient, o: HoldOwner, params: Record<string, string>, body: unknown) => Promise<unknown>, opts: { client?: true } = {}) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const o = await owner(request, reply);
      if (opts.client && !o.clientId) throw authRequired();
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

  /** Вошедший клиент или 401 (K9: /me/*). */
  async function clientOf(request: FastifyRequest, reply: FastifyReply): Promise<string> {
    const c = await deps.identify(request, reply);
    if (!c) throw authRequired();
    return c.clientId;
  }

  app.get('/branches/:branchId/availability', async (request, reply) => {
    hit(`a:${request.ip}`, limits.availabilityPerIp);
    let visitorId = visitorOf(request);
    if (!visitorId) {
      visitorId = randomUUID();
      reply.header('set-cookie', `${VISITOR_COOKIE}=${visitorId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
    }
    const q = parse(AvailabilityQuery, request.query);
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
      const input = parse(CreateHoldBody, body);
      return createHold(tx, o, { branchId: input.branchId, items: input.items.map(toItem) }, clock);
    }),
  );
  app.get('/holds/:holdId', async (request, reply) => getHold(deps.pool, await owner(request, reply), (request.params as { holdId: string }).holdId, clock));
  app.post('/holds/:holdId/items', command('hold.add', 200, (tx, o, p, body) => addHoldItem(tx, o, p.holdId!, toItem(parse(HoldItemInput, body)), clock)));
  app.delete('/holds/:holdId/items/:itemId', command('hold.remove', 200, (tx, o, p) => removeHoldItem(tx, o, p.holdId!, p.itemId!, clock)));
  app.post('/holds/:holdId/release', command('hold.release', 200, (tx, o, p) => releaseHold(tx, o, p.holdId!, clock)));
  app.post(
    '/holds/:holdId/confirm',
    command('hold.confirm', 201, (tx, o, p, body) => {
      parse(ConfirmBody, body);
      return confirmHold(tx, o.clientId!, p.holdId!, clock);
    }, { client: true }),
  );
  app.post(
    '/holds/:holdId/attach',
    command('hold.attach', 200, (tx, o, p) => attachHold(tx, o.clientId!, o.visitorId, p.holdId!, clock), { client: true }),
  );
  app.post(
    '/bookings/:bookingId/cancel',
    command(
      'booking.cancel',
      200,
      async (tx, o, p, body) => {
        const input = parse(CancelBody, body);
        const meta: AuditRequestMeta = { actor: { kind: 'client', clientId: o.clientId!, sessionId: '' }, source: 'account', requestId: `cancel:${p.bookingId}` };
        const b = await cancelBooking(tx, p.bookingId!, { kind: 'client', clientId: o.clientId!, reason: input.reason }, meta, clock);
        return (await bookingDtos(tx, [b.id], clock.now()))[0];
      },
      { client: true },
    ),
  );
  app.get('/me/bookings', async (request, reply) => {
    const clientId = await clientOf(request, reply);
    const q = parse(MyBookingsQuery, request.query);
    return myBookings(deps.pool, clientId, q.tab, q.cursor, clock.now());
  });
  app.get('/me/visits', async (request, reply) => {
    const clientId = await clientOf(request, reply);
    return myVisits(deps.pool, clientId, parse(MyVisitsQuery, request.query).cursor);
  });
}
