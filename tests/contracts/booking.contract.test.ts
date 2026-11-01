// S1-08: контракт-тест публичного API записи (K5 §Контракт-тест) на живом сервере (buildServer + app.inject,
// настоящая Postgres). Каждый маршрут BOOKING_ROUTES × успех – ответ проходит Zod-схему packages/contracts (тот же
// файл импортирует сайт); коды ошибок K5 – сценариями, тело ошибки – по схеме ErrorBody; повтор Idempotency-Key –
// тот же ответ и Idempotent-Replay; чужое удержание и чужая бронь – 404 с телом как у несуществующих; в ответах
// нет телефонов и имён других клиентов; openapi/booking.json совпадает с генерацией.
// Не вызываются сценарием: TARIFF_AMBIGUOUS (защита за ограничением базы tariffs_same_priority_overlap – см.
// tests/pricing), INTERNAL и SERVICE_UNAVAILABLE (сбой инфраструктуры).
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, clientTokenHash, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { BOOKING_ROUTES, ErrorBody, bookingOpenApi } from '../../packages/contracts/src/booking.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const PEPPER = 'c'.repeat(40);
const BASE = '/api/public/v1';
let t = new Date('2026-11-14T05:00:00Z').getTime(); // 12:00 Новосибирска
const clock: Clock = { now: () => new Date(t) };
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const seen = new Set<string>(); // id маршрутов с проверенным успехом
const codes = new Set<string>(); // вызванные коды ошибок
const bodies: string[] = []; // все ответы – для проверки «нет чужих ПДн»

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function resource(branchId: string, roomId: string | null, type: string, name: string, opts: { selfBookable?: boolean; units?: string[] } = {}): Promise<{ id: string; unit: string }> {
  const unit = opts.units?.[0] ?? (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [branchId, roomId, name])).id;
  const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name, self_bookable) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [branchId, roomId, type, name, opts.selfBookable ?? true]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, opts.units ?? [unit]]);
  return { id: r.id, unit };
}
async function branch(code: string, cityId: string, status = 'active'): Promise<string> {
  const closed = status === 'temporarily_closed';
  const id = (
    await one(
      `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status, temp_closed_from, temp_close_reason)
       VALUES ($1, $2, $2, $2, 'Красный, 1', 'Asia/Novosibirsk', $3, $4, $5) RETURNING id`,
      [cityId, code, status, closed ? '2026-11-01T00:00:00Z' : null, closed ? 'ремонт' : null],
    )
  ).id;
  await db.client.query(
    `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
    [id, SYS],
  );
  for (const type of ['pc', 'vr_seat']) {
    await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, 30, 20000, '2026-01-01', 'active', $3)`, [id, type, SYS]);
  }
  return id;
}
async function client(phone: string, firstName: string, status = 'active'): Promise<{ id: string; cookie: string }> {
  const c = await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, $2, $3, 'system', now()) RETURNING id`, [phone, firstName, status]);
  const token = randomBytes(24).toString('base64url');
  await db.client.query(`INSERT INTO app.client_sessions (client_id, token_hash, expires_at) VALUES ($1, $2, '2027-01-01')`, [c.id, clientTokenHash(PEPPER, token)]);
  return { id: c.id, cookie: `yu_client=${token}; yu_visitor=${randomUUID()}` };
}
const visitor = () => `yu_visitor=${randomUUID()}`;

interface Call {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  cookie?: string | null;
  body?: object;
  key?: string | null; // null – без заголовка
}
async function call(c: Call) {
  const headers: Record<string, string> = {};
  if (c.cookie) headers.cookie = c.cookie;
  if (c.method !== 'GET' && c.key !== null) headers['idempotency-key'] = c.key ?? randomUUID();
  const r = await app.inject({ method: c.method, url: `${BASE}${c.url}`, headers, ...(c.body ? { payload: c.body } : {}) });
  bodies.push(r.body);
  return r;
}
const routeOf = (id: string) => BOOKING_ROUTES.find((r) => r.id === id)!;
/** Успех маршрута: код из контракта и ответ по схеме. */
async function ok(id: string, c: Call) {
  const r = await call(c);
  const route = routeOf(id);
  expect(r.statusCode, `${id}: ${r.body}`).toBe(route.success.status);
  const parsed = (route.success.schema as z.ZodType).safeParse(r.json());
  expect(parsed.success, `${id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  seen.add(id);
  return r.json();
}
/** Ошибка: код, HTTP, тело по ErrorBody. */
async function fail(code: string, status: number, c: Call) {
  const r = await call(c);
  expect(ErrorBody.safeParse(r.json()).success, r.body).toBe(true);
  expect([r.statusCode, r.json().error.code], r.body).toEqual([status, code]);
  codes.add(code);
  return r.json();
}
const slot = (resourceId: string, start: string, minutes = 30) => ({ resourceId, start, end: new Date(Date.parse(start) + minutes * 60_000).toISOString() });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 10 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    network: { pool, clock },
    clients: { pool, auth: clientAuthConfig(PEPPER), sms: createDevSmsSender('dev', () => {}), clock },
  });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'Новосибирск', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = await branch('b1', city.id);
  ids.closed = await branch('closed', city.id, 'temporarily_closed');
  ids.b3 = await branch('b3', city.id);
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR-комната', true) RETURNING id`, [ids.b1])).id;
  ids.pc1 = (await resource(ids.b1, null, 'pc', 'ПК-1')).id;
  ids.pc2 = (await resource(ids.b1, null, 'pc', 'ПК-2')).id;
  const vr = await resource(ids.b1, ids.room, 'vr_seat', 'VR-место 1');
  ids.vr1 = vr.id;
  ids.vr1unit = vr.unit;
  ids.ps4 = (await resource(ids.b1, ids.room, 'composite', 'PS4', { selfBookable: false })).id;
  ids.ps5 = (await resource(ids.b1, null, 'ps_room', 'PS5')).id; // тарифа нет
  ids.closedPc = (await resource(ids.closed, null, 'pc', 'ПК-1')).id;
  ids.b3pc = (await resource(ids.b3, null, 'pc', 'ПК-1')).id;
  await db.client.query(
    `INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('booking.max_anonymous_holds_per_branch', 'branch', $1, '0', '2026-01-01', $2)`,
    [ids.b3, SYS],
  );
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('K5 №1–5: сеть и слоты', () => {
  it('города, филиалы, филиал, ресурсы, доступность – по схеме; ошибки NOT_FOUND и VALIDATION_FAILED', async () => {
    const cities = await ok('K5-1', { method: 'GET', url: '/cities' });
    expect(cities.items).toHaveLength(1);
    await ok('K5-2', { method: 'GET', url: '/branches?city=nsk' });
    await ok('K5-3', { method: 'GET', url: `/branches/${ids.b1}` });
    const res = await ok('K5-4', { method: 'GET', url: `/branches/${ids.b1}/resources` });
    expect(res.items.map((r: { name: string }) => r.name)).not.toContain('PS4'); // несамостоятельный не отдаётся
    await ok('K5-5', { method: 'GET', url: `/branches/${ids.b1}/availability?date=2026-11-15`, cookie: visitor() });
    await fail('NOT_FOUND', 404, { method: 'GET', url: `/branches/${randomUUID()}` });
    await fail('VALIDATION_FAILED', 400, { method: 'GET', url: `/branches/${ids.b1}/availability?date=15.11.2026` });
  });
});

