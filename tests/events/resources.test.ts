// S3-52: ресурсы и платный праздник на настоящей Postgres. TC-13: комната целиком 120 мин, ≤ 10 гостей, формат; бронь VR-места
// на время праздника – SLOT_TAKEN; перенос на занятое – прежнее время цело (16 §9); удержание под new_request снимается один раз;
// 50 параллельных «праздник против брони VR» – ровно одна сторона; резолвер источника занятости.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { createStaffBooking } from '../../apps/api/src/modules/booking/change.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { eventOccupancy, previewBlock, registerEventSourceResolver } from '../../apps/api/src/modules/booking/providers.ts';
import { changeEventStatus, createEvent, type EventDto } from '../../apps/api/src/modules/events/events.ts';
import { expireRequestHolds, listEventResources, moveEvent, registerEventSources, releaseResource, reserveResource } from '../../apps/api/src/modules/events/resources.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

// 2026-11-16 – понедельник; Новосибирск UTC+7, график филиала 10:00–22:00 = 03:00–15:00 UTC
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
const ids: Record<string, string> = {};
const units: Record<string, string> = {};
const types: Record<string, string> = {};

const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => runOccupancyCommand(pool, fn);
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
const party = (over: Record<string, unknown> = {}) =>
  tx((c) => createEvent(c, owner, { typeId: types.birthday_party, branchId: ids.branch, customer: { name: 'Анна', phone: '+79131234567' }, ...over }, meta(), clock));
const reserve = (e: EventDto, start: string, end: string, resourceId = ids.whole!, at = clock) =>
  tx((c) => reserveResource(c, owner, e.id, { resourceId, start, end }, meta(), at));
