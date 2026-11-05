// S3-09: провайдеры booking для Э3 (K6 «Дополнения Э3», K19 §4, §8, K20 §4) на настоящей Postgres.
// previewBlock и createBlock на одних данных дают один список; мероприятие на блокируемых единицах – в eventIds, не в
// bookingIds; мероприятие на комнату против брони VR-места – SLOT_TAKEN от базы; releaseEvent гасит только строки своего
// event_resources; перенос на занятое время оставляет прежнее занятие целым.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { occupy, runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import {
  blockInfo,
  bookingRowsByIds,
  bookingsOnUnits,
  createBlockFor,
  eventOccupancy,
  liftBlockFor,
  moveEventOccupancy,
  occupyForEvent,
  previewBlock,
  registerEventSourceResolver,
  releaseEvent,
} from '../../apps/api/src/modules/booking/providers.ts';
import { expandToUnits } from '../../apps/api/src/modules/resources/index.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-провайдеров-проверка-1';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let owner: AccessContext;
let cookie = '';
const ids: Record<string, string> = {};
const units: Record<string, string> = {};

const at = (iso: string) => new Date(iso);
const slot = (iso: string, minutes: number) => interval(at(iso), new Date(at(iso).getTime() + minutes * 60_000));
const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });
function req(method: 'GET' | 'POST', url: string, payload?: object) {
  const headers: Record<string, string> = { cookie };
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
async function book(resourceId: string, iso: string, minutes: number): Promise<string> {
  const id = randomUUID();
  const u = await expandToUnits(pool, resourceId, at(iso));
  await runOccupancyCommand(pool, (c) => occupy(c, { branchId: ids.branch!, units: u, period: slot(iso, minutes), source: { type: 'booking', id, version: 1 }, clientId: null }));
  return id;
}
/** Мероприятие занимает ресурс: id строки event_resources (таблицу ведёт events, 0305) – здесь просто uuid. */
async function party(resourceId: string, iso: string, minutes: number): Promise<string> {
  const eventResourceId = randomUUID();
  await runOccupancyCommand(pool, (c) => occupyForEvent(c, { branchId: ids.branch!, resourceId, eventResourceId, period: slot(iso, minutes) }));
  return eventResourceId;
}
async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return runOccupancyCommand(pool, fn);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('e'.repeat(40)), clock } });
  const s = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'owner@yu.test', 'owner', $1) RETURNING id`,
    [await hashPassword(PASSWORD)],
  );
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: 'owner@yu.test', password: PASSWORD } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const c = await req('POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
  ids.branch = (await req('POST', '/branches', { cityId: c.json().id, slug: 'lenina', name: 'Ленина', address: 'адрес' })).json().id;
  ids.room = (await req('POST', `/branches/${ids.branch}/rooms`, { slug: 'vr', name: 'VR-комната', isPublished: true })).json().id;
  for (const code of ['VR1', 'VR2']) {
    const r = await req('POST', `/branches/${ids.branch}/resources`, { type: 'vr_seat', name: code, roomId: ids.room, unitCode: code });
    ids[code] = r.json().id;
    units[code] = r.json().unitIds[0];
  }
  units.PS4 = (await req('POST', `/branches/${ids.branch}/units`, { roomId: ids.room, code: 'PS4', name: 'PS4' })).json().id;
  ids.whole = (await req('POST', `/branches/${ids.branch}/resources`, { type: 'room_whole', name: 'Комната', roomId: ids.room, unitIds: [units.VR1, units.VR2, units.PS4] })).json().id;
  ids.pc = (await req('POST', `/branches/${ids.branch}/resources`, { type: 'pc', name: 'ПК-1' })).json().id;
  const reason = await db.client.query<{ id: string }>(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`);
  ids.repair = reason.rows[0]!.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('S3-09: блокировка и предпросмотр с мероприятиями', () => {
  it('previewBlock и createBlock на одних данных дают один список; праздник в комнате – в eventIds, не в bookingIds', async () => {
    const roomBooking = await book(ids.whole!, '2026-11-16T03:00:00Z', 60);
    const seatBooking = await book(ids.VR1!, '2026-11-16T05:00:00Z', 30);
    await book(ids.VR2!, '2026-11-16T05:00:00Z', 30); // VR2 блокировка VR1 не задевает
    const ev = await party(ids.whole!, '2026-11-16T07:00:00Z', 120);
    const input = { branchId: ids.branch!, target: { type: 'unit' as const, ids: [units.VR1!] }, period: slot('2026-11-16T02:00:00Z', 8 * 60) };
    const preview = await previewBlock(pool, input, clock);
    expect(preview.unitIds).toEqual([units.VR1]);
    expect(preview.bookingIds.sort()).toEqual([roomBooking, seatBooking].sort());
    expect(preview.eventIds).toEqual([ev]);
    expect(preview.bookingIds).not.toContain(ev);
    // предпросмотр ничего не пишет
    expect((await db.client.query(`SELECT count(*)::int AS n FROM app.resource_blocks`)).rows[0].n).toBe(0);
    const created = await inTx((c) => createBlockFor(c, owner, { ...input, reasonId: ids.repair! }, meta(), clock));
    expect(created.affectedBookingIds.sort()).toEqual(preview.bookingIds.sort());
    expect(created.affectedHoldIds).toEqual(preview.holdIds);
    expect(created.affectedEventIds).toEqual(preview.eventIds);
    // мероприятие не тронуто – его строки активны
    expect(await eventOccupancy(pool, ev)).toHaveLength(3);
    // новое мероприятие на заблокированную единицу – RESOURCE_BLOCKED
    expect(await codeOf(party(ids.whole!, '2026-11-16T04:00:00Z', 60))).toBe('RESOURCE_BLOCKED');
  });

  it('реестр мероприятий: id строки event_resources преобразуется в id мероприятия модулем events', async () => {
    const evRes = await party(ids.whole!, '2026-11-17T07:00:00Z', 120);
    const eventId = randomUUID();
    registerEventSourceResolver({ eventIdsOf: async (_tx, srcIds) => srcIds.map((s) => (s === evRes ? eventId : s)) });
    try {
      const p = await previewBlock(pool, { branchId: ids.branch!, target: { type: 'room', ids: [ids.room!] }, period: slot('2026-11-17T06:00:00Z', 240) }, clock);
      expect(p.eventIds).toEqual([eventId]);
    } finally {
      registerEventSourceResolver({ eventIdsOf: async (_tx, srcIds) => srcIds });
    }
  });
});

