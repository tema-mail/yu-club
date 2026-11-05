// S3-60. API подарка (K20 §15): CRM №376–379 (подарки, окна, запись, праздничный календарь) и ЛК П1–П2. Подарок не появляется в
// /me/certificates (приёмка 19): свой адрес, свой номер GF-, без номинала. Клиент видит только свои – чужой подарок как несуществующий.
// Окна дня – только будни без праздников в пределах срока (K20 §8.2), подарочный ресурс, шаг gift.start_align_minutes, длительность из
// снимка условий. Окно свободно, если обе единицы не заняты и не заблокированы; окончательное решение – команда занятия (K6 EXCLUDE):
// чтение занятости здесь то же, что у availability (запись – только через провайдеры booking).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeDenied, type AuditAction, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { branchScopeSql, can, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { instantToLocal, localToInstant, parseLocalDate, systemClock, toPgRange, type Clock, type Interval, type LocalDate, type LocalTime } from '../../core/time.ts';
import { bookingWindowOf } from '../booking/availability.ts';
import { runOccupancyCommand } from '../booking/occupancy.ts';
import { crmBooking } from '../booking/routes.crm.ts';
import { authenticateClient, type ClientPublicDeps } from '../clients/routes.public.ts';
import { cancelHoliday, listHolidays, setHoliday } from '../network/holidays.ts';
import { getBranch, openIntervals } from '../network/index.ts';
import { expandToUnits } from '../resources/index.ts';
import { notFound, parseBody, UUID_RE } from './events.ts';
import { assertGiftDay, bookGiftByStaff, giftResourceOf, holdGift } from './gift-booking.ts';
import { cancelGift, GIFT_SELECT, getGiftRow, giftToday, issueGift, toGiftDto, type GiftRow, type GiftStatus } from './gifts.ts';

