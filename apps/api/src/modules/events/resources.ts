// S3-52. Ресурсы мероприятия и платный праздник (K20 §4, 20 §4.10 – R-22). Комната занимается через провайдеры booking
// (occupyForEvent / releaseEvent / moveEventOccupancy, K6): источник занятости – строка event_resources, конфликт с бронью
// и удержанием даёт EXCLUDE той же таблицы, двойной брони нет. Правила праздника – настройки event.party.*: только комната
// целиком, непрерывно ≥ 120 минут (два интервала встык одним не считаются), формат 2 ч / 3+ ч / весь день. Перенос – в одной
// транзакции: конфликт откатывает всё, прежнее время остаётся (16 §9). Тарифы K6 quote здесь не вызываются (K20 §4).
// Комната под new_request держится не дольше event.request_hold_hours: за event.request_hold_remind_hours – отметка
// «напомнить ответственному» (лента CRM – Э4), по истечении задача снимает удержание один раз, мероприятие остаётся.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { resolveSetting, resolveSettings } from '../../core/settings.ts';
import { contains, durationMinutes, fromPgRange, instantToLocal, interval, systemClock, toPgRange, type Clock, type Interval, type TimeZone } from '../../core/time.ts';
import { moveEventOccupancy, occupyForEvent, registerEventSourceResolver, releaseEvent } from '../booking/providers.ts';
import { openIntervals } from '../network/index.ts';
import { getResource } from '../resources/index.ts';
import { assertPartyGuests, assertRowVersion, getEventRow, isClosed, lockEvent, notFound, parseBody, requireReason, toEventDto, UUID_RE, type EventDto, type EventRow } from './events.ts';

export interface EventResourceDto {
  id: string;
  eventId: string;
  resourceId: string;
  resourceName: string;
  resourceType: string;
  start: string;
  end: string;
  unitIds: string[];
  status: 'active' | 'released';
  releaseReason: string | null;
  /** Только у активной комнаты под new_request: когда снимется и пора ли напомнить (K20 §4). */
  requestHold: { expiresAt: string; remind: boolean } | null;
}

const Uuid = z.string().regex(UUID_RE);
const At = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const reserveSchema = z.object({ resourceId: Uuid, start: At, end: At });
const releaseSchema = z.object({ eventResourceId: Uuid, reason: z.string().max(2000).optional() });
const moveSchema = z.object({
  rowVersion: z.number().int(),
  plannedStart: At,
  plannedEnd: At,
  resources: z.array(z.object({ eventResourceId: Uuid, resourceId: Uuid, start: At, end: At })).max(20).default([]),
  reason: z.string().max(2000).optional(),
});

function periodOf(start: Date, end: Date): Interval {
  if (start.getTime() >= end.getTime()) throw new AppError('VALIDATION_FAILED', 400, 'Конец раньше начала', { field: 'end' });
  return interval(start, end);
}

function assertOpen(e: EventRow): void {
  if (isClosed(e.status)) throw new AppError('EVENT_CLOSED', 409, 'Мероприятие завершено – ресурсы не меняются', { status: e.status });
}

/** График филиала в дату начала: интервал целиком внутри открытого (K6 OUTSIDE_SCHEDULE). */
async function assertInSchedule(db: Db, e: EventRow, r: { id: string; roomId: string | null }, period: Interval): Promise<Interval[]> {
  const open = await openIntervals(db, { branchId: e.branch_id, date: instantToLocal(period.start, e.timezone as TimeZone).date, roomId: r.roomId, resourceId: r.id });
  if (!open.some((i) => contains(i, period))) throw new AppError('OUTSIDE_SCHEDULE', 409, 'В это время филиал не работает');
  return open;
}