const bookVr = (start: string, end: string, resourceId = ids.vr1!) =>
  tx((c) => createStaffBooking(c, { ctx: owner, branchId: ids.branch!, resourceId, start: new Date(start), end: new Date(end), client: { clientId: ids.client! } }, meta(), clock));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.branch = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.branch, s.id]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'vr_seat', 'VR', 15, 10000, '2026-01-01', 'active', $2)`, [ids.branch, s.id]);
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR-комната', true) RETURNING id`, [ids.branch])).id;
  for (const code of ['VR1', 'VR2', 'PS4']) units[code] = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [ids.branch, ids.room, code])).id;
  const resource = async (type: string, name: string, unitIds: string[]) => {
    const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [ids.branch, ids.room, type, name]);
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, unitIds]);
    return r.id as string;
  };
  ids.vr1 = await resource('vr_seat', 'VR-место 1', [units.VR1!]);
  ids.vr2 = await resource('vr_seat', 'VR-место 2', [units.VR2!]);
  ids.whole = await resource('room_whole', 'Комната', [units.VR1!, units.VR2!, units.PS4!]);
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type) VALUES ('+79131112233', 'Анна', 'active', 'system') RETURNING id`)).id;
  for (const t of (await db.client.query<{ id: string; code: string }>('SELECT id, code FROM app.event_types')).rows) types[t.code] = t.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S3-52: TC-13 правила праздника', () => {
  it('комната 14:00–16:00, 8 гостей: занята, VR-место продать нельзя; строки занятости – все три единицы', async () => {
    const e = await party({ participantsCount: 8, party: { format: 'h2', guests: 8 } });
    const { eventResourceId } = await reserve(e, '2026-11-16T07:00:00Z', '2026-11-16T09:00:00Z');
    const occ = await eventOccupancy(pool, eventResourceId);
    expect(occ.map((o) => o.unitId).sort()).toEqual([units.VR1, units.VR2, units.PS4].sort());
    expect(await codeOf(bookVr('2026-11-16T08:00:00Z', '2026-11-16T08:30:00Z'))).toBe('SLOT_TAKEN');
  });
  it('14:00–15:30 → PARTY_TOO_SHORT; два встык одним не считаются', async () => {
    const e = await party();
    expect(await codeOf(reserve(e, '2026-11-17T07:00:00Z', '2026-11-17T08:30:00Z'))).toBe('PARTY_TOO_SHORT');
    expect(await codeOf(reserve(e, '2026-11-17T07:00:00Z', '2026-11-17T08:00:00Z'))).toBe('PARTY_TOO_SHORT');
    expect(await codeOf(reserve(e, '2026-11-17T08:00:00Z', '2026-11-17T09:00:00Z'))).toBe('PARTY_TOO_SHORT');
  });
  it('ресурс «VR-место» → PARTY_RESOURCE_INVALID; обычное мероприятие занимает и VR-место', async () => {
    const e = await party();
    expect(await codeOf(reserve(e, '2026-11-17T07:00:00Z', '2026-11-17T09:00:00Z', ids.vr1))).toBe('PARTY_RESOURCE_INVALID');
    const other = await tx((c) => createEvent(c, owner, { typeId: types.group_visit, branchId: ids.branch, customer: { name: 'А', phone: '+79131234567' } }, meta(), clock));
    expect(await codeOf(reserve(other, '2026-11-17T04:00:00Z', '2026-11-17T04:30:00Z', ids.vr2))).toBe('ok');
  });
  it('гости: 11 при создании → PARTY_GUESTS_LIMIT; настройка снижена – отказ на занятии', async () => {
    expect(await codeOf(party({ party: { format: 'h2', guests: 11 } }))).toBe('PARTY_GUESTS_LIMIT');
    const e = await party({ party: { format: 'h2', guests: 9 } });
    const c = await one(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('event.party.max_guests', 'network', '8'::jsonb, '2026-11-01', $1) RETURNING id`, [owner.actor.staffId]);
    expect(await codeOf(reserve(e, '2026-11-18T07:00:00Z', '2026-11-18T09:00:00Z'))).toBe('PARTY_GUESTS_LIMIT');
    await db.client.query('DELETE FROM app.settings_values WHERE id = $1', [c.id]);
  });
  it('формат: h2 – ровно 120; h3plus – от 180; весь день – от открытия до закрытия', async () => {
    const h2 = await party({ party: { format: 'h2', guests: 5 } });
    expect(await codeOf(reserve(h2, '2026-11-19T07:00:00Z', '2026-11-19T10:00:00Z'))).toBe('PARTY_FORMAT_MISMATCH');
    const h3 = await party({ party: { format: 'h3plus', guests: 5 } });
    expect(await codeOf(reserve(h3, '2026-11-19T07:00:00Z', '2026-11-19T09:00:00Z'))).toBe('PARTY_FORMAT_MISMATCH');
    expect(await codeOf(reserve(h3, '2026-11-19T07:00:00Z', '2026-11-19T10:00:00Z'))).toBe('ok');
    const day = await party({ party: { format: 'full_day', guests: 5 } });
    expect(await codeOf(reserve(day, '2026-11-20T04:00:00Z', '2026-11-20T10:00:00Z'))).toBe('PARTY_FORMAT_MISMATCH');
    expect(await codeOf(reserve(day, '2026-11-20T03:00:00Z', '2026-11-20T15:00:00Z'))).toBe('ok');
  });
  it('вне графика – OUTSIDE_SCHEDULE; заблокированные единицы – RESOURCE_BLOCKED; цены из тарифа нет', async () => {
    const e = await party();
    expect(await codeOf(reserve(e, '2026-11-21T00:00:00Z', '2026-11-21T02:00:00Z'))).toBe('OUTSIDE_SCHEDULE');
    const reason = await one(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`);
    const block = await one(
      `INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, created_by) VALUES ($1, 'unit', ARRAY[$2]::uuid[], '["2026-11-21 05:00:00+00","2026-11-21 06:00:00+00")', $3, $4) RETURNING id`,
      [ids.branch, units.PS4, reason.id, owner.actor.staffId],
    );
    await db.client.query(`INSERT INTO app.resource_block_units (block_id, unit_id, period) VALUES ($1, $2, '["2026-11-21 05:00:00+00","2026-11-21 06:00:00+00")')`, [block.id, units.PS4]);
    expect(await codeOf(reserve(e, '2026-11-21T05:00:00Z', '2026-11-21T07:00:00Z'))).toBe('RESOURCE_BLOCKED');
    expect((await db.client.query('SELECT count(*)::int n FROM app.event_lines WHERE event_id = $1', [e.id])).rows[0].n).toBe(0);
  });
  it('в конечном статусе – EVENT_CLOSED; отмена освобождает строки своей занятости', async () => {
    const e = await party({ party: { format: 'h2', guests: 3 } });
    const { eventResourceId } = await reserve(e, '2026-11-22T07:00:00Z', '2026-11-22T09:00:00Z');
    const cur = await one('SELECT row_version FROM app.events WHERE id = $1', [e.id]);
    const r = await tx((c) => changeEventStatus(c, owner, e.id, { rowVersion: cur.row_version, to: 'cancelled', reason: 'передумали' }, meta(), clock));
    expect(r.event.status).toBe('cancelled');
    expect(await eventOccupancy(pool, eventResourceId)).toEqual([]);
    expect(await codeOf(bookVr('2026-11-22T08:00:00Z', '2026-11-22T08:30:00Z'))).toBe('ok');
    expect(await codeOf(reserve(e, '2026-11-22T10:00:00Z', '2026-11-22T12:00:00Z'))).toBe('EVENT_CLOSED');
  });
});

describe('S3-52: снятие и перенос', () => {
  it('снятие с причиной гасит только свою строку', async () => {
    const e = await party();
    const a = await reserve(e, '2026-11-23T04:00:00Z', '2026-11-23T06:00:00Z');
    const b = await reserve(e, '2026-11-23T08:00:00Z', '2026-11-23T10:00:00Z');
    expect(await codeOf(tx((c) => releaseResource(c, owner, e.id, { eventResourceId: a.eventResourceId }, meta(), clock)))).toBe('COMMENT_REQUIRED');
    await tx((c) => releaseResource(c, owner, e.id, { eventResourceId: a.eventResourceId, reason: 'не нужно' }, meta(), clock));
    expect(await eventOccupancy(pool, a.eventResourceId)).toEqual([]);
    expect(await eventOccupancy(pool, b.eventResourceId)).toHaveLength(3);
    const list = await listEventResources(pool, e.id, clock.now());
    expect(list.find((x) => x.id === a.eventResourceId)).toMatchObject({ status: 'released', releaseReason: 'не нужно', requestHold: null });
  });
  it('перенос на занятое время – SLOT_TAKEN, прежнее время цело; на свободное – занято новое, событие event.rescheduled', async () => {
    const e = await party({ party: { format: 'h2', guests: 4 } });
    const { eventResourceId } = await reserve(e, '2026-11-24T04:00:00Z', '2026-11-24T06:00:00Z');
    await bookVr('2026-11-24T09:00:00Z', '2026-11-24T09:30:00Z');
    const v = (await one('SELECT row_version FROM app.events WHERE id = $1', [e.id])).row_version;
    const move = (start: string, end: string, rowVersion = v) => tx((c) => moveEvent(c, owner, e.id, { rowVersion, plannedStart: start, plannedEnd: end, reason: 'попросили', resources: [{ eventResourceId, resourceId: ids.whole, start, end }] }, meta(), clock));
    expect(await codeOf(move('2026-11-24T08:00:00Z', '2026-11-24T10:00:00Z'))).toBe('SLOT_TAKEN');
    const old = await eventOccupancy(pool, eventResourceId);
    expect(old).toHaveLength(3);
    expect(old[0]!.start.toISOString()).toBe('2026-11-24T04:00:00.000Z');
    const row = await one('SELECT lower(period) AS s FROM app.event_resources WHERE id = $1', [eventResourceId]);
    expect(row.s.toISOString()).toBe('2026-11-24T04:00:00.000Z');
    const m = await move('2026-11-24T11:00:00Z', '2026-11-24T13:00:00Z');
    expect(m.plannedStart).toBe('2026-11-24T11:00:00.000Z');
    expect((await eventOccupancy(pool, eventResourceId))[0]!.start.toISOString()).toBe('2026-11-24T11:00:00.000Z');
    const ev = await one(`SELECT payload FROM app.outbox_events WHERE event_type = 'event.rescheduled' AND aggregate_id = $1`, [e.id]);
    expect(ev.payload.previous.start).toBe('2026-11-24T04:00:00.000Z');
    const a = await one(`SELECT reason FROM journal.audit_events WHERE action = 'event.rescheduled' AND object_id = $1`, [e.id]);
    expect(a.reason).toBe('попросили');
    expect(await codeOf(move('2026-11-24T07:00:00Z', '2026-11-24T09:00:00Z'))).toBe('VERSION_CONFLICT');
    // перенос короче минимума – правила праздника на новом интервале
    expect(await codeOf(move('2026-11-24T07:00:00Z', '2026-11-24T08:00:00Z', m.rowVersion))).toBe('PARTY_TOO_SHORT');
  });
});

describe('Ревизия: перенос не оставляет комнату на старом времени (K20 §4)', () => {
  const moveWith = (e: EventDto, rowVersion: number, plannedStart: string, plannedEnd: string, resources: Array<Record<string, unknown>>) =>
    tx((c) => moveEvent(c, owner, e.id, { rowVersion, plannedStart, plannedEnd, reason: 'перенос', resources }, meta(), clock));
  const state = async (e: EventDto, rowId: string) => ({
    planned: (await one('SELECT planned_start AS s FROM app.events WHERE id = $1', [e.id])).s.toISOString(),
    room: (await one('SELECT lower(period) AS s FROM app.event_resources WHERE id = $1', [rowId])).s.toISOString(),
    occupied: (await eventOccupancy(pool, rowId))[0]!.start.toISOString(),
    version: (await one('SELECT row_version FROM app.events WHERE id = $1', [e.id])).row_version,
  });
  const OLD = '2026-11-25T04:00:00.000Z';

  it('resources: [] при занятой комнате – 422 EVENT_MOVE_RESOURCES_INVALID, ни дата, ни комната не сдвинулись', async () => {
    const e = await party();
    const { eventResourceId } = await reserve(e, OLD, '2026-11-25T06:00:00.000Z');
    const before = await state(e, eventResourceId);
    let err: unknown;
    await moveWith(e, before.version, '2026-11-25T08:00:00Z', '2026-11-25T10:00:00Z', []).catch((x: unknown) => { err = x; });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('EVENT_MOVE_RESOURCES_INVALID');
    expect((err as AppError).httpStatus).toBe(422);
    expect((err as AppError).details).toMatchObject({ reason: 'missing', eventResourceIds: [eventResourceId] });
    expect(await state(e, eventResourceId)).toEqual(before);
  });
  it('неполный список – отказ и откат: первая строка тоже остаётся на старом времени', async () => {
    const e = await tx((c) => createEvent(c, owner, { typeId: types.group_visit, branchId: ids.branch, customer: { name: 'А', phone: '+79131234567' } }, meta(), clock));
    const a = await reserve(e, '2026-11-26T04:00:00.000Z', '2026-11-26T05:00:00.000Z', ids.vr1);
    const b = await reserve(e, '2026-11-26T04:00:00.000Z', '2026-11-26T05:00:00.000Z', ids.vr2);
    const before = await state(e, a.eventResourceId);
    const code = await codeOf(moveWith(e, before.version, '2026-11-26T08:00:00Z', '2026-11-26T09:00:00Z', [{ eventResourceId: a.eventResourceId, resourceId: ids.vr1, start: '2026-11-26T08:00:00Z', end: '2026-11-26T09:00:00Z' }]));
    expect(code).toBe('EVENT_MOVE_RESOURCES_INVALID');
    expect(await state(e, a.eventResourceId)).toEqual(before);
    expect((await state(e, b.eventResourceId)).room).toBe('2026-11-26T04:00:00.000Z');
  });
  it('одна строка дважды – отказ; период ресурса вне planned – отказ; внутри planned – проходит; без занятых ресурсов [] допустимо', async () => {
    const e = await party();
    const { eventResourceId } = await reserve(e, '2026-11-27T04:00:00.000Z', '2026-11-27T06:00:00.000Z');
    const v = (await state(e, eventResourceId)).version;
    const item = { eventResourceId, resourceId: ids.whole, start: '2026-11-27T08:00:00Z', end: '2026-11-27T10:00:00Z' };
    expect(await codeOf(moveWith(e, v, '2026-11-27T08:00:00Z', '2026-11-27T10:00:00Z', [item, item]))).toBe('EVENT_MOVE_RESOURCES_INVALID');
    expect(await codeOf(moveWith(e, v, '2026-11-27T08:00:00Z', '2026-11-27T09:30:00Z', [item]))).toBe('EVENT_MOVE_RESOURCES_INVALID');
    expect((await state(e, eventResourceId)).room).toBe('2026-11-27T04:00:00.000Z');
    expect((await moveWith(e, v, '2026-11-27T07:30:00Z', '2026-11-27T10:30:00Z', [item])).plannedStart).toBe('2026-11-27T07:30:00.000Z');
    const free = await party({ plannedStart: '2026-11-28T04:00:00.000Z', plannedEnd: '2026-11-28T06:00:00.000Z' });
    expect((await moveWith(free, free.rowVersion, '2026-11-28T08:00:00Z', '2026-11-28T10:00:00Z', [])).plannedStart).toBe('2026-11-28T08:00:00.000Z');
  });
});

describe('S3-52: удержание под new_request', () => {
  it('за 24 ч – отметка, по истечении 48 ч снято один раз с причиной, мероприятие осталось new_request', async () => {
    await db.client.query(`UPDATE app.events SET status = 'negotiation' WHERE status = 'new_request'`); // чужие удержания предыдущих проверок
    const e = await party();
    const { eventResourceId } = await reserve(e, '2026-12-01T07:00:00Z', '2026-12-01T09:00:00Z');
    expect((await listEventResources(pool, e.id, clock.now()))[0]!.requestHold).toEqual({ expiresAt: '2026-11-16T05:00:00.000Z', remind: false });
    expect(await expireRequestHolds(pool, fixedClock('2026-11-15T04:59:00Z'))).toEqual({ released: 0, reminded: 0 });
    expect(await expireRequestHolds(pool, fixedClock('2026-11-15T05:00:00Z'))).toEqual({ released: 0, reminded: 1 });
    expect(await expireRequestHolds(pool, fixedClock('2026-11-15T06:00:00Z'))).toEqual({ released: 0, reminded: 0 });
    expect((await listEventResources(pool, e.id, clock.now()))[0]!.requestHold!.remind).toBe(true);
    expect(await expireRequestHolds(pool, fixedClock('2026-11-16T05:00:00Z'))).toEqual({ released: 1, reminded: 0 });
    expect(await expireRequestHolds(pool, fixedClock('2026-11-16T05:01:00Z'))).toEqual({ released: 0, reminded: 0 });
    expect(await eventOccupancy(pool, eventResourceId)).toEqual([]);
    const row = await one(`SELECT er.release_reason, e.status FROM app.event_resources er JOIN app.events e ON e.id = er.event_id WHERE er.id = $1`, [eventResourceId]);
    expect(row).toEqual({ release_reason: 'request_hold_expired', status: 'new_request' });
    const log = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'event.resource_released' AND object_id = $1`, [e.id]);
    expect(log.rowCount).toBe(1);
  });
  it('мероприятие вышло из new_request – комната не снимается', async () => {
    const e = await party();
    const { eventResourceId } = await reserve(e, '2026-12-02T07:00:00Z', '2026-12-02T09:00:00Z');
    const v = (await one('SELECT row_version FROM app.events WHERE id = $1', [e.id])).row_version;
    await tx((c) => changeEventStatus(c, owner, e.id, { rowVersion: v, to: 'negotiation' }, meta(), clock));
    await expireRequestHolds(pool, fixedClock('2026-11-20T05:00:00Z'));
    expect(await eventOccupancy(pool, eventResourceId)).toHaveLength(3);
  });
});

