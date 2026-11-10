// S3-61: П3, П4, П5 через живой сервер. Заявка без согласия – CONSENT_REQUIRED; 6-я с телефона за сутки – RATE_LIMITED (и параллельно);
// повтор с ключом – та же заявка; в «Мои мероприятия» нет себестоимости и цен; при price_confirmed=false цены в П5 нет.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender, type DevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const LK = '/api/public/v1';
const clock = fixedClock('2026-06-01T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let sms: DevSmsSender;
const ids: Record<string, string> = {};
const clients: Record<string, { id: string; cookie: string }> = {};
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
let phoneN = 0;
const freshPhone = () => `+7913555${String(++phoneN).padStart(4, '0')}`;
let ipN = 0;
const freshIp = () => `203.0.113.${++ipN}`;

const body = (over: Record<string, unknown> = {}) => ({ branchId: ids.b1, preferredDate: '2026-06-20', format: 'h2', guests: 8, name: 'Анна', phone: freshPhone(), consent: true, ...over });
const post = (payload: object, key: string = randomUUID(), ip: string = freshIp()) =>
  app.inject({ method: 'POST', url: `${LK}/event-requests`, headers: { 'idempotency-key': key }, payload, remoteAddress: ip });

async function login(who: string, phone: string): Promise<void> {
  const r = await app.inject({ method: 'POST', url: `${LK}/auth/otp/request`, headers: { 'idempotency-key': randomUUID() }, payload: { phone, purpose: 'login' } });
  const v = await app.inject({ method: 'POST', url: `${LK}/auth/otp/verify`, payload: { challengeId: r.json().challengeId, code: /\d{6}/.exec(sms.sent.at(-1)!.text)![0], consents: { pdProcessing: true } } });
  expect(v.statusCode).toBe(200);
  clients[who] = { id: (await one('SELECT id FROM app.clients WHERE phone_e164 = $1', [phone])).id, cookie: String(v.headers['set-cookie']).split(';')[0]! };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  sms = createDevSmsSender('dev');
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients: { pool, auth: clientAuthConfig('c'.repeat(40)), sms, clock } });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'ул. Ленина, 1', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [ids.b1])).id;
  const unit = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, 'VR1', 'VR1') RETURNING id`, [ids.b1, ids.room])).id;
  const res = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, 'room_whole', 'Комната') RETURNING id`, [ids.b1, ids.room]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [res.id, unit]);
  ids.staff = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`)).id;
  await login('katya', '+79131110001');
  await login('olga', '+79131110002');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('S3-61: П4 заявка с сайта', () => {
  it('без согласия – CONSENT_REQUIRED, ничего не создано; без ключа – 400', async () => {
    const before = (await one('SELECT count(*)::int n FROM app.events')).n;
    for (const consent of [false, undefined]) {
      const r = await post(body({ consent }));
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('CONSENT_REQUIRED');
    }
    expect((await one('SELECT count(*)::int n FROM app.events')).n).toBe(before);
    const noKey = await app.inject({ method: 'POST', url: `${LK}/event-requests`, payload: body() });
    expect(noKey.statusCode).toBe(400);
  });
  it('заявка: new_request, source=site, birthday_party, без занятия комнаты и профиля клиента; телефон в аудите маскирован', async () => {
    const before = (await one('SELECT count(*)::int n FROM app.clients')).n;
    const phone = freshPhone();
    const r = await post(body({ phone, comment: 'Торт свой' }));
    expect(r.statusCode).toBe(201);
    const number = r.json().requestNumber;
    expect(number).toMatch(/^EV-\d{6}$/);
    expect(Object.keys(r.json())).toEqual(['requestNumber']);
    const e = await one(`SELECT e.*, t.code FROM app.events e JOIN app.event_types t ON t.id = e.type_id WHERE e.number = $1`, [number]);
    expect(e).toMatchObject({ status: 'new_request', source: 'site', code: 'birthday_party', planned_start: null, customer_client_id: null, party_format: 'h2', party_guests: 8, participants_count: 8, customer_phone_e164: phone, branch_id: ids.b1 });
    expect(e.wishes).toBe('Желаемая дата: 2026-06-20. Торт свой');
    expect((await one('SELECT count(*)::int n FROM app.event_resources WHERE event_id = $1', [e.id])).n).toBe(0);
    expect((await one('SELECT count(*)::int n FROM app.clients')).n).toBe(before);
    const log = await one(`SELECT after, ip FROM journal.audit_events WHERE action = 'event.request_received' AND object_id = $1`, [e.id]);
    expect(JSON.stringify(log.after)).not.toContain(phone.slice(-7));
    expect(log.after.consent).toBe(true);
    expect(log.after.consentVersion).toBeNull(); // страница согласия не опубликована
    expect(log.ip).toBeTruthy();
    // K22 §7: опубликованное согласие – его живая версия в аудите заявки
    await db.client.query(
      `INSERT INTO app.content_pages (key, document_version, status, draft, draft_updated_at, draft_updated_by, created_by, created_at)
       VALUES ('personal-data-consent', 'personal-data-consent-2026-11-01', 'published', '{}', now(), gen_random_uuid(), gen_random_uuid(), now())`,
    );
    const r2 = await post(body());
    expect(r2.statusCode).toBe(201);
    const e2 = await one(`SELECT id FROM app.events WHERE number = $1`, [r2.json().requestNumber]);
    const log2 = await one(`SELECT after FROM journal.audit_events WHERE action = 'event.request_received' AND object_id = $1`, [e2.id]);
    expect(log2.after.consentVersion).toBe('personal-data-consent-2026-11-01');
    await db.client.query(`DELETE FROM app.content_pages WHERE key = 'personal-data-consent'`);
  });
  it('повтор с ключом – та же заявка; тот же ключ с другими данными – отказ', async () => {
    const key = randomUUID();
    const ip = freshIp();
    const payload = body();
    const a = await post(payload, key, ip);
    const b = await post(payload, key, ip);
    expect(b.json().requestNumber).toBe(a.json().requestNumber);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect((await post({ ...payload, guests: 5 }, key, ip)).statusCode).toBe(409);
    expect((await one(`SELECT count(*)::int n FROM app.events WHERE customer_phone_e164 = $1`, [payload.phone])).n).toBe(1);
  });
  it('6-я заявка с телефона за сутки – RATE_LIMITED; параллельно лимит не пробивается', async () => {
    const phone = freshPhone();
    for (let i = 0; i < 5; i++) expect((await post(body({ phone }))).statusCode).toBe(201);
    const sixth = await post(body({ phone }));
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('RATE_LIMITED');
    expect(sixth.headers['retry-after']).toBe('86400');

    const race = freshPhone();
    const results = await Promise.all(Array.from({ length: 12 }, () => post(body({ phone: race }))));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(7);
  });
  it('30 заявок с адреса в час – 31-я RATE_LIMITED', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < 30; i++) expect((await post(body(), randomUUID(), ip)).statusCode).toBe(201);
    const over = await post(body(), randomUUID(), ip);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.details.reason).toBe('ip_hour');
    expect((await post(body(), randomUUID(), '198.51.100.8')).statusCode).toBe(201);
  });
  it('гостей 11 – PARTY_GUESTS_LIMIT; прошедшая дата, филиал без комнаты, неверный телефон – отказ; заявки выключены – отказ', async () => {
    expect((await post(body({ guests: 11 }))).json().error.code).toBe('PARTY_GUESTS_LIMIT');
    expect((await post(body({ preferredDate: '2026-05-01' }))).json().error.details.field).toBe('preferredDate');
    expect((await post(body({ branchId: ids.b2 }))).json().error.details.field).toBe('branchId');
    expect((await post(body({ branchId: randomUUID() }))).statusCode).toBe(404);
    expect((await post(body({ phone: '123' }))).json().error.code).toBe('VALIDATION_FAILED');
    expect((await post(body({ format: 'wrong' }))).statusCode).toBe(400);
    await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('event.requests_enabled', 'network', 'false'::jsonb, '2026-01-01', $1)`, [ids.staff]);
    try {
      expect((await post(body())).json().error.details.reason).toBe('requests_disabled');
    } finally {
      await db.client.query(`DELETE FROM app.settings_values WHERE key = 'event.requests_enabled'`);
    }
  });
});

