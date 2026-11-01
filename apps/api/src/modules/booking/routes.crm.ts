// S1-13. K11 №2–12: CRM-маршруты брони на /api/crm/v1 – календарь филиала (брони + удержания + блокировки по
// ресурсам), список с «требует решения» (R-08), бронь администратором (с клиентом или без профиля), карточка с
// хронологией, отмена, перенос, приход, завершение, неявка, исправление, служебный комментарий.
// Тонкий слой: разбор схемами packages/contracts/src/crm/booking.ts → команда (change.ts, visit.ts) в транзакции
// занятия (повтор при 40P01) под Idempotency-Key → ответ CrmBooking. Права – K1 по филиалу брони: вне зоны – 404 с
// телом несуществующей, в зоне без права – 403 и запись отказа в аудит отдельной транзакцией (ADR 0005 п.8).
// Чужие данные: телефон клиента – только маскированный (03 §14), у удержания – без данных посетителя.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import {
  BookingListQuery, CalendarQuery, CrmCancelBody, CrmCreateBooking, CrmNoShowBody, CrmPatchBooking, CrmRescheduleBody, CrmRevertVisitBody, CrmRowVersionBody,
  type CalendarDto, type CalendarItem, type CrmBooking, type CrmBookingRow,
} from '../../../../../packages/contracts/src/crm/booking.ts';
import { objectTimeline, writeAudit, writeDenied, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { can, scopeFilter, branchScopeSql, type AccessContext } from '../../core/permissions.ts';
import { addDays, branchDay, parseLocalDate, systemClock, toPgRange, type Clock, type LocalDate } from '../../core/time.ts';
import { getClientRefs } from '../clients/index.ts';
import { getBranch, openIntervals } from '../network/index.ts';
import { compositionsDuring, listBookableResources } from '../resources/index.ts';
import { cancelBooking, checkRowVersion, createStaffBooking, guardStaff, lockBooking, notFound, rescheduleBooking, staffDenialOf } from './change.ts';
import type { BookingStatus } from './confirm.ts';
import { runOccupancyCommand } from './occupancy.ts';
import { completeVisit, markArrived, markNoShow, revertVisit } from './visit.ts';

export interface BookingCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DAYS = 7;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}
const iso = (d: Date) => d.toISOString();
const nameOf = (c: { firstName: string | null; lastName: string | null }) => [c.firstName, c.lastName].filter((x) => x).join(' ') || null;

// ---- чтение

interface BookingRow {
  id: string; number: string; branch_id: string; client_id: string; status: BookingStatus; resource_id: string; resource_name: string; s: Date; e: Date;
  source: 'site' | 'crm'; row_version: number; current_version: number; price_kop: string; timezone: string; internal_comment: string | null;
  cancelled_at: Date | null; cancelled_by_type: string | null; unit_ids: string[]; cancel_reason_name: string | null; cancel_comment: string | null; arrived_at: Date | null; completed_at: Date | null;
}
const ROW_SQL = `SELECT b.id, b.number, b.branch_id, b.client_id, b.status, b.resource_id, v.resource_snapshot ->> 'name' AS resource_name,
    lower(b.period) AS s, upper(b.period) AS e, b.source, b.row_version, b.current_version, b.price_kop, v.branch_timezone AS timezone, b.internal_comment,
    b.cancelled_at, b.cancelled_by_type, v.unit_ids, dr.name AS cancel_reason_name, b.cancel_comment, vi.arrived_at, vi.completed_at
  FROM app.bookings b JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
  LEFT JOIN app.dict_reasons dr ON dr.id = b.cancel_reason_id
  LEFT JOIN app.visits vi ON vi.booking_id = b.id AND vi.status = 'active'`;

const needsDecision = (r: { status: BookingStatus; e: Date }, now: Date) => r.status === 'confirmed' && r.e.getTime() <= now.getTime();

