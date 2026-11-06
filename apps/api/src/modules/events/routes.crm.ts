// S3-55. K20 §15 №361–370: CRM-маршруты мероприятий на /api/crm/v1. Тонкий слой (ADR 0002 п.7): разбор → команда в
// транзакции под Idempotency-Key (ADR 0004) → ответ. Команды с занятием – runOccupancyCommand (повтор при 40P01). Вне зоны –
// 404 с телом несуществующего, в зоне без права – 403 и запись отказа в аудит (ADR 0005 п.8). Без event.money.view суммы не
// отдаются, только dueKop (11 §13): и в списке, и в карточке, и в ответе отмены; плановая себестоимость строк – тоже.
// Отмена возвращает needsDecision – связанное система не трогает (11 §10, приёмка 12).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { objectTimeline, writeAudit, writeDenied, type AuditAction, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import type { Tx } from '../../core/ledger.ts';
import { branchScopeSql, can, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { runOccupancyCommand } from '../booking/occupancy.ts';
import { bookingLookup } from '../booking/providers.ts';
import { addChecklistItem, listChecklist, updateChecklistItem } from './checklist.ts';
import { changeEventStatus, createEvent, EVENT_SELECT, EVENT_STATUSES, getEventRow, guardEvent, lockEvent, notFound, parseBody, toEventDto, updateEvent, UUID_RE, type EventDto, type EventRow } from './events.ts';
import { addLine, applyPackage, createEventType, createPackage, listEventTypes, listLines, listPackages, removeLine, updateEventType, updateLine, updatePackage, type EventLineDto, type EventPackageDto } from './lines.ts';
import { addEventExpense, dueOf, eventMoneySummary, eventOperations, linkEventExpense, recordEventIncome, refundEventIncome, type EventMoneySummary } from './money.ts';
import { listEventResources, moveEvent, releaseResource, reserveResource } from './resources.ts';

export interface EventCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

const Uuid = z.string().regex(UUID_RE);
const Day = z.iso.datetime({ offset: true });
const listSchema = z.object({
  from: Day.optional(),
  to: Day.optional(),
  branchId: Uuid.optional(),
  typeId: Uuid.optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  customer: z.string().trim().min(1).max(100).optional(),
  responsibleId: Uuid.optional(),
  hasDue: z.enum(['true', 'false']).optional(),
  cursor: z.string().regex(/^\d{1,16}:[0-9a-f-]{36}$/i).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const canSeeMoney = (ctx: AccessContext, branchId: string) => can(ctx, 'event.money.view', { branchId });
/** Без event.money.view – только остаток к оплате (K20 №361). */
const moneyView = (ctx: AccessContext, branchId: string, s: EventMoneySummary) => (canSeeMoney(ctx, branchId) ? s : { dueKop: s.dueKop });
function lineView(ctx: AccessContext, branchId: string, l: EventLineDto): EventLineDto | Omit<EventLineDto, 'planCostKop'> {
  if (canSeeMoney(ctx, branchId)) return l;
  const { planCostKop: _hidden, ...rest } = l;
  void _hidden;
  return rest;
}

/** Строка в ответе команды: филиал – по её мероприятию. Ответ повтора по ключу принадлежит тому же сотруднику. */
async function lineResult(tx: Db, ctx: AccessContext, l: EventLineDto) {
  const e = await getEventRow(tx, l.eventId);
  return lineView(ctx, e!.branch_id, l);
}
/** №370: шаблоны сетевые – план виден тому, у кого право есть хотя бы в одной зоне (K20 №370). */
function packageView(ctx: AccessContext, p: EventPackageDto) {
  if (scopeFilter(ctx, 'event.money.view').kind !== 'none') return p;
  return { ...p, lines: p.lines.map(({ planCostKop: _hidden, ...rest }) => (void _hidden, rest)) };
}

/** №361. Строки по зоне; hasDue – постфильтр страницы: остаток считается из кассы, а не из строки мероприятия. */
async function listEvents(db: Db, ctx: AccessContext, raw: unknown) {
  const q = parseBody(listSchema, raw);
  const params: unknown[] = [];
  const where = [branchScopeSql('e.branch_id', scopeFilter(ctx, 'event.view'), params)];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (q.from) add('e.planned_start >= ?', new Date(q.from));
  if (q.to) add('e.planned_start < ?', new Date(q.to));
  if (q.branchId) add('e.branch_id = ?', q.branchId);
  if (q.typeId) add('e.type_id = ?', q.typeId);
  if (q.status) add('e.status = ?', q.status);
  if (q.responsibleId) add('e.responsible_staff_id = ?', q.responsibleId);
  if (q.customer) {
    const digits = q.customer.replace(/\D/g, '');
    params.push(`%${q.customer.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, digits.length >= 4 ? `%${digits}` : null);
    const n = params.length - 1;
    where.push(`(e.customer_name ILIKE $${n} OR ($${n + 1}::text IS NOT NULL AND e.customer_phone_e164 LIKE $${n + 1}))`);
  }
  if (q.cursor) {
    const [ms, id] = q.cursor.split(':');
    params.push(new Date(Number(ms)), id);
    where.push(`(e.created_at, e.id) < ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await db.query<EventRow & { request_hold_reminded: boolean }>(
    `SELECT x.*, EXISTS (SELECT 1 FROM app.event_resources er WHERE er.event_id = x.id AND er.status = 'active' AND er.request_hold_reminded_at IS NOT NULL) AS request_hold_reminded
       FROM (${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}) x ORDER BY x.created_at DESC, x.id DESC`,
    params,
  );
  const rows = r.rows.slice(0, q.limit);
  const items = [];
  for (const row of rows) {
    const summary = await eventMoneySummary(db, row.id);
    if (q.hasDue === 'true' && summary.dueKop <= 0) continue;
    if (q.hasDue === 'false' && summary.dueKop > 0) continue;
    items.push({ ...toEventDto(row), money: moneyView(ctx, row.branch_id, summary), requestHoldRemind: row.status === 'new_request' && row.request_hold_reminded });
  }
  const last = rows.at(-1);
  return { items, nextCursor: r.rows.length > q.limit && last ? `${last.created_at.getTime()}:${last.id}` : null };
}

/** №362 карточка: состав, ресурсы, чек-лист, брони, деньги и история; у Администратора – без сумм и различий в истории. */
async function eventCard(db: Db, ctx: AccessContext, id: string, clock: Clock) {
  const e = await getEventRow(db, id);
  if (!e) throw notFound();
  guardEvent(ctx, e.branch_id, 'event.view');
  const money = canSeeMoney(ctx, e.branch_id);
  const [lines, resources, checklist, summary, timeline, bookings] = [
    await listLines(db, e.id),
    await listEventResources(db, e.id, clock.now()),
    await listChecklist(db, e.id, dueOf),
    await eventMoneySummary(db, e.id),
    await objectTimeline(db, { objectType: 'event', objectId: e.id }, { limit: 100 }),
    await db.query<{ booking_id: string }>('SELECT booking_id FROM app.event_bookings WHERE event_id = $1 ORDER BY linked_at, booking_id', [e.id]),
  ];
  return {
    ...toEventDto(e),
    money: moneyView(ctx, e.branch_id, summary),
    lines: lines.map((l) => lineView(ctx, e.branch_id, l)),
    resources,
    checklist,
    bookingIds: bookings.rows.map((b) => b.booking_id),
    timeline: money ? timeline.items : timeline.items.map(({ before: _b, after: _a, ...rest }) => (void _b, void _a, rest)),
  };
}

/** №366: связь с обычной бронью – только ссылка; бронь того же филиала, не больше одного мероприятия (UNIQUE booking_id). */
async function linkBooking(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock): Promise<{ eventId: string; bookingId: string }> {
  const { bookingId } = parseBody(z.object({ bookingId: Uuid }), raw);
  const e = await lockEvent(tx, ctx, eventId, 'event.manage');
  const facts = await bookingLookup.facts(tx, bookingId);
  if (!facts || facts.branchId !== e.branch_id) throw notFound();
  const r = await tx.query(
    `INSERT INTO app.event_bookings (event_id, booking_id, linked_by, linked_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [e.id, bookingId, ctx.actor.staffId, clock.now()],
  );
  if (r.rowCount !== 1) {
    const same = await tx.query('SELECT 1 FROM app.event_bookings WHERE event_id = $1 AND booking_id = $2', [e.id, bookingId]);
    if (same.rowCount === 1) return { eventId: e.id, bookingId };
    throw new AppError('VALIDATION_FAILED', 400, 'Бронь уже связана с другим мероприятием', { field: 'bookingId' });
  }
  await writeAudit(tx, meta, { action: 'event.booking_linked', object: { type: 'event', id: e.id }, branchId: e.branch_id, after: { bookingId } }, clock);
  return { eventId: e.id, bookingId };
}

async function unlinkBooking(tx: Tx, ctx: AccessContext, eventId: string, bookingId: string, meta: AuditRequestMeta, clock: Clock): Promise<{ eventId: string; bookingId: string }> {
  const e = await lockEvent(tx, ctx, eventId, 'event.manage');
  if (!UUID_RE.test(bookingId)) throw notFound();
  const r = await tx.query('DELETE FROM app.event_bookings WHERE event_id = $1 AND booking_id = $2', [e.id, bookingId]);
  if (r.rowCount !== 1) throw notFound();
  await writeAudit(tx, meta, { action: 'event.booking_unlinked', object: { type: 'event', id: e.id }, branchId: e.branch_id, before: { bookingId } }, clock);
  return { eventId: e.id, bookingId };
}

type Run = (tx: pg.PoolClient, ctx: AccessContext, params: Record<string, string>, body: Record<string, unknown>, meta: AuditRequestMeta, key: string) => Promise<unknown>;
const objectBody = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

export async function eventCrmRoutes(app: FastifyInstance, deps: EventCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const idOf = (p: Record<string, string>, name = 'id') => {
    if (!UUID_RE.test(p[name] ?? '')) throw notFound();
    return p[name]!;
  };

  function command(operation: string, action: AuditAction, run: Run, status = 200) {
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
            { scope: idempotencyScope('staff', access.actor.staffId, `event.${operation}`), key, request: { route: `${request.method} ${request.routeOptions.url}`, params, body }, clock },
            async () => ({ status, body: await run(tx, access, params, body, meta, key) }),
          ),
        );
      } catch (err) {
        if (err instanceof AppError && err.code === 'FORBIDDEN') {
          const id = params.id && UUID_RE.test(params.id) ? params.id : null;
          await writeDenied(deps.pool, meta, { action, object: { type: 'event', id }, reason: `${err.code}: ${String((err.details as { action?: string } | undefined)?.action ?? operation)}`, result: 'denied' }, clock);
        }
        throw err;
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }
  const read = <T>(handler: (ctx: AccessContext, request: FastifyRequest) => Promise<T>) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { access } = await deps.authenticate(request, reply);
    return handler(access, request);
  };
  const paramsOf = (r: FastifyRequest) => r.params as Record<string, string>;

  // №361, №362
  app.get('/events', read((ctx, r) => listEvents(deps.pool, ctx, r.query)));
  app.post('/events', command('create', 'event.created', (tx, ctx, _p, body, meta) => createEvent(tx, ctx, body, meta, clock), 201));
  app.get('/events/:id', read((ctx, r) => eventCard(deps.pool, ctx, idOf(paramsOf(r)), clock)));
  app.patch('/events/:id', command('update', 'event.updated', (tx, ctx, p, body, meta) => updateEvent(tx, ctx, idOf(p), body, meta, clock)));

  // №363: при отмене – что требует решения, деньги по праву
  app.post(
    '/events/:id/status',
    command('status', 'event.status_changed', async (tx, ctx, p, body, meta) => {
      const r = await changeEventStatus(tx, ctx, idOf(p), body, meta, clock);
      const event: EventDto = r.event;
      if (!r.needsDecision) return { event, needsDecision: null };
      const s = await eventMoneySummary(tx, event.id);
      const money = canSeeMoney(ctx, event.branchId) ? { dueKop: s.dueKop, receivedKop: s.receivedKop } : { dueKop: s.dueKop };
      return { event, needsDecision: { ...r.needsDecision, ...money } };
    }),
  );

  // №364 состав
  app.post('/events/:id/lines', command('line.add', 'event.line_added', async (tx, ctx, p, body, meta) => lineResult(tx, ctx, await addLine(tx, ctx, idOf(p), body, meta, clock)), 201));
  app.patch('/event-lines/:id', command('line.update', 'event.line_updated', async (tx, ctx, p, body, meta) => lineResult(tx, ctx, await updateLine(tx, ctx, idOf(p), body, meta, clock))));
  app.post('/event-lines/:id/remove', command('line.remove', 'event.line_removed', async (tx, ctx, p, body, meta) => lineResult(tx, ctx, await removeLine(tx, ctx, idOf(p), body, meta, clock))));
  app.post('/events/:id/apply-package', command('package.apply', 'event.package_applied', async (tx, ctx, p, body, meta) => {
    const items = await applyPackage(tx, ctx, idOf(p), body, meta, clock);
    const e = await getEventRow(tx, idOf(p));
    return { items: items.map((l) => lineView(ctx, e!.branch_id, l)) };
  }));

  // №365 ресурсы и перенос
  app.post('/events/:id/resources', command('resource.reserve', 'event.resource_reserved', (tx, ctx, p, body, meta) => reserveResource(tx, ctx, idOf(p), body, meta, clock), 201));
  app.post(
    '/events/:id/resources/:rid/release',
    command('resource.release', 'event.resource_released', async (tx, ctx, p, body, meta) => {
      await releaseResource(tx, ctx, idOf(p), { ...body, eventResourceId: idOf(p, 'rid') }, meta, clock);
      return { released: true };
    }),
  );
  app.post('/events/:id/move', command('move', 'event.rescheduled', (tx, ctx, p, body, meta) => moveEvent(tx, ctx, idOf(p), body, meta, clock)));

  // №366 связанные брони
  app.post('/events/:id/bookings', command('booking.link', 'event.booking_linked', (tx, ctx, p, body, meta) => linkBooking(tx, ctx, idOf(p), body, meta, clock)));
  app.post('/events/:id/bookings/:bid/unlink', command('booking.unlink', 'event.booking_unlinked', (tx, ctx, p, _b, meta) => unlinkBooking(tx, ctx, idOf(p), idOf(p, 'bid'), meta, clock)));

  // №367 чек-лист
  app.get('/events/:id/checklist', read(async (ctx, r) => {
    const e = await getEventRow(deps.pool, idOf(paramsOf(r)));
    if (!e) throw notFound();
    guardEvent(ctx, e.branch_id, 'event.manage');
    return { items: await listChecklist(deps.pool, e.id, dueOf) };
  }));
  app.post('/events/:id/checklist', command('checklist.add', 'event.checklist_changed', (tx, ctx, p, body, meta) => addChecklistItem(tx, ctx, idOf(p), body, meta, clock), 201));
  app.patch(
    '/events/:id/checklist',
    command('checklist.update', 'event.checklist_changed', async (tx, ctx, p, body, meta) => {
      const { itemId } = parseBody(z.object({ itemId: Uuid }).loose(), body);
      const own = await tx.query('SELECT 1 FROM app.event_checklist WHERE id = $1 AND event_id = $2', [itemId, idOf(p)]);
      if (own.rowCount !== 1) throw notFound();
      const { itemId: _skip, ...patch } = body;
      void _skip;
      return updateChecklistItem(tx, ctx, itemId, patch, meta, clock);
    }),
  );

  // №368, №369 деньги
  app.get('/events/:id/money', read(async (ctx, r) => {
    const e = await getEventRow(deps.pool, idOf(paramsOf(r)));
    if (!e) throw notFound();
    guardEvent(ctx, e.branch_id, 'event.money.view');
    return { summary: await eventMoneySummary(deps.pool, e.id), operations: await eventOperations(deps.pool, e) };
  }));
  app.post('/events/:id/income', command('income', 'finance.operation.created', (tx, ctx, p, body, meta, key) => recordEventIncome(tx, ctx, idOf(p), body, meta, { idempotencyKey: key, clock }), 201));
  app.post('/events/:id/refund', command('refund', 'finance.operation.created', (tx, ctx, p, body, meta, key) => refundEventIncome(tx, ctx, idOf(p), body, meta, { idempotencyKey: key, clock }), 201));
  app.post('/events/:id/expense', command('expense', 'finance.operation.created', (tx, ctx, p, body, meta, key) => addEventExpense(tx, ctx, idOf(p), body, meta, { idempotencyKey: key, clock }), 201));
  app.post(
    '/events/:id/expense/link',
    command('expense.link', 'event.money_linked', async (tx, ctx, p, body, meta) => {
      await linkEventExpense(tx, ctx, idOf(p), body, meta, { clock });
      return { linked: true };
    }, 201),
  );

  // №370 справочники: чтение – event.view в любой зоне, правка – Владелец; архив вместо удаления
  const anyZone = (ctx: AccessContext) => {
    if (scopeFilter(ctx, 'event.view').kind === 'none') throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'event.view' });
  };
  app.get('/event-packages', read(async (ctx, r) => {
    anyZone(ctx);
    const q = parseBody(z.object({ typeId: Uuid.optional(), includeArchived: z.enum(['true', 'false']).optional() }), r.query);
    const items = await listPackages(deps.pool, { typeId: q.typeId, includeArchived: q.includeArchived === 'true' });
    return { items: items.map((x) => packageView(ctx, x)) };
  }));
  app.post('/event-packages', command('package.create', 'event.package.created', (tx, ctx, _p, body, meta) => createPackage(tx, ctx, body, meta, clock), 201));
  app.patch('/event-packages/:id', command('package.update', 'event.package.updated', (tx, ctx, p, body, meta) => updatePackage(tx, ctx, idOf(p), body, meta, clock)));
  app.get('/event-types', read(async (ctx) => {
    anyZone(ctx);
    return { items: await listEventTypes(deps.pool) };
  }));
  app.post('/event-types', command('type.create', 'event.type.created', (tx, ctx, _p, body, meta) => createEventType(tx, ctx, body, meta, clock), 201));
  app.patch('/event-types/:id', command('type.update', 'event.type.updated', (tx, ctx, p, body, meta) => updateEventType(tx, ctx, idOf(p), body, meta, clock)));
}