/** Правила платного праздника (K20 §4, TC-13). Гости перепроверяются: настройка могла измениться с момента ввода. */
async function assertPartyRules(db: Db, e: EventRow, resource: { type: string }, period: Interval, open: Interval[], now: Date): Promise<void> {
  if (e.type_code !== 'birthday_party') return;
  if (resource.type !== 'room_whole') throw new AppError('PARTY_RESOURCE_INVALID', 422, 'Праздник проходит только в комнате VR+PS4 целиком', { resourceType: resource.type });
  const s = await resolveSetting(db, 'event.party.min_minutes', { branchId: e.branch_id }, now);
  const minutes = durationMinutes(period);
  if (minutes < s.value) throw new AppError('PARTY_TOO_SHORT', 422, `Праздник – непрерывно не меньше ${s.value} минут`, { minMinutes: s.value });
  if (e.party_guests !== null) await assertPartyGuests(db, e.branch_id, e.party_guests, now);
  if (e.participants_count !== null) await assertPartyGuests(db, e.branch_id, e.participants_count, now);
  const fits =
    e.party_format === null ||
    (e.party_format === 'h2' && minutes === 120) ||
    (e.party_format === 'h3plus' && minutes >= 180) ||
    (e.party_format === 'full_day' && open.some((i) => i.start.getTime() === period.start.getTime() && i.end.getTime() === period.end.getTime()));
  if (!fits) throw new AppError('PARTY_FORMAT_MISMATCH', 422, 'Длительность не соответствует формату праздника', { format: e.party_format });
}

async function checkPlacement(db: Db, e: EventRow, resourceId: string, period: Interval, now: Date): Promise<void> {
  const r = await getResource(db, resourceId);
  if (!r || r.branchId !== e.branch_id) throw notFound();
  const open = await assertInSchedule(db, e, r, period);
  await assertPartyRules(db, e, r, period, open, now);
}