describe('S3-52: занятость и блокировка', () => {
  it('registerEventSources: блокировка видит мероприятие, а не строку ресурса', async () => {
    const e = await party();
    await reserve(e, '2026-12-03T07:00:00Z', '2026-12-03T09:00:00Z');
    registerEventSources();
    try {
      const p = await previewBlock(pool, { branchId: ids.branch!, target: { type: 'unit', ids: [units.PS4!] }, period: interval(new Date('2026-12-03T06:00:00Z'), new Date('2026-12-03T10:00:00Z')) }, clock);
      expect(p.eventIds).toEqual([e.id]);
    } finally {
      registerEventSourceResolver({ eventIdsOf: async (_tx, srcIds) => srcIds });
    }
  });
  it('50 параллельных «праздник против брони VR-места» – ровно одна сторона', async () => {
    const e = await party();
    const start = '2026-11-25T07:00:00Z';
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0 ? codeOf(reserve(e, start, '2026-11-25T09:00:00Z')) : codeOf(bookVr('2026-11-25T07:30:00Z', '2026-11-25T08:00:00Z')),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    for (const r of results) expect(['ok', 'SLOT_TAKEN', 'SLOT_HELD', 'CLIENT_OVERLAP']).toContain(r);
    const ev = await db.client.query(`SELECT count(*)::int n FROM app.event_resources WHERE event_id = $1 AND status = 'active'`, [e.id]);
    const bk = await db.client.query(`SELECT count(*)::int n FROM app.bookings WHERE resource_id = $1 AND status = 'confirmed' AND period && '["2026-11-25 07:00:00+00","2026-11-25 09:00:00+00")'`, [ids.vr1]);
    expect(ev.rows[0].n + bk.rows[0].n).toBe(1);
  });
});