async function toRows(db: Db, rows: BookingRow[], now: Date): Promise<Array<CrmBookingRow & { raw: BookingRow }>> {
  const clients = await getClientRefs(db, rows.map((r) => r.client_id));
  return rows.map((r) => {
    const c = clients.get(r.client_id);
    return {
      id: r.id, number: Number(r.number), status: r.status, resourceName: r.resource_name, start: iso(r.s), end: iso(r.e),
      client: { id: r.client_id, name: c ? nameOf(c) : null, phoneMasked: c?.phoneMasked ?? '', isGuest: c?.status === 'guest' },
      source: r.source, rowVersion: r.row_version, needsDecision: needsDecision(r, now), raw: r,
    };
  });
}
const stripRaw = <T extends { raw: unknown }>(x: T): Omit<T, 'raw'> => {
  const { raw: _raw, ...rest } = x;
  void _raw;
  return rest;
};

/** Действия карточки (считает сервер, K11): по статусу, времени и правам сотрудника на филиал брони. */
function allowedActions(ctx: AccessContext, r: BookingRow, now: Date): CrmBooking['allowedActions'] {
  const at = { branchId: r.branch_id };
  const out: CrmBooking['allowedActions'] = [];
  if (r.status === 'confirmed') {
    if (can(ctx, 'booking.cancel', at)) out.push('cancel');
    if (can(ctx, 'booking.reschedule', at) && r.s.getTime() > now.getTime()) out.push('reschedule');
    if (can(ctx, 'booking.visit.mark', at)) out.push('arrive');
    if (can(ctx, 'booking.visit.mark', at) && r.s.getTime() <= now.getTime()) out.push('no_show');
  }
  if (r.status === 'arrived' && can(ctx, 'booking.visit.mark', at)) out.push('complete');
  if ((r.status === 'arrived' || r.status === 'no_show') && can(ctx, 'booking.visit.correct', at)) out.push('revert_visit');
  return out;
}

/** CrmBooking по id; вне зоны (schedule.view) – NOT_FOUND. */
export async function crmBooking(db: Db, ctx: AccessContext, bookingId: string, now: Date): Promise<CrmBooking> {
  if (!UUID_RE.test(bookingId)) throw notFound();
  const r = (await db.query<BookingRow>(`${ROW_SQL} WHERE b.id = $1`, [bookingId])).rows[0];
  if (!r || !can(ctx, 'schedule.view', { branchId: r.branch_id })) throw notFound();
  const [row] = await toRows(db, [r], now);
  const versions = await db.query<{ version: number; name: string; s: Date; e: Date; price_kop: string; created_at: Date; reason: string | null }>(
    `SELECT version, resource_snapshot ->> 'name' AS name, lower(period) AS s, upper(period) AS e, price_kop, created_at, reason FROM journal.booking_versions WHERE booking_id = $1 ORDER BY version`,
    [r.id],
  );
  // кто отменил – роль автора; имя сотрудника – в хронологии (actorId), таблица staff – модуля staff (ADR 0002 п.1)
  const by = r.cancelled_by_type === 'staff' ? 'сотрудник' : r.cancelled_by_type === 'client' ? 'клиент' : 'система';
  return {
    ...stripRaw(row!),
    branchId: r.branch_id, timezone: r.timezone, resourceId: r.resource_id, currentVersion: r.current_version, priceKop: Number(r.price_kop), internalComment: r.internal_comment,
    cancel: r.cancelled_at ? { at: iso(r.cancelled_at), by, reasonName: r.cancel_reason_name, comment: r.cancel_comment } : null,
    visit: r.arrived_at ? { arrivedAt: iso(r.arrived_at), completedAt: r.completed_at ? iso(r.completed_at) : null } : null,
    versions: versions.rows.map((v) => ({ version: v.version, resourceName: v.name, start: iso(v.s), end: iso(v.e), priceKop: Number(v.price_kop), createdAt: iso(v.created_at), reason: v.reason })),
    allowedActions: allowedActions(ctx, r, now),
  };
}