const Uuid = z.string().regex(UUID_RE);
const At = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const slotsQuery = z.object({ branchId: Uuid, date: z.string() });
const holdBody = z.object({ branchId: Uuid, start: At });
const bookBody = z.object({ branchId: Uuid, start: At, comment: z.string().trim().max(1000).optional(), clientId: Uuid.optional() });
const listQuery = z.object({
  clientId: Uuid.optional(),
  status: z.enum(['issued', 'reserved', 'used', 'expired', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const objectBody = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

export interface GiftSlots {
  date: string;
  /** Почему день закрыт: GIFT_EXPIRED, GIFT_WEEKDAY_ONLY, GIFT_HOLIDAY, RESOURCE_UNAVAILABLE, OUTSIDE_BOOKING_WINDOW. */
  closedReason: string | null;
  slots: Array<{ start: string; end: string }>;
}

/** Окна дня (K20 №377, П1). Занятость – снимок запроса: истёкшие удержания не держат слот, блокировки закрывают. */
export async function giftSlots(db: Db, gift: GiftRow, branchId: string, rawDate: string, now: Date): Promise<GiftSlots> {
  const date = parseLocalDate(rawDate);
  const branch = await getBranch(db, branchId);
  if (!branch) throw notFound();
  const closed = (closedReason: string): GiftSlots => ({ date, closedReason, slots: [] });
  try {
    await assertGiftDay(db, gift, branch.id, date);
  } catch (err) {
    if (err instanceof AppError && err.code.startsWith('GIFT_')) return closed(err.code);
    throw err;
  }
  const today = instantToLocal(now, branch.timezone).date;
  const { maxDays } = await bookingWindowOf(db, branch.id, now);
  if (date < today || dateDiff(today, date) >= maxDays) return closed('OUTSIDE_BOOKING_WINDOW');
  const resource = await giftResourceOf(db, branch.id);
  if (!resource) return closed('RESOURCE_UNAVAILABLE');
  const open = await openIntervals(db, { branchId: branch.id, date, roomId: resource.roomId, resourceId: resource.id });
  if (open.length === 0) return { date, closedReason: null, slots: [] };
  const units = await expandToUnits(db, resource.id, localToInstant(date, '12:00' as LocalTime, branch.timezone), { serviceGrant: true });
  const align = (await resolveSetting(db, 'gift.start_align_minutes', { branchId: branch.id }, now)).value;
  const minutes = gift.terms.roomMinutes;
  const day: Interval = { start: open[0]!.start, end: open.at(-1)!.end };
  const busy = await db.query<{ s: Date; e: Date }>(
    `SELECT lower(period) AS s, upper(period) AS e FROM app.occupancy
      WHERE active AND unit_id = ANY($1::uuid[]) AND period && $2::tstzrange AND (hold_expires_at IS NULL OR hold_expires_at > $3)
     UNION ALL
     SELECT lower(period), upper(period) FROM app.resource_block_units WHERE active AND unit_id = ANY($1::uuid[]) AND period && $2::tstzrange`,
    [units.unitIds, toPgRange(day), now],
  );
  const slots: GiftSlots['slots'] = [];
  for (const i of open) {
    const [hh, mm] = instantToLocal(i.start, branch.timezone).time.split(':').map(Number) as [number, number];
    const shift = (align - ((hh * 60 + mm) % align)) % align;
    for (let t = i.start.getTime() + shift * 60_000; t + minutes * 60_000 <= i.end.getTime(); t += align * 60_000) {
      const end = t + minutes * 60_000;
      if (t <= now.getTime()) continue;
      if (busy.rows.some((b) => b.s.getTime() < end && b.e.getTime() > t)) continue;
      slots.push({ start: new Date(t).toISOString(), end: new Date(end).toISOString() });
    }
  }
  return { date, closedReason: null, slots };
}

function dateDiff(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ---- CRM №376–379

export interface GiftCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

export async function giftCrmRoutes(app: FastifyInstance, deps: GiftCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  type Run = (tx: pg.PoolClient, ctx: AccessContext, params: Record<string, string>, body: Record<string, unknown>, meta: AuditRequestMeta) => Promise<unknown>;

  function command(operation: string, action: AuditAction, objectType: 'gift' | 'holiday', run: Run, status = 200) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const body = objectBody(request.body);
      let result;
      try {
        result = await runOccupancyCommand(deps.pool, (tx) =>
          runIdempotent(
            tx,
            { scope: idempotencyScope('staff', access.actor.staffId, `gift.${operation}`), key, request: { route: `${request.method} ${request.routeOptions.url}`, params, body }, clock },
            async () => ({ status, body: await run(tx, access, params, body, meta) }),
          ),
        );
      } catch (err) {
        if (err instanceof AppError && err.code === 'FORBIDDEN') {
          const id = params.id && UUID_RE.test(params.id) ? params.id : null;
          await writeDenied(deps.pool, meta, { action, object: { type: objectType, id }, reason: `${err.code}: ${operation}`, result: 'denied' }, clock);
        }
        throw err;
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }
  const anyZone = (ctx: AccessContext) => {
    if (scopeFilter(ctx, 'event.view').kind === 'none') throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'event.view' });
  };

  // №376: зона – филиал выдачи
  app.get('/gifts', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = parseBody(listQuery, request.query);
    const params: unknown[] = [];
    const where = [branchScopeSql('g.issue_branch_id', scopeFilter(access, 'event.view'), params)];
    if (q.clientId) {
      params.push(q.clientId);
      where.push(`g.client_id = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status satisfies GiftStatus);
      where.push(`g.status = $${params.length}`);
    }
    params.push(q.limit);
    const r = await deps.pool.query<GiftRow>(`${GIFT_SELECT} WHERE ${where.join(' AND ')} ORDER BY g.issued_on DESC, g.id DESC LIMIT $${params.length}`, params);
    return { items: r.rows.map(toGiftDto) };
  });
  app.post('/gifts', command('issue', 'gift.issued', 'gift', (tx, ctx, _p, body, meta) => issueGift(tx, ctx, body, meta, clock), 201));
  app.post('/gifts/:id/cancel', command('cancel', 'gift.cancelled', 'gift', (tx, ctx, p, body, meta) => cancelGift(tx, ctx, p.id!, body, meta, clock)));

  // №377: окна дня; филиал – любой с подарочным ресурсом в зоне сотрудника (Q-114)
  app.get('/gifts/:id/slots', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = parseBody(slotsQuery, request.query);
    const gift = await getGiftRow(deps.pool, (request.params as { id: string }).id);
    if (!gift || !can(access, 'event.view', { branchId: q.branchId })) throw notFound();
    return giftSlots(deps.pool, gift, q.branchId, q.date, clock.now());
  });

  // №378: запись из CRM, ответ – CrmBooking
  app.post(
    '/gifts/:id/book',
    command(
      'book',
      'gift.reserved',
      'gift',
      async (tx, ctx, p, body, meta) => {
        const input = parseBody(bookBody, body);
        const id = await bookGiftByStaff(tx, ctx, p.id!, { branchId: input.branchId, start: input.start, comment: input.comment, clientId: input.clientId }, meta, clock);
        return crmBooking(tx, ctx, id, clock.now());
      },
      201,
    ),
  );

  // №379: праздничный календарь
  app.get('/holidays', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    anyZone(access);
    return { items: await listHolidays(deps.pool, request.query) };
  });
  app.post('/holidays', command('holiday.set', 'holiday.set', 'holiday', (tx, ctx, _p, body, meta) => setHoliday(tx, ctx, body, meta, clock), 201));
  app.post('/holidays/:id/cancel', command('holiday.cancel', 'holiday.cancelled', 'holiday', (tx, ctx, p, body, meta) => cancelHoliday(tx, ctx, p.id!, body, meta, clock)));
}

// ---- ЛК П1–П2

export async function giftPublicRoutes(app: FastifyInstance, deps: ClientPublicDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  /** Свой подарок; чужой – как несуществующий. */
  async function mine(request: FastifyRequest, reply: FastifyReply): Promise<{ gift: GiftRow; clientId: string; sessionId: string }> {
    const session = await authenticateClient(deps, request, reply);
    const gift = await getGiftRow(deps.pool, (request.params as { id: string }).id);
    if (!gift || gift.client_id !== session.clientId) throw notFound();
    return { gift, ...session };
  }

  app.get('/me/gifts', async (request, reply) => {
    const { clientId } = await authenticateClient(deps, request, reply);
    const r = await deps.pool.query<GiftRow>(`${GIFT_SELECT} WHERE g.client_id = $1 AND g.status <> 'cancelled' ORDER BY g.issued_on DESC, g.id DESC LIMIT 50`, [clientId]);
    const now = clock.now();
    return {
      items: r.rows.map((g) => ({
        id: g.id,
        number: g.number,
        issuedOn: g.issued_on,
        validUntil: g.valid_until,
        // срок прошёл, а задача истечения ещё не дошла – клиент всё равно видит «истёк»
        status: g.status === 'issued' && g.valid_until < giftToday(g, now) ? ('expired' as const) : g.status,
        terms: g.terms,
        bookingId: g.booking_id,
      })),
    };
  });

  app.get('/me/gifts/:id/slots', async (request, reply) => {
    const { gift } = await mine(request, reply);
    const q = parseBody(slotsQuery, request.query);
    if (gift.status !== 'issued') return { date: q.date, closedReason: 'GIFT_NOT_ACTIVE', slots: [] };
    return giftSlots(deps.pool, gift, q.branchId, q.date, clock.now());
  });

  // П2: обычное удержание K5 на подарочный ресурс; дальше – обычное оформление /holds/:id/confirm с ценой 0
  app.post('/me/gifts/:id/hold', async (request, reply) => {
    const { gift, clientId, sessionId } = await mine(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = objectBody(request.body);
    const input = parseBody(holdBody, body);
    const meta: AuditRequestMeta = { actor: { kind: 'client', clientId, sessionId }, source: 'account', requestId: request.id };
    const result = await runOccupancyCommand(deps.pool as Parameters<typeof runOccupancyCommand>[0], (tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('client', clientId, 'gift.hold'), key, request: { route: 'POST /me/gifts/:id/hold', params: { id: gift.id }, body }, clock },
        async () => ({ status: 201, body: await holdGift(tx, { clientId, visitorId: null }, gift.id, input, meta, clock) }),
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });
}