describe('S3-09: занятие мероприятием', () => {
  it('мероприятие на комнату против брони VR-места → SLOT_TAKEN (база), в обе стороны', async () => {
    await book(ids.VR1!, '2026-11-18T05:00:00Z', 30);
    expect(await codeOf(party(ids.whole!, '2026-11-18T04:00:00Z', 120))).toBe('SLOT_TAKEN');
    await party(ids.whole!, '2026-11-18T08:00:00Z', 120);
    expect(await codeOf(book(ids.VR2!, '2026-11-18T09:00:00Z', 30))).toBe('SLOT_TAKEN');
    expect(await codeOf(book(ids.pc!, '2026-11-18T09:00:00Z', 30))).toBe('ok'); // другая единица
    const busy = await db.client.query(
      `SELECT count(*)::int AS n FROM app.occupancy a JOIN app.occupancy b ON a.unit_id = b.unit_id AND a.id < b.id AND a.period && b.period WHERE a.active AND b.active`,
    );
    expect(busy.rows[0].n).toBe(0);
  });

  it('releaseEvent гасит только строки своего event_resources', async () => {
    const roomPart = await party(ids.whole!, '2026-11-19T04:00:00Z', 120);
    const pcPart = await party(ids.pc!, '2026-11-19T04:00:00Z', 120);
    const neighbour = await book(ids.VR1!, '2026-11-19T07:00:00Z', 30);
    await inTx((c) => releaseEvent(c, roomPart, 'released', clock));
    expect(await eventOccupancy(pool, roomPart)).toEqual([]);
    expect(await eventOccupancy(pool, pcPart)).toHaveLength(1);
    const n = await db.client.query(`SELECT count(*)::int AS n FROM app.occupancy WHERE active AND source_id = $1`, [neighbour]);
    expect(n.rows[0].n).toBe(1);
    const rel = await db.client.query(`SELECT DISTINCT release_reason FROM app.occupancy WHERE source_id = $1`, [roomPart]);
    expect(rel.rows).toEqual([{ release_reason: 'released' }]);
    // освобождённое время снова продаётся
    expect(await codeOf(book(ids.VR2!, '2026-11-19T04:30:00Z', 30))).toBe('ok');
  });

  it('перенос на занятое время – SLOT_TAKEN, прежнее время цело; на свободное – строки переезжают', async () => {
    const ev = await party(ids.whole!, '2026-11-20T04:00:00Z', 120);
    await book(ids.VR1!, '2026-11-20T09:00:00Z', 30);
    const before = await eventOccupancy(pool, ev);
    expect(before).toHaveLength(3);
    const moveTo = (iso: string) => inTx((c) => moveEventOccupancy(c, { branchId: ids.branch!, resourceId: ids.whole!, eventResourceId: ev, period: slot(iso, 120) }, clock));
    expect(await codeOf(moveTo('2026-11-20T08:00:00Z'))).toBe('SLOT_TAKEN');
    expect(await eventOccupancy(pool, ev)).toEqual(before);
    // в той же транзакции после отказа можно продолжать: точка сохранения откатила только перенос
    const moved = await inTx(async (c) => {
      const failed = await codeOf(moveEventOccupancy(c, { branchId: ids.branch!, resourceId: ids.whole!, eventResourceId: ev, period: slot('2026-11-20T08:00:00Z', 120) }, clock));
      const ok = await moveEventOccupancy(c, { branchId: ids.branch!, resourceId: ids.whole!, eventResourceId: ev, period: slot('2026-11-20T11:00:00Z', 120) }, clock);
      return { failed, ok };
    });
    expect(moved.failed).toBe('SLOT_TAKEN');
    expect(moved.ok.unitIds.sort()).toEqual([units.VR1, units.VR2, units.PS4].sort());
    const after = await eventOccupancy(pool, ev);
    expect(after).toHaveLength(3);
    expect(after.map((r) => [r.start.toISOString(), r.end.toISOString()])).toEqual(Array(3).fill(['2026-11-20T11:00:00.000Z', '2026-11-20T13:00:00.000Z']));
    // старое время свободно
    expect(await codeOf(book(ids.VR2!, '2026-11-20T04:30:00Z', 30))).toBe('ok');
  });

  it('bookingsOnUnits: будущие брони и мероприятия на единице с момента from; прошедшие – нет', async () => {
    const b = await book(ids.VR2!, '2026-11-21T05:00:00Z', 30);
    const ev = await party(ids.whole!, '2026-11-21T07:00:00Z', 120);
    const r = await bookingsOnUnits(pool, [units.VR2!], at('2026-11-21T00:00:00Z'));
    expect(r.bookingIds).toContain(b);
    expect(r.eventIds).toContain(ev);
    const later = await bookingsOnUnits(pool, [units.VR2!], at('2026-11-21T10:00:00Z'));
    expect(later.bookingIds).not.toContain(b);
    expect(later.eventIds).not.toContain(ev);
  });
});