/** K11 №2: календарь филиала за [from, to] (≤ 7 дней) – занятость по ресурсам тем же составом, что у availability. */
async function calendar(db: Db, ctx: AccessContext, branchId: string, raw: unknown, now: Date): Promise<CalendarDto> {
  const q = parse(CalendarQuery, raw);
  const branch = UUID_RE.test(branchId) ? await getBranch(db, branchId) : null;
  if (!branch || !can(ctx, 'schedule.view', { branchId: branch.id })) throw notFound();
  let from: LocalDate;
  let to: LocalDate;
  try {
    from = parseLocalDate(q.from);
    to = parseLocalDate(q.to);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверная дата', { field: 'from' });
  }
  if (to < from) throw new AppError('VALIDATION_FAILED', 400, 'Конец периода раньше начала', { field: 'to' });
  if (addDays(from, MAX_DAYS - 1) < to) throw new AppError('RANGE_TOO_LONG', 422, `Период не длиннее ${MAX_DAYS} дней`, { maxDays: MAX_DAYS });
  const range = { start: branchDay(from, branch.timezone).start, end: branchDay(to, branch.timezone).end };
  const filter = q.resourceIds ? new Set(q.resourceIds.split(',').filter((x) => x !== '').map((x) => x.toLowerCase())) : null;
  if (filter && ![...filter].every((x) => UUID_RE.test(x))) throw new AppError('VALIDATION_FAILED', 400, 'Неверный ресурс', { field: 'resourceIds' });
  const resources = (await listBookableResources(db, branch.id)).filter((r) => !filter || filter.has(r.id));
  const comps = await compositionsDuring(db, resources.map((r) => r.id), range.start, range.end);
  /** Ресурсы, чей состав на момент at содержит любую из единиц (комната целиком ↔ места VR). */
  const resourcesOf = (unitIds: string[], at: Date) =>
    resources
      .filter((r) => (comps.get(r.id) ?? []).some((c) => unitIds.includes(c.unitId) && c.validFrom.getTime() <= at.getTime() && (c.validTo === null || c.validTo.getTime() > at.getTime())))
      .map((r) => r.id);
  const period = toPgRange(range);
  const bookings = await db.query<BookingRow>(
    `${ROW_SQL} WHERE b.branch_id = $1 AND b.period && $2::tstzrange AND b.status NOT IN ('cancelled_by_client','cancelled_by_club') ORDER BY lower(b.period), b.number`,
    [branch.id, period],
  );
  const holds = await db.query<{ id: string; unit_ids: string[]; s: Date; e: Date; expires_at: Date }>(
    `SELECT hi.id, hi.unit_ids, lower(hi.period) AS s, upper(hi.period) AS e, h.expires_at FROM app.hold_items hi JOIN app.holds h ON h.id = hi.hold_id
     WHERE h.branch_id = $1 AND h.status = 'active' AND h.expires_at > $3 AND hi.status = 'active' AND hi.period && $2::tstzrange ORDER BY lower(hi.period), hi.id`,
    [branch.id, period, now],
  );
  const blocks = await db.query<{ id: string; unit_ids: string[]; s: Date; e: Date; reason_name: string }>(
    `SELECT b.id, array_agg(u.unit_id ORDER BY u.unit_id) AS unit_ids, lower(b.period) AS s, upper(b.period) AS e, r.name AS reason_name
     FROM app.resource_blocks b JOIN app.resource_block_units u ON u.block_id = b.id AND u.active JOIN app.dict_reasons r ON r.id = b.reason_id
     WHERE b.branch_id = $1 AND b.status = 'active' AND b.period && $2::tstzrange GROUP BY b.id, r.name ORDER BY lower(b.period), b.id`,
    [branch.id, period],
  );
  const rows = await toRows(db, bookings.rows, now);
  const items: CalendarItem[] = [];
  for (const [k, b] of bookings.rows.entries()) {
    const row = rows[k]!;
    items.push({ kind: 'booking', id: b.id, resourceIds: resourcesOf(b.unit_ids, b.s), start: iso(b.s), end: iso(b.e), booking: { number: row.number, status: b.status, clientName: row.client.name, phoneMasked: row.client.phoneMasked, needsDecision: row.needsDecision } });
  }
  for (const h of holds.rows) items.push({ kind: 'hold', id: h.id, resourceIds: resourcesOf(h.unit_ids, h.s), start: iso(h.s), end: iso(h.e), hold: { expiresAt: iso(h.expires_at) } });
  // блокировка – на всём периоде: ресурс, чей состав содержал единицу хотя бы в начале периода или блокировки
  for (const bl of blocks.rows) {
    const at = bl.s.getTime() > range.start.getTime() ? bl.s : range.start;
    items.push({ kind: 'block', id: bl.id, resourceIds: resourcesOf(bl.unit_ids, at), start: iso(bl.s), end: iso(bl.e), block: { reasonName: bl.reason_name } });
  }
  const open = [];
  for (let d = from; d <= to; d = addDays(d, 1)) open.push(...(await openIntervals(db, { branchId: branch.id, date: d })));
  return {
    branchId: branch.id, timezone: branch.timezone, from, to,
    openIntervals: open.map((i) => ({ start: iso(i.start), end: iso(i.end) })),
    resources: resources.map((r) => ({ id: r.id, name: r.name, type: r.type, roomName: r.roomName })),
    items: items.filter((i) => !filter || i.resourceIds.length > 0),
  };
}