describe('S3-61: П5 сведения о празднике', () => {
  it('цифры из настроек; филиалы с комнатой; цены нет при price_confirmed=false; условия подарка', async () => {
    const r = await app.inject({ method: 'GET', url: `${LK}/party-info` });
    expect(r.statusCode).toBe(200);
    const info = r.json();
    expect(info).toMatchObject({ minMinutes: 120, maxGuests: 10, priceConfirmed: false, formats: ['h2', 'h3plus', 'full_day'] });
    expect(info.branches).toEqual([{ id: ids.b1, name: 'b1', hasRoom: true }, { id: ids.b2, name: 'b2', hasRoom: false }]);
    expect(JSON.stringify(info)).not.toMatch(/price(Kop|_kop)|Kop/);
    expect(info.giftTerms).toMatchObject({ devices: 2, minutesEach: 30, roomMinutes: 40, validDays: 60, notIncluded: ['PS4', 'PS VR', 'food'] });
    await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('event.party.max_guests', 'network', '12'::jsonb, '2026-01-01', $1)`, [ids.staff]);
    try {
      expect((await app.inject({ method: 'GET', url: `${LK}/party-info?branchId=${ids.b1}` })).json()).toMatchObject({ maxGuests: 12, branches: [{ id: ids.b1 }] });
    } finally {
      await db.client.query(`DELETE FROM app.settings_values WHERE key = 'event.party.max_guests'`);
    }
  });
});

describe('S3-61: П3 мои мероприятия', () => {
  async function eventFor(clientId: string | null, status: string): Promise<string> {
    const type = await one(`SELECT id FROM app.event_types WHERE code = 'other'`);
    const e = await one(
      `INSERT INTO app.events (number, type_id, branch_id, title, planned_start, planned_end, status, customer_client_id, customer_name, customer_phone_e164, source, created_by_type)
       VALUES ('EV-T' || nextval('app.event_number_seq'), $1, $2, 'Выпускной', '2026-06-20T05:00:00Z', '2026-06-20T07:00:00Z', $3, $4, 'Анна', '+79131110001', 'crm', 'system') RETURNING id`,
      [type.id, ids.b1, status, clientId],
    );
    await db.client.query(`INSERT INTO app.event_lines (event_id, kind, name, quantity, unit, price_kop, plan_cost_kop) VALUES ($1, 'animator', 'Аниматор', 2, 'час', 300000, 777000), ($1, 'decor', 'Шары', 1, 'шт', 1000, 500)`, [e.id]);
    await db.client.query(`UPDATE app.event_lines SET status = 'removed', removed_reason = 'x' WHERE event_id = $1 AND name = 'Шары'`, [e.id]);
    return e.id;
  }
  it('только свои, от confirmed; без цен и себестоимости; без входа – 401', async () => {
    const mine = await eventFor(clients.katya!.id, 'confirmed');
    await eventFor(clients.katya!.id, 'negotiation');
    await eventFor(clients.olga!.id, 'confirmed');
    const r = await app.inject({ method: 'GET', url: `${LK}/me/events`, headers: { cookie: clients.katya!.cookie } });
    expect(r.statusCode).toBe(200);
    const items = r.json().items;
    expect(items.map((x: { id: string }) => x.id)).toEqual([mine]);
    expect(items[0]).toMatchObject({ title: 'Выпускной', status: 'confirmed', branch: { name: 'b1', address: 'ул. Ленина, 1' }, lines: [{ name: 'Аниматор', quantity: 2, unit: 'час' }] });
    expect(JSON.stringify(items)).not.toMatch(/777000|300000|Kop|cost/i);
    expect((await app.inject({ method: 'GET', url: `${LK}/me/events` })).statusCode).toBe(401);
  });
});
