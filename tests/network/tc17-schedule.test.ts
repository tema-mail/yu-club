// Э5: TC-17 (tz/20 §10) целиком по HTTP на настоящей Postgres: новый график филиала (недельный и исключение «закрыто»)
// отражается на сайте (доступность K5), в CRM (график K11 №18 и календарь K11) и в серверной проверке брони
// (удержание с сайта, бронь и перенос из CRM). Существующая бронь при изменении графика не отменяется (01 §13).
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, clientTokenHash, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-графика-TC17-1';
const PEPPER = 'g'.repeat(40);
const CRM = '/api/crm/v1';
const LK = '/api/public/v1';
const SYS = '00000000-0000-0000-0000-000000000001';
const clock = fixedClock('2026-11-14T05:00:00Z'); // суббота, 12:00 Новосибирска
const MON = '2026-11-23'; // понедельник через 9 дней – в окне записи
const TUE = '2026-11-24';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};
let ownerCookie = '';
let clientCookie = '';

type Method = 'GET' | 'POST';
const crm = (method: Method, url: string, payload?: object) =>
  app.inject({ method, url: `${CRM}${url}`, headers: { cookie: ownerCookie, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) }, ...(payload ? { payload } : {}) });
const lk = (method: Method, url: string, payload?: object) =>
  app.inject({ method, url: `${LK}${url}`, headers: { cookie: clientCookie, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) }, ...(payload ? { payload } : {}) });
const ok = async (p: ReturnType<typeof crm>, code = 200) => {
  const r = await p;
  expect(r.statusCode, r.body).toBe(code);
  return r.json();
};
const errorOf = async (p: ReturnType<typeof crm>) => {
  const r = await p;
  return [r.statusCode, r.json().error?.code];
};
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
const at = (date: string, hhmmZ: string) => `${date}T${hhmmZ}:00Z`;