/** Занять ресурс (K6 occupy, ошибки K6 – как есть). В любом незавершённом статусе; client_time мероприятие не пишет. */
export async function reserveResource(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<{ eventResourceId: string }> {
  const input = parseBody(reserveSchema, raw);
  const e = await lockEvent(tx, ctx, eventId, 'event.manage');
  assertOpen(e);
  const now = clock.now();
  const period = periodOf(input.start, input.end);
  await checkPlacement(tx, e, input.resourceId, period, now);
  const id = randomUUID();
  const { unitIds } = await occupyForEvent(tx, { branchId: e.branch_id, resourceId: input.resourceId, eventResourceId: id, period });
  await tx.query(
    `INSERT INTO app.event_resources (id, event_id, branch_id, resource_id, period, unit_ids, reserved_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, e.id, e.branch_id, input.resourceId, toPgRange(period), unitIds, now],
  );
  // дата мероприятия не задана – берётся из занятого времени
  if (!e.planned_start || !e.planned_end) await tx.query('UPDATE app.events SET planned_start = $2, planned_end = $3, row_version = row_version + 1 WHERE id = $1', [e.id, period.start, period.end]);
  await writeAudit(tx, meta, { action: 'event.resource_reserved', object: { type: 'event', id: e.id }, branchId: e.branch_id, after: { eventResourceId: id, resourceId: input.resourceId, start: period.start, end: period.end } }, clock);
  return { eventResourceId: id };
}

async function activeRow(tx: Db, eventId: string, eventResourceId: string): Promise<{ id: string; resource_id: string; period: string }> {
  const r = await tx.query<{ id: string; resource_id: string; period: string }>(`SELECT id, resource_id, period::text FROM app.event_resources WHERE id = $1 AND event_id = $2 AND status = 'active'`, [eventResourceId, eventId]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

/** Снять занятие одной строки; мероприятие блокирует вызывающий. */
async function releaseOne(tx: Tx, e: { id: string; branch_id: string }, eventResourceId: string, reason: string, now: Date, meta: AuditRequestMeta, clock: Clock): Promise<void> {
  const row = await activeRow(tx, e.id, eventResourceId);
  await releaseEvent(tx, row.id, 'released', clock);
  await tx.query(`UPDATE app.event_resources SET status = 'released', released_at = $2, release_reason = $3 WHERE id = $1`, [row.id, now, reason]);
  const p = fromPgRange(row.period);
  await writeAudit(tx, meta, { action: 'event.resource_released', object: { type: 'event', id: e.id }, branchId: e.branch_id, before: { eventResourceId: row.id, resourceId: row.resource_id, start: p.start, end: p.end }, reason }, clock);
}

export async function releaseResource(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<void> {
  const input = parseBody(releaseSchema, raw);
  const e = await lockEvent(tx, ctx, eventId, 'event.manage');
  assertOpen(e);
  await releaseOne(tx, e, input.eventResourceId, requireReason(input.reason), clock.now(), meta, clock);
}

/** Перенос (K20 §4, 11 §10): всё в транзакции вызывающего; конфликт нового времени откатывает её – прежнее время цело. */
export async function moveEvent(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventDto> {
  const input = parseBody(moveSchema, raw);
  const e = await lockEvent(tx, ctx, eventId, 'event.manage');
  assertRowVersion(e, input.rowVersion);
  assertOpen(e);
  const reason = requireReason(input.reason);
  periodOf(input.plannedStart, input.plannedEnd);
  const now = clock.now();
  const moved: Array<{ eventResourceId: string; resourceId: string; start: Date; end: Date }> = [];
  for (const item of input.resources) {
    await activeRow(tx, e.id, item.eventResourceId);
    const period = periodOf(item.start, item.end);
    await checkPlacement(tx, e, item.resourceId, period, now);
    const { unitIds } = await moveEventOccupancy(tx, { branchId: e.branch_id, resourceId: item.resourceId, eventResourceId: item.eventResourceId, period }, clock);
    await tx.query('UPDATE app.event_resources SET resource_id = $2, period = $3, unit_ids = $4 WHERE id = $1', [item.eventResourceId, item.resourceId, toPgRange(period), unitIds]);
    moved.push({ eventResourceId: item.eventResourceId, resourceId: item.resourceId, start: period.start, end: period.end });
  }
  await tx.query('UPDATE app.events SET planned_start = $2, planned_end = $3, row_version = row_version + 1 WHERE id = $1', [e.id, input.plannedStart, input.plannedEnd]);
  const row = (await getEventRow(tx, e.id))!;
  const previous = e.planned_start && e.planned_end ? { start: e.planned_start.toISOString(), end: e.planned_end.toISOString() } : null;
  const current = { start: input.plannedStart.toISOString(), end: input.plannedEnd.toISOString() };
  await writeAudit(tx, meta, { action: 'event.rescheduled', object: { type: 'event', id: e.id }, branchId: e.branch_id, before: previous, after: { ...current, resources: moved }, reason }, clock);
  if (previous) {
    await publish(tx as OutboxTx, {
      type: 'event.rescheduled',
      aggregateType: 'event',
      aggregateId: e.id,
      aggregateVersion: row.row_version,
      branchId: e.branch_id,
      occurredAt: now,
      payload: { eventId: e.id, branchId: e.branch_id, customerClientId: e.customer_client_id, previous, current },
    });
  }
  return toEventDto(row);
}

interface ResourceRow {
  id: string;
  event_id: string;
  resource_id: string;
  name: string;
  resource_type: string;
  period: string;
  unit_ids: string[];
  status: 'active' | 'released';
  release_reason: string | null;
  reserved_at: Date;
  event_status: string;
  request_hold_reminded_at: Date | null;
}

/** Ресурсы мероприятия для карточки; у комнаты под new_request – срок и отметка напоминания. */
export async function listEventResources(db: Db, eventId: string, now: Date): Promise<EventResourceDto[]> {
  const r = await db.query<ResourceRow>(
    `SELECT er.id, er.event_id, er.resource_id, r.name, r.resource_type, er.period::text, er.unit_ids, er.status, er.release_reason, er.reserved_at, er.request_hold_reminded_at, e.status AS event_status
       FROM app.event_resources er JOIN app.resources r ON r.id = er.resource_id JOIN app.events e ON e.id = er.event_id
      WHERE er.event_id = $1 ORDER BY lower(er.period), er.id`,
    [eventId],
  );
  const s = await resolveSettings(db, ['event.request_hold_hours', 'event.request_hold_remind_hours'], { network: true }, now);
  return r.rows.map((x) => {
    const p = fromPgRange(x.period);
    const held = x.status === 'active' && x.event_status === 'new_request';
    return {
      id: x.id,
      eventId: x.event_id,
      resourceId: x.resource_id,
      resourceName: x.name,
      resourceType: x.resource_type,
      start: p.start.toISOString(),
      end: p.end.toISOString(),
      unitIds: x.unit_ids,
      status: x.status,
      releaseReason: x.release_reason,
      requestHold: held ? { expiresAt: new Date(x.reserved_at.getTime() + s['event.request_hold_hours'].value * 3_600_000).toISOString(), remind: x.request_hold_reminded_at !== null } : null,
    };
  });
}

/** Занятая комната для блокировок K19 (booking.affectedOnUnits): строка занятости → мероприятие. Неизвестный источник – как есть. */
export function registerEventSources(): void {
  registerEventSourceResolver({
    async eventIdsOf(tx, ids) {
      if (ids.length === 0) return [];
      const r = await tx.query<{ id: string; event_id: string }>('SELECT id, event_id FROM app.event_resources WHERE id = ANY($1::uuid[])', [ids]);
      const map = new Map(r.rows.map((x) => [x.id, x.event_id]));
      return [...new Set(ids.map((id) => map.get(id) ?? id))];
    },
  });
}

// ---- задача events:request-hold-expire (K20 §4): комната под необработанную заявку

const HOLD_META: AuditRequestMeta = { actor: { kind: 'system', process: 'events:request-hold-expire' }, source: 'system', requestId: 'events:request-hold-expire' };

/** Один проход: снять просроченные удержания (мероприятие остаётся new_request), отметить те, кому пора напомнить.
 *  Занятые другой командой мероприятия пропускаются (SKIP LOCKED) – снимет следующий проход; повторно снять нечего. */
export async function expireRequestHolds(pool: { connect(): Promise<pg.PoolClient> }, clock: Clock = systemClock, limit = 100): Promise<{ released: number; reminded: number }> {
  const now = clock.now();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const s = await resolveSettings(c, ['event.request_hold_hours', 'event.request_hold_remind_hours'], { network: true }, now);
    const hours = s['event.request_hold_hours'].value;
    const remind = s['event.request_hold_remind_hours'].value;
    const due = await c.query<{ id: string; event_id: string; branch_id: string }>(
      `SELECT er.id, er.event_id, e.branch_id FROM app.event_resources er JOIN app.events e ON e.id = er.event_id
        WHERE er.status = 'active' AND e.status = 'new_request' AND er.reserved_at + make_interval(hours => $2) <= $1
        ORDER BY er.reserved_at, er.id LIMIT $3 FOR UPDATE OF e SKIP LOCKED`,
      [now, hours, limit],
    );
    for (const row of due.rows) await releaseOne(c, { id: row.event_id, branch_id: row.branch_id }, row.id, 'request_hold_expired', now, HOLD_META, clock);
    const reminded = await c.query(
      `UPDATE app.event_resources er SET request_hold_reminded_at = $1 FROM app.events e
        WHERE e.id = er.event_id AND er.status = 'active' AND e.status = 'new_request' AND er.request_hold_reminded_at IS NULL
          AND er.reserved_at + make_interval(hours => $2) - make_interval(hours => $3) <= $1`,
      [now, hours, remind],
    );
    await c.query('COMMIT');
    return { released: due.rows.length, reminded: reminded.rowCount ?? 0 };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Фоновая задача процесса worker: раз в intervalMs (5 минут). */
export function startRequestHoldExpiry(opts: { pool: { connect(): Promise<pg.PoolClient> }; clock?: Clock; intervalMs?: number; onError?: (err: unknown) => void }): { stop(): void } {
  const timer = setInterval(() => {
    expireRequestHolds(opts.pool, opts.clock).catch((err: unknown) => (opts.onError ?? ((e) => console.error('events:request-hold-expire', e)))(err));
  }, opts.intervalMs ?? 5 * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