describe('Э3: блокировка и строки броней для ремонта (K19 §7, §8)', () => {
  it('bookingRowsByIds: строки CRM по текущей версии, телефон маскирован; неизвестный id пропущен', async () => {
    const client = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000077', 'Анна', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
    const b = (
      await db.client.query<{ id: string }>(
        `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type)
         VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-11-25T05:00:00Z', '2026-11-25T06:00:00Z', '[)'), 100, 'crm', 'staff') RETURNING id`,
        [ids.branch, client, ids.pc],
      )
    ).rows[0]!.id;
    await db.client.query(
      `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
       VALUES ($1, 1, $2, tstzrange('2026-11-25T05:00:00Z', '2026-11-25T06:00:00Z', '[)'), 'Asia/Novosibirsk', ARRAY[gen_random_uuid()], '{"name":"ПК-1"}', 100, '{}', 'staff')`,
      [b, ids.pc],
    );
    const rows = await bookingRowsByIds(pool, [b, randomUUID()], clock.now());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: b, status: 'confirmed', resourceName: 'ПК-1', needsDecision: false, client: { id: client, name: 'Анна', isGuest: false } });
    expect(rows[0]!.client.phoneMasked).not.toContain('+79130000077');
    expect(await bookingRowsByIds(pool, [], clock.now())).toEqual([]);
  });

  it('liftBlockFor: снимает по текущей версии, блокировка остаётся в истории; повтор – без изменений', async () => {
    const meta = { actor: owner.actor, access: owner, source: 'crm' as const, requestId: randomUUID() };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { blockId } = await createBlockFor(c, owner, { branchId: ids.branch!, target: { type: 'unit', ids: [units.PS4!] }, period: interval(at('2026-12-01T05:00:00Z'), at('2026-12-01T06:00:00Z')), reasonId: ids.repair! }, meta, clock);
      const lifted = await liftBlockFor(c, owner, blockId, { comment: 'починили' }, meta, clock);
      expect(lifted.status).toBe('lifted');
      expect((await liftBlockFor(c, owner, blockId, {}, meta, clock)).status).toBe('lifted');
      expect((await blockInfo(c, blockId))?.status).toBe('lifted');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});