interface Av {
  dayState: string;
  openIntervals: Array<{ start: string; end: string }>;
  resources: Array<{ resourceId: string; slots: Array<{ start: string; state: string }> }>;
}
/** Доступность сайта глазами нового посетителя. */
async function availability(date: string): Promise<Av> {
  const r = await app.inject({ method: 'GET', url: `${LK}/branches/${ids.b1}/availability?date=${date}`, headers: { cookie: `yu_visitor=${randomUUID()}` } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Av;
}
const slotState = (av: Av, startIso: string) => av.resources.find((r) => r.resourceId === ids.pc1)!.slots.find((s) => s.start === new Date(startIso).toISOString())?.state;
const siteHold = (date: string, from: string, minutes: number) =>
  lk('POST', '/holds', { branchId: ids.b1, items: [{ resourceId: ids.pc1, start: at(date, from), end: new Date(Date.parse(at(date, from)) + minutes * 60_000).toISOString() }] });
const weekdayHours = async (weekday: number) =>
  ((await ok(crm('GET', `/branches/${ids.b1}/hours`))).items as Array<{ weekday: number; validFrom: string; open: string | null; close: string | null }>)
    .filter((x) => x.weekday === weekday)
    .map((x) => [x.validFrom, x.open, x.close]);
const crmOpen = async (date: string) => (await ok(crm('GET', `/branches/${ids.b1}/calendar?from=${date}&to=${date}`))).openIntervals;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock },
    clients: { pool, auth: clientAuthConfig(PEPPER), sms: createDevSmsSender('dev', () => {}), clock },
  });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'Красный, 1', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 15000, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc1 = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc1, u.id]);
  // Владелец – вход по паролю; клиент – сессия сайта
  await db.client.query(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', 'owner@yu.test', 'owner', $1)`, [await hashPassword(PASSWORD)]);
  const login = await app.inject({ method: 'POST', url: `${CRM}/auth/login`, payload: { email: 'owner@yu.test', password: PASSWORD } });
  expect(login.statusCode, login.body).toBe(200);
  ownerCookie = String(login.headers['set-cookie']).split(';')[0]!;
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000017', 'Анна', 'active', 'system', now()) RETURNING id`)).id;
  const token = randomBytes(24).toString('base64url');
  await db.client.query(`INSERT INTO app.client_sessions (client_id, token_hash, expires_at) VALUES ($1, $2, '2027-01-01')`, [ids.client, clientTokenHash(PEPPER, token)]);
  clientCookie = `yu_client=${token}`;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('TC-17 по HTTP: сайт, CRM и серверная проверка', () => {
  it('TC-17: новый недельный график и исключение «закрыто» отражаются на сайте (доступность), в CRM (график, календарь) и в серверной проверке брони (удержание, бронь, перенос); существующая бронь не отменяется', async () => {
    // до изменения: понедельник 10:00–22:00 везде; клиент записан на 20:00–21:00
    const before = await availability(MON);
    expect(before.dayState).toBe('open');
    expect(before.openIntervals).toEqual([{ start: at(MON, '03:00'), end: at(MON, '15:00') }].map((i) => ({ start: new Date(i.start).toISOString(), end: new Date(i.end).toISOString() })));
    expect(slotState(before, at(MON, '13:00'))).toBe('free');
    expect(await weekdayHours(1)).toEqual([['2026-01-01', '10:00', '22:00']]);
    expect(await crmOpen(MON)).toEqual([{ start: new Date(at(MON, '03:00')).toISOString(), end: new Date(at(MON, '15:00')).toISOString() }]);
    const h = await siteHold(MON, '13:00', 60);
    expect(h.statusCode, h.body).toBe(201);
    const booking = (await ok(lk('POST', `/holds/${h.json().id}/confirm`, {}), 201)).bookings[0];
    expect(booking.status).toBe('confirmed');

    // новый график с понедельника: 12:00–18:00; предпросмотр показывает затронутую бронь, применение её не отменяет
    const change = { validFrom: MON, days: [{ weekday: 1, open: '12:00', close: '18:00' }] };
    expect(await ok(crm('POST', `/branches/${ids.b1}/hours/preview`, change))).toEqual({ affectedBookingIds: [booking.id] });
    expect(await errorOf(crm('POST', `/branches/${ids.b1}/hours`, { ...change, confirmedAffected: [] }))).toEqual([409, 'AFFECTED_CHANGED']);
    expect(await ok(crm('POST', `/branches/${ids.b1}/hours`, { ...change, confirmedAffected: [booking.id] }))).toMatchObject({ kind: 'weekly', validFrom: MON, affectedBookingIds: [booking.id] });
    expect((await ok(crm('GET', `/bookings/${booking.id}`))).status).toBe('confirmed');

    // сайт: открытые интервалы и состояния слотов – по новому графику
    const after = await availability(MON);
    expect(after.dayState).toBe('open');
    expect(after.openIntervals).toEqual([{ start: new Date(at(MON, '05:00')).toISOString(), end: new Date(at(MON, '11:00')).toISOString() }]);
    // сетка сайта строится по открытым интервалам: слотов вне нового графика нет вовсе, внутри – свободно
    expect([slotState(after, at(MON, '03:00')), slotState(after, at(MON, '05:00')), slotState(after, at(MON, '13:00'))]).toEqual([undefined, 'free', undefined]);
    const starts = after.resources.find((r) => r.resourceId === ids.pc1)!.slots.map((s) => s.start);
    expect([starts[0], starts.at(-1)]).toEqual([new Date(at(MON, '05:00')).toISOString(), new Date(at(MON, '10:30')).toISOString()]);
    expect((await availability('2026-11-22')).openIntervals).toEqual([{ start: new Date(at('2026-11-22', '03:00')).toISOString(), end: new Date(at('2026-11-22', '15:00')).toISOString() }]); // воскресенье – прежние часы

    // CRM: график с датой начала и календарь дня
    expect(await weekdayHours(1)).toEqual([
      ['2026-01-01', '10:00', '22:00'],
      [MON, '12:00', '18:00'],
    ]);
    expect(await crmOpen(MON)).toEqual([{ start: new Date(at(MON, '05:00')).toISOString(), end: new Date(at(MON, '11:00')).toISOString() }]);
    const cal = await ok(crm('GET', `/branches/${ids.b1}/calendar?from=${MON}&to=${MON}`));
    expect(cal.items.map((i: { kind: string; id: string; booking?: { status: string } }) => [i.kind, i.id, i.booking?.status])).toEqual([['booking', booking.id, 'confirmed']]);

    // серверная проверка: сайт и CRM отказывают вне нового графика, внутри – проходят
    expect((await siteHold(MON, '13:00', 30)).json().error.code).toBe('OUTSIDE_SCHEDULE');
    expect((await siteHold(MON, '03:00', 30)).json().error.code).toBe('OUTSIDE_SCHEDULE');
    const inside = await siteHold(MON, '05:00', 30);
    expect(inside.statusCode, inside.body).toBe(201);
    await ok(lk('POST', `/holds/${inside.json().id}/release`, {}));
    expect(await errorOf(crm('POST', `/branches/${ids.b1}/bookings`, { resourceId: ids.pc1, start: at(MON, '12:00'), end: at(MON, '13:00'), client: { clientId: ids.client } }))).toEqual([409, 'OUTSIDE_SCHEDULE']);
    expect(await errorOf(crm('POST', `/bookings/${booking.id}/reschedule`, { rowVersion: 1, resourceId: ids.pc1, start: at(MON, '12:00'), end: at(MON, '13:00'), reason: 'график' }))).toEqual([409, 'OUTSIDE_SCHEDULE']);
    expect(await ok(crm('POST', `/bookings/${booking.id}/reschedule`, { rowVersion: 1, resourceId: ids.pc1, start: at(MON, '06:00'), end: at(MON, '07:00'), reason: 'новый график' }))).toMatchObject({ status: 'confirmed', start: new Date(at(MON, '06:00')).toISOString() });

    // исключение «закрыто» на вторник: сайт – день закрыт, CRM – интервалов нет, сервер – OUTSIDE_SCHEDULE
    const closed = { scope: { type: 'branch' }, date: TUE, exceptionKind: 'closed', reason: 'инвентаризация' };
    expect(await ok(crm('POST', `/branches/${ids.b1}/calendar-exceptions/preview`, closed))).toEqual({ affectedBookingIds: [] });
    await ok(crm('POST', `/branches/${ids.b1}/calendar-exceptions`, { ...closed, confirmedAffected: [] }), 201);
    const tue = await availability(TUE);
    expect([tue.dayState, tue.openIntervals, tue.resources.map((r) => r.slots.length)]).toEqual(['closed', [], [0]]);
    expect(await crmOpen(TUE)).toEqual([]);
    expect((await siteHold(TUE, '05:00', 30)).json().error.code).toBe('OUTSIDE_SCHEDULE');
    expect(await errorOf(crm('POST', `/branches/${ids.b1}/bookings`, { resourceId: ids.pc1, start: at(TUE, '05:00'), end: at(TUE, '06:00'), client: { clientId: ids.client } }))).toEqual([409, 'OUTSIDE_SCHEDULE']);
  });
});
