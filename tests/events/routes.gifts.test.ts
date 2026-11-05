// S3-60: API подарка через живой сервер. Клиент видит только свои подарки, чужой – 404; слоты дня – только будни без праздников в
// пределах срока; подарок не появляется в /me/certificates; запись по цепочке ЛК (П2 → /holds/:id/confirm) с ценой 0; CRM №376–379,
// IDOR; праздничный календарь – только Владелец.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender, type DevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-подарка-проверка-1';
const CRM = '/api/crm/v1';
const LK = '/api/public/v1';
const clock = fixedClock('2026-06-01T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let sms: DevSmsSender;
const cookies: Record<string, string> = {};
const clients: Record<string, { id: string; cookie: string }> = {};
const ids: Record<string, string> = {};

type Who = 'owner' | 'director' | 'admin' | 'stranger';
const crm = (who: Who, method: 'GET' | 'POST', url: string, payload?: object, key: string = randomUUID()) =>
  app.inject({ method, url: `${CRM}${url}`, headers: { cookie: cookies[who]!, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
const lk = (who: string, method: 'GET' | 'POST', url: string, payload?: object, key: string = randomUUID()) =>
  app.inject({ method, url: `${LK}${url}`, headers: { cookie: clients[who]!.cookie, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];

async function staff(who: Who, role: string, branchId: string | null): Promise<void> {
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${who}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[who] = s.id;
  if (branchId) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s.id, branchId]);
  const res = await app.inject({ method: 'POST', url: `${CRM}/auth/login`, payload: { email: `${who}@yu.test`, password: PASSWORD } });
  cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
}
async function login(who: string, phone: string): Promise<void> {
  const r = await app.inject({ method: 'POST', url: `${LK}/auth/otp/request`, headers: { 'idempotency-key': randomUUID() }, payload: { phone, purpose: 'login' } });
  expect(r.statusCode).toBeLessThan(300);
  const v = await app.inject({ method: 'POST', url: `${LK}/auth/otp/verify`, payload: { challengeId: r.json().challengeId, code: /\d{6}/.exec(sms.sent.at(-1)!.text)![0], consents: { pdProcessing: true } } });
  expect(v.statusCode).toBe(200);
  clients[who] = { id: (await one('SELECT id FROM app.clients WHERE phone_e164 = $1', [phone])).id, cookie: String(v.headers['set-cookie']).split(';')[0]! };
}
const issue = async (who: string) => (await crm('owner', 'POST', '/gifts', { clientId: clients[who]!.id, branchId: ids.b1, reason: 'тест' })).json();

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  sms = createDevSmsSender('dev');
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    staff: { pool, auth: staffAuthConfig('e'.repeat(40)), clock },
    clients: { pool, auth: clientAuthConfig('c'.repeat(40)), sms, clock },
  });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
  await staff('owner', 'owner', null);
  await staff('director', 'director', ids.b1!);
  await staff('admin', 'admin', ids.b1!);
  await staff('stranger', 'director', ids.b2!);
  for (const b of ['b1', 'b2']) await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids[b], ids.owner]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'gift_vr', 'Подарок', 5, 0, '2026-01-01', 'active', $2)`, [ids.b1, ids.owner]);
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [ids.b1])).id;
  const unit = async (code: string) => (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [ids.b1, ids.room, code])).id as string;
  ids.u1 = await unit('VR1');
  ids.u2 = await unit('VR2');
  ids.gift = (await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name, self_bookable, step_minutes_override) VALUES ($1, $2, 'gift_vr', 'Подарок: 2 VR', false, 5) RETURNING id`, [ids.b1, ids.room])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [ids.gift, [ids.u1, ids.u2]]);
  await login('katya', '+79131110001');
  await login('olga', '+79131110002');
  await crm('owner', 'POST', '/holidays', { scope: 'network', date: '2026-06-12', name: 'День России' });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('S3-60: ЛК', () => {
  it('клиент видит только свои подарки; чужой – 404; без входа – 401; подарка нет в /me/certificates', async () => {
    const g = await issue('katya');
    expect(g.status).toBe('issued');
    const mine = (await lk('katya', 'GET', '/me/gifts')).json();
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ id: g.id, number: g.number, validUntil: '2026-07-31', status: 'issued' });
    expect(mine.items[0].terms.notIncluded).toEqual(['PS4', 'PS VR', 'food']);
    expect((await lk('olga', 'GET', '/me/gifts')).json().items).toEqual([]);
    expect((await lk('olga', 'GET', `/me/gifts/${g.id}/slots?branchId=${ids.b1}&date=2026-06-02`)).statusCode).toBe(404);
    expect((await lk('olga', 'POST', `/me/gifts/${g.id}/hold`, { branchId: ids.b1, start: '2026-06-02T05:00:00Z' })).statusCode).toBe(404);
    expect((await lk('katya', 'POST', `/me/gifts/${randomUUID()}/hold`, { branchId: ids.b1, start: '2026-06-02T05:00:00Z' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${LK}/me/gifts` })).statusCode).toBe(401);
    expect((await lk('katya', 'GET', '/me/certificates')).json().items).toEqual([]);
  });
  it('слоты дня: будни без праздников в пределах срока; окна 40 минут на сетке 15; занятое и прошлое не показываются', async () => {
    const { items } = (await lk('katya', 'GET', '/me/gifts')).json();
    const id = items[0].id;
    const day = async (date: string, branch = ids.b1) => (await lk('katya', 'GET', `/me/gifts/${id}/slots?branchId=${branch}&date=${date}`)).json();
    expect(await day('2026-06-06')).toMatchObject({ closedReason: 'GIFT_WEEKDAY_ONLY', slots: [] });
    expect(await day('2026-06-12')).toMatchObject({ closedReason: 'GIFT_HOLIDAY', slots: [] });
    expect(await day('2026-08-03')).toMatchObject({ closedReason: 'GIFT_EXPIRED', slots: [] });
    expect(await day('2026-06-02', ids.b2)).toMatchObject({ closedReason: 'RESOURCE_UNAVAILABLE', slots: [] });
    const open = await day('2026-06-02');
    expect(open.closedReason).toBeNull();
    // 10:00–22:00 по Новосибирску, 40 минут, каждые 15: последнее начало 21:15
    expect(open.slots[0]).toEqual({ start: '2026-06-02T03:00:00.000Z', end: '2026-06-02T03:40:00.000Z' });
    expect(open.slots.at(-1)).toEqual({ start: '2026-06-02T14:15:00.000Z', end: '2026-06-02T14:55:00.000Z' });
    expect(open.slots).toHaveLength(46);
    // сегодня (понедельник 01.06, сейчас 12:00) – только будущие окна
    const today = await day('2026-06-01');
    expect(today.slots[0].start > clock.now().toISOString()).toBe(true);
    // занятая единица закрывает окна, пересекающие её
    await db.client.query(
      `INSERT INTO app.occupancy (unit_id, branch_id, period, source_type, source_id, booking_version) VALUES ($1, $2, '["2026-06-03 05:00:00+00","2026-06-03 05:30:00+00")', 'booking', $3, 1)`,
      [ids.u2, ids.b1, randomUUID()],
    );
    const busy = await day('2026-06-03');
    expect(busy.slots.some((s: { start: string }) => s.start === '2026-06-03T05:00:00.000Z')).toBe(false);
    expect(busy.slots.some((s: { start: string }) => s.start === '2026-06-03T04:30:00.000Z')).toBe(false);
    expect(busy.slots.some((s: { start: string }) => s.start === '2026-06-03T05:30:00.000Z')).toBe(true);
  });
  it('запись: П2 → удержание с ценой 0 → обычное подтверждение → бронь 0 ₽; повтор с ключом – то же удержание', async () => {
    const { items } = (await lk('katya', 'GET', '/me/gifts')).json();
    const id = items[0].id;
    const key = randomUUID();
    const body = { branchId: ids.b1, start: '2026-06-04T05:00:00Z' };
    const h = await lk('katya', 'POST', `/me/gifts/${id}/hold`, body, key);
    expect(h.statusCode).toBe(201);
    expect(h.json().items[0].priceKop).toBe(0);
    expect(h.json().items[0].resourceId).toBe(ids.gift);
    const again = await lk('katya', 'POST', `/me/gifts/${id}/hold`, body, key);
    expect(again.json().id).toBe(h.json().id);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect((await lk('katya', 'POST', `/me/gifts/${id}/hold`, { branchId: ids.b1, start: '2026-06-04T07:00:00Z' })).json().error.code).toBe('GIFT_ALREADY_RESERVED');
    expect((await lk('katya', 'GET', '/me/gifts')).json().items[0].status).toBe('reserved');
    expect((await lk('katya', 'GET', `/me/gifts/${id}/slots?branchId=${ids.b1}&date=2026-06-05`)).json().closedReason).toBe('GIFT_NOT_ACTIVE');
    const done = await lk('katya', 'POST', `/holds/${h.json().id}/confirm`, {});
    expect(done.statusCode).toBe(201);
    expect(done.json().bookings[0].priceKop).toBe(0);
  });
  it('обычная запись на подарочный ресурс через сайт – RESOURCE_UNAVAILABLE; ресурс не в сетке сайта', async () => {
    const r = await lk('olga', 'POST', '/holds', { branchId: ids.b1, items: [{ resourceId: ids.gift, start: '2026-06-08T05:00:00Z', end: '2026-06-08T05:40:00Z' }] });
    expect(r.json().error.code).toBe('RESOURCE_UNAVAILABLE');
  });
  it('истёкший по сроку показывается «истёк» и без задачи истечения', async () => {
    await db.client.query(`UPDATE app.birthday_gifts SET issued_on = '2026-03-01', valid_until = '2026-05-30' WHERE client_id = $1`, [clients.katya!.id]);
    const state = (await lk('katya', 'GET', '/me/gifts')).json().items[0].status;
    expect(state).toBe('reserved'); // запись живая – не истекает
    await db.client.query(`UPDATE app.birthday_gifts SET status = 'issued' WHERE client_id = $1`, [clients.katya!.id]);
    expect((await lk('katya', 'GET', '/me/gifts')).json().items[0].status).toBe('expired');
  });
});

describe('S3-60: CRM №376–379', () => {
  it('№376: список по зоне, фильтр; выдача без права – 403 с отказом в аудите; чужой филиал не виден', async () => {
    await login('nina', '+79131110003');
    const g = await issue('nina');
    const seen = (await crm('director', 'GET', `/gifts?clientId=${clients.nina!.id}`)).json();
    expect(seen.items.map((x: { id: string }) => x.id)).toEqual([g.id]);
    expect((await crm('stranger', 'GET', `/gifts?clientId=${clients.nina!.id}`)).json().items).toEqual([]);
    expect((await crm('director', 'GET', '/gifts?status=wrong')).statusCode).toBe(400);
    const denied = await crm('director', 'POST', '/gifts', { clientId: clients.nina!.id, branchId: ids.b1, reason: 'акция' });
    expect(denied.statusCode).toBe(403);
    expect((await crm('director', 'POST', `/gifts/${g.id}/cancel`, { reason: 'x' })).statusCode).toBe(403);
    const log = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'gift.cancelled' AND result = 'denied' AND object_id = $1`, [g.id]);
    expect(log.rowCount).toBe(1);
  });
  it('№377–378: окна и запись из CRM; филиал вне зоны – 404; ответ – CrmBooking; подмена клиента – GIFT_CLIENT_MISMATCH', async () => {
    const gift = (await crm('owner', 'GET', `/gifts?clientId=${clients.nina!.id}`)).json().items[0];
    expect((await crm('stranger', 'GET', `/gifts/${gift.id}/slots?branchId=${ids.b1}&date=2026-06-09`)).statusCode).toBe(404);
    expect((await crm('stranger', 'POST', `/gifts/${gift.id}/book`, { branchId: ids.b1, start: '2026-06-09T05:00:00Z' })).statusCode).toBe(404);
    const slots = (await crm('admin', 'GET', `/gifts/${gift.id}/slots?branchId=${ids.b1}&date=2026-06-09`)).json();
    expect(slots.slots.length).toBeGreaterThan(0);
    const mismatch = await crm('admin', 'POST', `/gifts/${gift.id}/book`, { branchId: ids.b1, start: '2026-06-09T05:00:00Z', clientId: clients.olga!.id });
    expect(mismatch.json().error.code).toBe('GIFT_CLIENT_MISMATCH');
    const saturday = await crm('admin', 'POST', `/gifts/${gift.id}/book`, { branchId: ids.b1, start: '2026-06-13T05:00:00Z' });
    expect(saturday.json().error.code).toBe('GIFT_WEEKDAY_ONLY');
    const b = await crm('admin', 'POST', `/gifts/${gift.id}/book`, { branchId: ids.b1, start: '2026-06-09T05:00:00Z', comment: 'именинница' });
    expect(b.statusCode).toBe(201);
    expect(b.json()).toMatchObject({ status: 'confirmed', start: '2026-06-09T05:00:00.000Z', end: '2026-06-09T05:40:00.000Z' });
    expect((await crm('owner', 'GET', `/gifts?clientId=${clients.nina!.id}`)).json().items[0]).toMatchObject({ status: 'reserved', bookingId: b.json().id });
    expect((await crm('owner', 'POST', `/gifts/${gift.id}/cancel`, { reason: 'x' })).json().error.code).toBe('GIFT_NOT_ACTIVE');
  });
  it('№379: календарь читают все, ведёт Владелец', async () => {
    expect((await crm('admin', 'POST', '/holidays', { scope: 'network', date: '2026-11-04', name: 'Праздник' })).statusCode).toBe(403);
    const h = await crm('owner', 'POST', '/holidays', { scope: 'network', date: '2026-11-04', name: 'День единства' });
    expect(h.statusCode).toBe(201);
    expect((await crm('admin', 'GET', '/holidays?from=2026-11-01&to=2026-11-30')).json().items.map((x: { name: string }) => x.name)).toEqual(['День единства']);
    const c = await crm('owner', 'POST', `/holidays/${h.json().id}/cancel`, { reason: 'перенесли' });
    expect(c.json().status).toBe('cancelled');
    expect((await crm('admin', 'GET', '/holidays?from=2026-11-01&to=2026-11-30')).json().items).toEqual([]);
  });
});
