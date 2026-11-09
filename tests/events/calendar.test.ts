// K11 №2 + K20: мероприятия календаря филиала одним запросом (/branches/:id/calendar-events). Пересечение интервалов:
// мероприятие, начатое до периода, попадает; отменённое и снятая строка ресурса – нет; дорожки по составу (место VR ↔
// комната целиком); зона как у календаря – чужой филиал 404; период ≤ 7 дней.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-календаря-мероприятий-1';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let typeId = '';

type Who = 'owner' | 'admin' | 'stranger';
function req(who: Who, method: 'GET' | 'POST', url: string, payload?: object) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
async function staff(who: Who, role: string, branchId: string | null): Promise<void> {
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${who}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[who] = s.id;
  if (branchId) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s.id, branchId]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${who}@yu.test`, password: PASSWORD } });
  cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
}
async function newEvent(title: string): Promise<string> {
  const e = await req('owner', 'POST', '/events', { typeId, branchId: ids.b1, title, customer: { name: 'Анна Смирнова', phone: '+79131234567' } });
  expect(e.statusCode).toBe(201);
  return e.json().id;
}
async function eventWith(resourceId: string, start: string, end: string, title: string): Promise<string> {
  const id = await newEvent(title);
  const r = await req('owner', 'POST', `/events/${id}/resources`, { resourceId, start, end });
  expect([title, r.statusCode]).toEqual([title, 201]);
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('e'.repeat(40)), clock } });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
  }
  await staff('owner', 'owner', null);
  await staff('admin', 'admin', ids.b1!);
  await staff('stranger', 'director', ids.b2!);
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, ids.owner]);
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR-комната', true) RETURNING id`, [ids.b1])).id;
  ids.u1 = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, 'VR1', 'VR1') RETURNING id`, [ids.b1, ids.room])).id;
  ids.u2 = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, 'VR2', 'VR2') RETURNING id`, [ids.b1, ids.room])).id;
  const res = async (type: string, name: string, units: string[]) => {
    const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [ids.b1, ids.room, type, name]);
    for (const u of units) await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [r.id, u]);
    return r.id as string;
  };
  ids.vr1 = await res('vr_seat', 'VR-место 1', [ids.u1!]);
  ids.vr2 = await res('vr_seat', 'VR-место 2', [ids.u2!]);
  ids.whole = await res('room_whole', 'Комната', [ids.u1!, ids.u2!]);
  typeId = (await one(`SELECT id FROM app.event_types WHERE code = 'other'`)).id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('календарь мероприятий филиала', () => {
  it('одним запросом: начатое до периода попадает, отменённое – нет, дорожки по составу', async () => {
    // 20:00 18-го – 12:00 19-го по Новосибирску (выездное, вне графика – строка ресурса напрямую): началось до периода, идёт в нём
    const night = await newEvent('Ночь VR');
    await db.client.query(`INSERT INTO app.event_resources (id, event_id, branch_id, resource_id, period, unit_ids, reserved_at) VALUES ($1, $2, $3, $4, tstzrange('2026-11-18T13:00:00Z', '2026-11-19T05:00:00Z'), $5, now())`, [randomUUID(), night, ids.b1, ids.vr1, [ids.u1]]);
    const whole = await eventWith(ids.whole!, '2026-11-19T06:00:00Z', '2026-11-19T07:00:00Z', 'Комната целиком');
    const cancelled = await eventWith(ids.vr2!, '2026-11-19T08:00:00Z', '2026-11-19T09:00:00Z', 'Отменят');
    const c = await req('owner', 'POST', `/events/${cancelled}/status`, { rowVersion: 2, to: 'cancelled', reason: 'клиент передумал' });
    expect(c.statusCode).toBe(200);
    const r = await req('admin', 'GET', `/branches/${ids.b1}/calendar-events?from=2026-11-19&to=2026-11-19`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ branchId: ids.b1, from: '2026-11-19', to: '2026-11-19' });
    const byId = new Map(body.items.map((x: { id: string }) => [x.id, x]));
    expect(byId.has(cancelled)).toBe(false);
    expect(byId.get(night)).toMatchObject({ title: 'Ночь VR', status: 'new_request', start: '2026-11-18T13:00:00.000Z', end: '2026-11-19T05:00:00.000Z' });
    // место VR 1 занимает и свою дорожку, и комнату целиком (общая единица)
    expect([...(byId.get(night) as { resourceIds: string[] }).resourceIds].sort()).toEqual([ids.vr1, ids.whole].sort());
    expect([...(byId.get(whole) as { resourceIds: string[] }).resourceIds].sort()).toEqual([ids.vr1, ids.vr2, ids.whole].sort());
    // фильтр дорожек, период целиком до мероприятий – пусто
    const only = (await req('admin', 'GET', `/branches/${ids.b1}/calendar-events?from=2026-11-19&to=2026-11-19&resourceIds=${ids.vr2}`)).json();
    expect(only.items.map((x: { id: string; resourceIds: string[] }) => [x.id, x.resourceIds])).toEqual([[whole, [ids.vr2]]]);
    expect((await req('admin', 'GET', `/branches/${ids.b1}/calendar-events?from=2026-11-17&to=2026-11-17`)).json().items).toEqual([]);
  });
  it('зона и период как у календаря: чужой филиал – 404, > 7 дней – 422, без входа – 401', async () => {
    expect((await req('stranger', 'GET', `/branches/${ids.b1}/calendar-events?from=2026-11-19&to=2026-11-19`)).statusCode).toBe(404);
    expect((await req('admin', 'GET', `/branches/${randomUUID()}/calendar-events?from=2026-11-19&to=2026-11-19`)).statusCode).toBe(404);
    const long = await req('admin', 'GET', `/branches/${ids.b1}/calendar-events?from=2026-11-15&to=2026-11-22`);
    expect([long.statusCode, long.json().error.code]).toEqual([422, 'RANGE_TOO_LONG']);
    expect((await req('admin', 'GET', `/branches/${ids.b1}/calendar-events?from=2026-11-19&to=2026-11-18`)).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${BASE}/branches/${ids.b1}/calendar-events?from=2026-11-19&to=2026-11-19` })).statusCode).toBe(401);
  });
});