describe('K5 №6–12: удержание и подтверждение', () => {
  it('полный путь посетитель → вход → подтверждение; повтор ключа – тот же 201 и Idempotent-Replay', async () => {
    const v = visitor();
    const h = await ok('K5-6', { method: 'POST', url: '/holds', cookie: v, body: { branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-15T07:00:00Z')] } });
    await ok('K5-7', { method: 'GET', url: `/holds/${h.id}`, cookie: v });
    const added = await ok('K5-8', { method: 'POST', url: `/holds/${h.id}/items`, cookie: v, body: slot(ids.pc2!, '2026-11-15T07:00:00Z') });
    const removed = await ok('K5-9', { method: 'DELETE', url: `/holds/${h.id}/items/${added.items.find((i: { resourceId: string }) => i.resourceId === ids.pc2).id}`, cookie: v });
    expect(removed.items).toHaveLength(1);
    const a = await client('+79130000101', 'Анна');
    ids.a = a.id;
    const cookieA = `yu_client=${a.cookie.split(';')[0]!.split('=')[1]}; ${v}`;
    await ok('K5-11', { method: 'POST', url: `/holds/${h.id}/attach`, cookie: cookieA });
    const key = randomUUID();
    const first = await call({ method: 'POST', url: `/holds/${h.id}/confirm`, cookie: cookieA, body: {}, key });
    const replay = await call({ method: 'POST', url: `/holds/${h.id}/confirm`, cookie: cookieA, body: {}, key });
    expect(first.statusCode).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    await ok('K5-12', { method: 'POST', url: `/holds/${h.id}/confirm`, cookie: cookieA, body: {} }); // повтор после перевода – прежний результат
    ids.bookingA = first.json().bookings[0].id;
    ids.cookieA = cookieA;
    await fail('IDEMPOTENCY_KEY_REUSED', 409, { method: 'POST', url: `/holds/${h.id}/confirm`, cookie: cookieA, body: { comment: 'другое тело' }, key });

    const v2 = visitor();
    const h2 = await ok('K5-6', { method: 'POST', url: '/holds', cookie: v2, body: { branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-16T07:00:00Z')] } });
    await ok('K5-10', { method: 'POST', url: `/holds/${h2.id}/release`, cookie: v2 });
  });

  it('коды ошибок удержания: каждая позиция называет себя в details.items', async () => {
    const v = visitor();
    const post = (body: object, cookie: string | null = v, key?: string | null) => ({ method: 'POST' as const, url: '/holds', cookie, body, ...(key === undefined ? {} : { key }) });
    await fail('VISITOR_REQUIRED', 400, post({ branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-17T07:00:00Z')] }, null));
    await fail('IDEMPOTENCY_KEY_REQUIRED', 400, post({ branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-17T07:00:00Z')] }, v, null));
    await fail('VALIDATION_FAILED', 400, post({ branchId: ids.b1, items: [] }));
    await fail('NOT_FOUND', 404, post({ branchId: randomUUID(), items: [slot(ids.pc1!, '2026-11-17T07:00:00Z')] }));
    await fail('BRANCH_NOT_ACTIVE', 409, post({ branchId: ids.closed, items: [slot(ids.closedPc!, '2026-11-17T07:00:00Z')] }));
    const window = await fail('OUTSIDE_BOOKING_WINDOW', 422, post({ branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-14T04:00:00Z')] }));
    expect(window.error.details.items[0]).toMatchObject({ index: 0, resourceId: ids.pc1, code: 'OUTSIDE_BOOKING_WINDOW' });
    await fail('OUTSIDE_SCHEDULE', 409, post({ branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-17T16:00:00Z')] }));
    await fail('INVALID_DURATION', 422, post({ branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-17T07:00:00Z', 20)] }));
    await fail('RESOURCE_UNAVAILABLE', 409, post({ branchId: ids.b1, items: [slot(ids.ps4!, '2026-11-17T07:00:00Z')] }));
    await fail('HOLD_LIMIT_REACHED', 422, post({ branchId: ids.b1, items: Array.from({ length: 11 }, (_, k) => slot(ids.pc1!, new Date(Date.parse('2026-11-18T04:00:00Z') + k * 30 * 60_000).toISOString())) }));
    await fail('RATE_LIMITED', 429, post({ branchId: ids.b3, items: [slot(ids.b3pc!, '2026-11-17T07:00:00Z')] }));
    await fail('SLOT_TAKEN', 409, post({ branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-15T07:00:00Z')] }));
    const held = await ok('K5-6', post({ branchId: ids.b1, items: [slot(ids.pc2!, '2026-11-17T08:00:00Z')] }));
    await fail('HOLD_ALREADY_ACTIVE', 409, post({ branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-17T09:00:00Z')] }));
    await fail('SLOT_HELD', 409, post({ branchId: ids.b1, items: [slot(ids.pc2!, '2026-11-17T08:00:00Z')] }, visitor()));
    // CLIENT_OVERLAP: у Анны бронь 15.11 07:00–07:30 – другой ресурс на то же время
    await fail('CLIENT_OVERLAP', 409, post({ branchId: ids.b1, items: [slot(ids.vr1!, '2026-11-15T07:00:00Z')] }, ids.cookieA));
    // RESOURCE_BLOCKED
    const reason = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`)).id;
    const block = await one(`INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, created_by) VALUES ($1, 'unit', $2, '[2026-11-19 00:00:00+00,2026-11-20 00:00:00+00)', $3, $4) RETURNING id`, [ids.b1, [ids.vr1unit], reason, SYS]);
    await db.client.query(`INSERT INTO app.resource_block_units (block_id, unit_id, period) VALUES ($1, $2, '[2026-11-19 00:00:00+00,2026-11-20 00:00:00+00)')`, [block.id, ids.vr1unit]);
    await fail('RESOURCE_BLOCKED', 409, post({ branchId: ids.b1, items: [slot(ids.vr1!, '2026-11-19T07:00:00Z')] }, visitor()));
    // HOLD_EXPIRED: через 16 минут удержание посетителя истекло
    t += 16 * 60_000;
    await fail('HOLD_EXPIRED', 410, { method: 'POST', url: `/holds/${held.id}/items`, cookie: v, body: slot(ids.pc2!, '2026-11-17T09:00:00Z') });
  });

  it('подтверждение: AUTH_REQUIRED, NOT_FOUND чужого, TARIFF_NOT_CONFIGURED, CLIENT_RESTRICTED, COMPOSITE_CHANGED', async () => {
    const b = await client('+79130000102', 'Борис');
    const h = await ok('K5-6', { method: 'POST', url: '/holds', cookie: b.cookie, body: { branchId: ids.b1, items: [slot(ids.ps5!, '2026-11-20T07:00:00Z')] } });
    await fail('AUTH_REQUIRED', 401, { method: 'POST', url: `/holds/${h.id}/confirm`, cookie: visitor(), body: {} });
    const missing = await fail('NOT_FOUND', 404, { method: 'POST', url: `/holds/${randomUUID()}/confirm`, cookie: ids.cookieA, body: {} });
    const foreign = await fail('NOT_FOUND', 404, { method: 'POST', url: `/holds/${h.id}/confirm`, cookie: ids.cookieA, body: {} });
    expect({ ...foreign.error, requestId: '' }).toEqual({ ...missing.error, requestId: '' });
    const foreignGet = await call({ method: 'GET', url: `/holds/${h.id}`, cookie: visitor() });
    expect(foreignGet.statusCode).toBe(404);
    await fail('TARIFF_NOT_CONFIGURED', 422, { method: 'POST', url: `/holds/${h.id}/confirm`, cookie: b.cookie, body: {} });
    await call({ method: 'POST', url: `/holds/${h.id}/release`, cookie: b.cookie });

    const r = await client('+79130000103', 'Роман', 'restricted');
    const rh = await ok('K5-6', { method: 'POST', url: '/holds', cookie: r.cookie, body: { branchId: ids.b1, items: [slot(ids.pc1!, '2026-11-20T08:00:00Z')] } });
    await fail('CLIENT_RESTRICTED', 403, { method: 'POST', url: `/holds/${rh.id}/confirm`, cookie: r.cookie, body: {} });

    const k = await client('+79130000104', 'Кира');
    const kh = await ok('K5-6', { method: 'POST', url: '/holds', cookie: k.cookie, body: { branchId: ids.b1, items: [slot(ids.vr1!, '2026-11-21T07:00:00Z')] } });
    const other = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, 'VR1b', 'VR1b') RETURNING id`, [ids.b1, ids.room])).id;
    await db.client.query(`UPDATE app.resource_units SET valid_to = '2026-11-21T00:00:00Z' WHERE resource_id = $1 AND valid_to IS NULL`, [ids.vr1]);
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-11-21T00:00:00Z')`, [ids.vr1, other]);
    await fail('COMPOSITE_CHANGED', 409, { method: 'POST', url: `/holds/${kh.id}/confirm`, cookie: k.cookie, body: {} });
  });
});

describe('K5 №13 и K9: отмена клиентом, мои записи, мои посещения', () => {
  it('мои записи по вкладкам и посещения – по схеме, только свои; отмена – BookingDto; чужая – 404; повтор – BOOKING_NOT_CANCELLABLE', async () => {
    const up = await ok('K9-bookings', { method: 'GET', url: '/me/bookings?tab=upcoming', cookie: ids.cookieA });
    expect(up.items.map((b: { id: string }) => b.id)).toEqual([ids.bookingA]);
    expect(up.items[0]).toMatchObject({ cityName: 'Новосибирск', roomName: null, visit: null, canCancel: true });
    await fail('AUTH_REQUIRED', 401, { method: 'GET', url: '/me/bookings', cookie: visitor() });
    await fail('VALIDATION_FAILED', 400, { method: 'GET', url: '/me/bookings?tab=all', cookie: ids.cookieA });
    await fail('VALIDATION_FAILED', 400, { method: 'GET', url: '/me/bookings?cursor=мусор', cookie: ids.cookieA });

    const z = await client('+79130000105', 'Зоя');
    const missing = await fail('NOT_FOUND', 404, { method: 'POST', url: `/bookings/${randomUUID()}/cancel`, cookie: z.cookie, body: {} });
    const foreign = await fail('NOT_FOUND', 404, { method: 'POST', url: `/bookings/${ids.bookingA}/cancel`, cookie: z.cookie, body: {} });
    expect({ ...foreign.error, requestId: '' }).toEqual({ ...missing.error, requestId: '' });
    await fail('AUTH_REQUIRED', 401, { method: 'POST', url: `/bookings/${ids.bookingA}/cancel`, cookie: visitor(), body: {} });
    expect((await call({ method: 'GET', url: '/me/bookings?tab=upcoming', cookie: z.cookie })).json().items).toEqual([]);

    const cancelled = await ok('K5-13', { method: 'POST', url: `/bookings/${ids.bookingA}/cancel`, cookie: ids.cookieA, body: { reason: 'Планы' } });
    expect(cancelled).toMatchObject({ status: 'cancelled_by_client', canCancel: false });
    await fail('BOOKING_NOT_CANCELLABLE', 409, { method: 'POST', url: `/bookings/${ids.bookingA}/cancel`, cookie: ids.cookieA, body: {} });
    const tab = await ok('K9-bookings', { method: 'GET', url: '/me/bookings?tab=cancelled', cookie: ids.cookieA });
    expect(tab.items.map((b: { id: string }) => b.id)).toEqual([ids.bookingA]);
    expect(JSON.stringify(tab)).not.toContain('Планы'); // комментарий отмены – не в ЛК

    // посещение: бронь на сегодня, приход отмечен в CRM (здесь – строкой), в «моих посещениях» и в «прошлых»
    const vb = await call({ method: 'POST', url: '/holds', cookie: ids.cookieA, body: { branchId: ids.b1, items: [slot(ids.pc2!, '2026-11-14T06:00:00Z')] } });
    const conf = await call({ method: 'POST', url: `/holds/${vb.json().id}/confirm`, cookie: ids.cookieA, body: {} });
    const bid = conf.json().bookings[0].id;
    await db.client.query(`UPDATE app.bookings SET status = 'completed' WHERE id = $1`, [bid]);
    await db.client.query(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, completed_at, marked_by) VALUES ($1, $2, $3, '2026-11-14T06:01:00Z', '2026-11-14T06:30:00Z', $4)`, [bid, ids.b1, ids.a, SYS]);
    const visits = await ok('K9-visits', { method: 'GET', url: '/me/visits', cookie: ids.cookieA });
    expect(visits.items).toEqual([expect.objectContaining({ bookingId: bid, arrivedAt: '2026-11-14T06:01:00.000Z', status: 'visited' })]);
    t = Date.parse('2026-11-14T07:00:00Z');
    const past = await ok('K9-bookings', { method: 'GET', url: '/me/bookings?tab=past', cookie: ids.cookieA });
    expect(past.items[0]).toMatchObject({ id: bid, status: 'completed', visit: { arrivedAt: '2026-11-14T06:01:00.000Z' } });
    expect((await call({ method: 'GET', url: '/me/visits', cookie: z.cookie })).json().items).toEqual([]);
  });

  it('курсор: 25 будущих записей – две страницы по 20 и 5 без повторов', async () => {
    const p = await client('+79130000106', 'Пётр');
    for (let k = 0; k < 25; k++) {
      await db.client.query(
        `WITH b AS (INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type)
           VALUES (gen_random_uuid(), $1, $2, $3, tstzrange($4::timestamptz, $4::timestamptz + interval '30 min'), 20000, 'crm', 'staff') RETURNING id, period)
         INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
         SELECT id, 1, $3, period, 'Asia/Novosibirsk', ARRAY[gen_random_uuid()], '{"name":"ПК-1","roomName":null}', 20000, '{}', 'staff' FROM b`,
        [ids.b1, p.id, ids.pc1, new Date(Date.parse('2026-11-22T04:00:00Z') + k * 30 * 60_000)],
      );
    }
    const first = await ok('K9-bookings', { method: 'GET', url: '/me/bookings', cookie: p.cookie });
    const second = await ok('K9-bookings', { method: 'GET', url: `/me/bookings?cursor=${first.nextCursor}`, cookie: p.cookie });
    expect([first.items.length, second.items.length, second.nextCursor]).toEqual([20, 5, null]);
    const all = [...first.items, ...second.items].map((b: { start: string }) => b.start);
    expect(new Set(all).size).toBe(25);
    expect([...all].sort()).toEqual(all);
  });
});

describe('покрытие контракта', () => {
  it('у каждого маршрута проверен успех; вызваны все коды K5, кроме инфраструктурных', () => {
    expect(BOOKING_ROUTES.map((r) => r.id).filter((id) => !seen.has(id))).toEqual([]);
    const k5 = ['VALIDATION_FAILED', 'VISITOR_REQUIRED', 'IDEMPOTENCY_KEY_REQUIRED', 'AUTH_REQUIRED', 'NOT_FOUND', 'BRANCH_NOT_ACTIVE', 'OUTSIDE_BOOKING_WINDOW', 'OUTSIDE_SCHEDULE', 'INVALID_DURATION', 'RESOURCE_UNAVAILABLE', 'RESOURCE_BLOCKED', 'SLOT_TAKEN', 'SLOT_HELD', 'CLIENT_OVERLAP', 'CLIENT_RESTRICTED', 'COMPOSITE_CHANGED', 'HOLD_EXPIRED', 'HOLD_ALREADY_ACTIVE', 'HOLD_LIMIT_REACHED', 'TARIFF_NOT_CONFIGURED', 'BOOKING_NOT_CANCELLABLE', 'IDEMPOTENCY_KEY_REUSED', 'RATE_LIMITED'];
    expect(k5.filter((c) => !codes.has(c))).toEqual([]);
  });

  it('в ответах нет телефонов и имён клиентов (17 §7.2)', () => {
    const all = bodies.join('\n');
    for (const pd of ['+7913', '79130000', 'Анна', 'Борис', 'Роман', 'Кира', 'Зоя', 'Пётр']) expect(all).not.toContain(pd);
  });

  it('openapi/booking.json совпадает с генерацией и описывает каждый маршрут', async () => {
    const generated = bookingOpenApi();
    const file = JSON.parse(await readFile(new URL('../../packages/contracts/openapi/booking.json', import.meta.url), 'utf8'));
    expect(file).toEqual(generated);
    const paths = generated.paths as Record<string, Record<string, unknown>>;
    for (const r of BOOKING_ROUTES) expect(paths[r.path]?.[r.method], r.id).toBeDefined();
  });
});