/** K11 №3: брони филиала, порядок (start, number), курсор – base64url(JSON [start, number]). */
async function listBookings(db: Db, ctx: AccessContext, branchId: string, raw: unknown, now: Date): Promise<{ items: CrmBookingRow[]; nextCursor: string | null }> {
  const q = parse(BookingListQuery, raw);
  const branch = UUID_RE.test(branchId) ? await getBranch(db, branchId) : null;
  if (!branch || !can(ctx, 'schedule.view', { branchId: branch.id })) throw notFound();
  const params: unknown[] = [branch.id];
  const where = ['b.branch_id = $1'];
  if (q.date) {
    let date: LocalDate;
    try {
      date = parseLocalDate(q.date);
    } catch {
      throw new AppError('VALIDATION_FAILED', 400, 'Неверная дата', { field: 'date' });
    }
    params.push(toPgRange(branchDay(date, branch.timezone)));
    where.push(`b.period && $${params.length}::tstzrange`);
  }
  if (q.status) {
    const st = q.status.split(',').filter((x) => x !== '');
    params.push(st);
    where.push(`b.status = ANY($${params.length}::text[])`);
  }
  if (q.needsDecision === 'true') {
    params.push(now);
    where.push(`b.status = 'confirmed' AND upper(b.period) <= $${params.length}`);
  }
  // зона уже проверена по филиалу; scopeFilter – вторая страховка в SQL (K11 «фильтр зоны – scopeFilter в SQL»)
  where.push(branchScopeSql('b.branch_id', scopeFilter(ctx, 'schedule.view'), params));
  if (q.cursor) {
    let c: unknown;
    try {
      c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
    } catch {
      c = null;
    }
    if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'number' || Number.isNaN(Date.parse(c[0]))) throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
    params.push(new Date(c[0]), c[1]);
    where.push(`(lower(b.period), b.number) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }
  const r = await db.query<BookingRow>(`${ROW_SQL} WHERE ${where.join(' AND ')} ORDER BY lower(b.period), b.number LIMIT ${q.limit + 1}`, params);
  const page = r.rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: (await toRows(db, page, now)).map(stripRaw),
    nextCursor: r.rows.length > q.limit && last ? Buffer.from(JSON.stringify([iso(last.s), Number(last.number)])).toString('base64url') : null,
  };
}

/** K11 №12: служебный комментарий (booking.create), rowVersion. */
async function patchBooking(tx: Tx, ctx: AccessContext, bookingId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock): Promise<void> {
  const input = parse(CrmPatchBooking, raw);
  const b = await lockBooking(tx, bookingId);
  if (!b) throw notFound();
  guardStaff(ctx, b, 'booking.create', 'booking.updated');
  checkRowVersion(b, input.rowVersion);
  const comment = input.internalComment?.trim() ? input.internalComment.trim() : null;
  const before = await tx.query<{ internal_comment: string | null }>('SELECT internal_comment FROM app.bookings WHERE id = $1', [b.id]);
  await tx.query('UPDATE app.bookings SET internal_comment = $2, row_version = row_version + 1 WHERE id = $1', [b.id, comment]);
  await writeAudit(tx, meta, { action: 'booking.updated', object: { type: 'booking', id: b.id }, branchId: b.branchId, before: { internalComment: before.rows[0]?.internal_comment ?? null }, after: { internalComment: comment } }, clock);
}

// ---- HTTP

export async function bookingCrmRoutes(app: FastifyInstance, deps: BookingCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  /** Команда: ключ → транзакция занятия (повтор при 40P01) → runIdempotent → CrmBooking после фиксации. */
  const command = (operation: string, status: number, run: (tx: Tx, ctx: AccessContext, id: string, body: unknown, meta: AuditRequestMeta) => Promise<string>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      let result;
      try {
        result = await runOccupancyCommand(deps.pool, (tx) =>
          runIdempotent(
            tx,
            { scope: idempotencyScope('staff', access.actor.staffId, `booking.${operation}`), key, request: { route: `${request.method} ${request.routeOptions.url}`, params, body: request.body ?? null }, clock },
            async () => {
              const id = await run(tx, access, Object.values(params)[0] ?? '', request.body, meta);
              return { status, body: await crmBooking(tx, access, id, clock.now()) };
            },
          ),
        );
      } catch (err) {
        const d = staffDenialOf(err);
        if (d) await writeDenied(deps.pool, meta, { action: d.action as `${string}.${string}`, object: { type: 'booking', id: d.bookingId }, branchId: d.branchId, reason: d.reason, result: 'denied' }, clock);
        throw err;
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  const viewer = async (request: FastifyRequest, reply: FastifyReply) => (await deps.authenticate(request, reply)).access;
  const p = (request: FastifyRequest) => request.params as Record<string, string>;

  app.get('/branches/:branchId/calendar', async (request, reply) => calendar(deps.pool, await viewer(request, reply), p(request).branchId!, request.query, clock.now()));
  app.get('/branches/:branchId/bookings', async (request, reply) => listBookings(deps.pool, await viewer(request, reply), p(request).branchId!, request.query, clock.now()));
  app.get('/bookings/:bookingId', async (request, reply) => {
    const ctx = await viewer(request, reply);
    const b = await crmBooking(deps.pool, ctx, p(request).bookingId!, clock.now());
    const t = await objectTimeline(deps.pool, { objectType: 'booking', objectId: b.id }, { limit: 100 });
    return {
      ...b,
      timeline: t.items.map((e) => ({ id: e.id, at: iso(e.at), action: e.action, actorType: e.actorType, actorId: e.actorId, actorRole: e.actorRole, before: e.before, after: e.after, reason: e.reason, result: e.result })),
    };
  });

  app.post(
    '/branches/:branchId/bookings',
    command('create', 201, (tx, ctx, branchId, body, meta) => {
      const input = parse(CrmCreateBooking, body);
      return createStaffBooking(tx, { ctx, branchId, resourceId: input.resourceId, start: new Date(input.start), end: new Date(input.end), client: input.client, internalComment: input.internalComment }, meta, clock);
    }),
  );
  app.post(
    '/bookings/:bookingId/cancel',
    command('cancel', 200, async (tx, ctx, id, body, meta) => {
      const input = parse(CrmCancelBody, body);
      return (await cancelBooking(tx, id, { kind: 'staff', ctx, rowVersion: input.rowVersion, initiator: input.initiator, reasonId: input.reasonId, comment: input.comment }, meta, clock)).id;
    }),
  );
  app.post(
    '/bookings/:bookingId/reschedule',
    command('reschedule', 200, async (tx, ctx, id, body, meta) => {
      const input = parse(CrmRescheduleBody, body);
      return (await rescheduleBooking(tx, id, { ctx, rowVersion: input.rowVersion, resourceId: input.resourceId, start: new Date(input.start), end: new Date(input.end), reason: input.reason }, meta, clock)).id;
    }),
  );
  app.post('/bookings/:bookingId/arrive', command('arrive', 200, async (tx, ctx, id, body, meta) => (await markArrived(tx, id, { ctx, ...parse(CrmRowVersionBody, body) }, meta, clock)).id));
  app.post('/bookings/:bookingId/complete', command('complete', 200, async (tx, ctx, id, body, meta) => (await completeVisit(tx, id, { ctx, ...parse(CrmRowVersionBody, body) }, meta, clock)).id));
  app.post('/bookings/:bookingId/no-show', command('no_show', 200, async (tx, ctx, id, body, meta) => (await markNoShow(tx, id, { ctx, ...parse(CrmNoShowBody, body) }, meta, clock)).id));
  app.post('/bookings/:bookingId/revert-visit', command('revert_visit', 200, async (tx, ctx, id, body, meta) => (await revertVisit(tx, id, { ctx, ...parse(CrmRevertVisitBody, body) }, meta, clock)).id));
  app.patch(
    '/bookings/:bookingId',
    command('update', 200, async (tx, ctx, id, body, meta) => {
      await patchBooking(tx, ctx, id, body, meta, clock);
      return id;
    }),
  );
}
