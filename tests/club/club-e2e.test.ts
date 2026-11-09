// S3-97: сквозные TC-12…TC-16, TC-19 (20 §TC) и критерии 18 §7.4 через HTTP-маршруты API (CRM /api/crm/v1 и сайт /api/public/v1),
// одна база и один сервер на все сценарии: ремонт → блокировка → бронь не тронута; праздник занимает комнату; подарок через сайт до
// «использован»; Администратор двух филиалов; Директор зоны и делегирование; смена → начисление → ведомость → выплата → расход ровно один раз.
// Обработчики outbox (зарплата, подарок) вызываются тестом – это работа процесса worker, в сервере их нет.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import { localToInstant, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender, type DevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { GIFT_HANDLERS, registerGiftHandlers } from '../../apps/api/src/modules/events/gift-booking.ts';
import { runReconcile } from '../../apps/api/src/modules/reports/reconcile.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers } from '../../apps/api/src/modules/shifts/accrual.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-клуба-сквозной-1';
const CRM = '/api/crm/v1';
const LK = '/api/public/v1';
const TZ = 'Asia/Novosibirsk' as TimeZone;
// Понедельник 16.11.2026, 10:30 по Новосибирску. Сессия сотрудника живёт 8 ч простоя – часы двигаются только внутри дня.
const now = { value: new Date('2026-11-16T03:30:00Z') };
const clock = { now: () => now.value };
const at = (time: string, date: string) => localToInstant(date as LocalDate, time as LocalTime, TZ).toISOString();
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let sms: DevSmsSender;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let client = { id: '', cookie: '' };

type Method = 'GET' | 'POST' | 'PATCH';
const crm = (who: string, method: Method, url: string, payload?: object, key: string = randomUUID()) =>
  app.inject({ method, url: `${CRM}${url}`, headers: { cookie: cookies[who]!, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
const lk = (method: Method, url: string, payload?: object, key: string = randomUUID()) =>
  app.inject({ method, url: `${LK}${url}`, headers: { cookie: client.cookie, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
const ok = async (p: ReturnType<typeof crm>, code = 200) => {
  const r = await p;
  expect(r.statusCode, r.body).toBe(code);
  return r.json();
};
const errorOf = async (p: ReturnType<typeof crm>) => {
  const r = await p;
  return [r.statusCode, r.json().error?.code];
};

async function staff(key: string, role: string, branchIds: string[] = []): Promise<void> {
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', $1, $2, $3, $4) RETURNING id`, [key, `${key.toLowerCase()}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[key] = s.id;
  for (const b of branchIds) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s.id, b]);
  const res = await app.inject({ method: 'POST', url: `${CRM}/auth/login`, payload: { email: `${key.toLowerCase()}@yu.test`, password: PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

/** Доставка событий outbox нужным обработчикам – то, что делает worker. */
async function deliver(types: Record<string, string>): Promise<void> {
  const r = await db.client.query<{ id: string; event_type: string }>(
    `SELECT e.id, e.event_type FROM app.outbox_events e WHERE e.event_type = ANY($1) ORDER BY e.occurred_at, e.id`,
    [Object.keys(types)],
  );
  for (const e of r.rows) await processEvent(pool, types[e.event_type]!, e.id, clock.now());
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 10 });
  sms = createDevSmsSender('dev');
  clearSubscriptions();
  registerPayrollHandlers({ clock });
  registerGiftHandlers({ clock });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock },
    clients: { pool, auth: clientAuthConfig('c'.repeat(40)), sms, clock },
  });
  await staff('owner', 'owner');
  // филиалы – SQL владельцем базы (через API филиал создаётся черновиком без графика); график 10:00–22:00
  const city = async (code: string, tz: string) => (await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ($1, $1, $1, $2) RETURNING id`, [code, tz])).id as string;
  const nsk = await city('nsk', TZ);
  const tomsk = await city('tomsk', 'Asia/Tomsk');
  for (const [slug, cityId, tz] of [['lenina', nsk, TZ], ['marksa', nsk, TZ], ['tomsk', tomsk, 'Asia/Tomsk']] as const) {
    ids[slug] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', $3, 'active') RETURNING id`, [cityId, slug, tz])).id;
    await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids[slug], ids.owner]);
    await db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`, [ids[slug], ids.owner]);
  }
  for (const [type, unit, price] of [['vr_seat', 15, 10_000], ['room_whole', 30, 50_000], ['gift_vr', 5, 0]] as const) {
    await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, $3, $4, '2026-01-01', 'active', $5)`, [ids.lenina, type, unit, price, ids.owner]);
  }
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR-комната', true) RETURNING id`, [ids.lenina])).id;
  for (const code of ['VR1', 'VR2', 'PS4']) ids[code] = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [ids.lenina, ids.room, code])).id;
  const resource = async (type: string, name: string, units: string[], extra = '') => {
    const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name${extra ? ', self_bookable, step_minutes_override' : ''}) VALUES ($1, $2, $3, $4${extra}) RETURNING id`, [ids.lenina, ids.room, type, name]);
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, units]);
    return r.id as string;
  };
  ids.vr1 = await resource('vr_seat', 'VR-место 1', [ids.VR1!]);
  ids.vr2 = await resource('vr_seat', 'VR-место 2', [ids.VR2!]);
  ids.whole = await resource('room_whole', 'Комната целиком', [ids.VR1!, ids.VR2!, ids.PS4!]);
  ids.gift = await resource('gift_vr', 'Подарок: 2 VR', [ids.VR1!, ids.VR2!], ', false, 5');
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('payroll.penalties_enabled', 'network', 'true', '2026-01-01', $1)`, [ids.owner]);
  await staff('director', 'director', [ids.lenina!]);
  await staff('admin', 'admin', [ids.lenina!, ids.marksa!]);
  await staff('adminMarksa', 'admin', [ids.marksa!]);
  await staff('directorTomsk', 'director', [ids.tomsk!]);
  // клиент – через вход по коду на сайте
  const r = await app.inject({ method: 'POST', url: `${LK}/auth/otp/request`, headers: { 'idempotency-key': randomUUID() }, payload: { phone: '+79131110001', purpose: 'login' } });
  expect(r.statusCode, r.body).toBeLessThan(300);
  const v = await app.inject({ method: 'POST', url: `${LK}/auth/otp/verify`, payload: { challengeId: r.json().challengeId, code: /\d{6}/.exec(sms.sent.at(-1)!.text)![0], consents: { pdProcessing: true } } });
  expect(v.statusCode, v.body).toBe(200);
  client = { id: (await one('SELECT id FROM app.clients WHERE phone_e164 = $1', ['+79131110001'])).id, cookie: String(v.headers['set-cookie']).split(';')[0]! };
  for (const t of (await db.client.query<{ id: string; code: string }>('SELECT id, code FROM app.event_types')).rows) ids[`type_${t.code}`] = t.id;
  ids.category = (await one(`SELECT id FROM app.equipment_categories WHERE name = 'VR-шлемы'`)).id;
  const cat = await one(`SELECT p.id AS "categoryId", c.id AS "subcategoryId" FROM app.finance_categories p JOIN app.finance_categories c ON c.parent_id = p.id WHERE p.kind = 'expense' ORDER BY p.sort_order, c.sort_order LIMIT 1`);
  ids.expenseCategory = cat.categoryId;
  ids.expenseSubcategory = cat.subcategoryId;
});
afterAll(async () => {
  clearSubscriptions();
  await app.close();
  await pool.end();
  await db.drop();
});

describe('S3-97: сквозные сценарии Э3 по HTTP', () => {
  it('TC-12: ремонт с будущей бронью – бронь не удалена и не отменена, новые брони закрыты, решение – переносом сотрудника с событием для push (18 §7.4)', async () => {
    const booking = await ok(crm('admin', 'POST', `/branches/${ids.lenina}/bookings`, { resourceId: ids.vr1, start: '2026-11-17T07:00:00Z', end: '2026-11-17T08:00:00Z', client: { clientId: client.id } }), 201);
    const eq = await ok(crm('owner', 'POST', '/equipment', { name: 'Шлем VR1', categoryId: ids.category, branchId: ids.lenina, unitId: ids.VR1 }), 201);
    const reg = await ok(crm('admin', 'POST', '/repairs', { equipmentId: eq.id, detectedAt: '2026-11-16T03:00:00Z', brokenAtUnknown: true, symptoms: 'не включается', priority: 'high', impact: 'full' }), 201);
    expect(reg.autoBlock).toBeNull(); // молча ничего не блокируется
    const period = { start: '2026-11-17T03:00:00Z', end: '2026-11-17T15:00:00Z' };
    const proposal = await ok(crm('admin', 'GET', `/repairs/${reg.repair.id}/block-proposal?targetType=unit&targetId=${ids.VR1}&start=${period.start}&end=${period.end}`));
    expect(proposal.affectedBookings.map((b: { id: string }) => b.id)).toEqual([booking.id]);
    const blocked = await ok(crm('admin', 'POST', `/repairs/${reg.repair.id}/blocks`, { target: { type: 'unit', ids: [ids.VR1] }, period, comment: 'шлем' }), 201);
    expect(blocked.affectedBookings.map((b: { id: string; status: string }) => [b.id, b.status])).toEqual([[booking.id, 'confirmed']]);
    // 18 §7.4: существующая бронь не отменена автоматически
    expect((await ok(crm('admin', 'GET', `/bookings/${booking.id}`))).status).toBe('confirmed');
    // 18 §7.4: ресурс на ремонте недоступен для новых броней – ни в CRM, ни на сайте
    const [status] = await errorOf(crm('admin', 'POST', `/branches/${ids.lenina}/bookings`, { resourceId: ids.vr1, start: '2026-11-17T10:00:00Z', end: '2026-11-17T11:00:00Z', client: { clientId: client.id } }));
    expect(status).toBe(409);
    const site = await lk('POST', '/holds', { branchId: ids.lenina, items: [{ resourceId: ids.vr1, start: '2026-11-17T10:00:00Z', end: '2026-11-17T10:30:00Z' }] });
    expect(site.statusCode).toBe(409);
    const av = (await app.inject({ method: 'GET', url: `${LK}/branches/${ids.lenina}/availability?date=2026-11-17`, headers: { cookie: `yu_visitor=${randomUUID()}` } })).json();
    const vr1 = (av.resources as Array<{ resourceId: string; slots: Array<{ start: string; state: string }> }>).find((x) => x.resourceId === ids.vr1)!;
    expect(vr1.slots.find((s) => s.start === '2026-11-17T10:00:00.000Z')?.state).toBe('blocked');
    // решение – действием сотрудника: перенос на свободное VR-место, клиенту уходит сервисное событие
    const moved = await ok(crm('admin', 'POST', `/bookings/${booking.id}/reschedule`, { rowVersion: 1, resourceId: ids.vr2, start: '2026-11-17T07:00:00Z', end: '2026-11-17T08:00:00Z', reason: 'ремонт шлема' }));
    expect(moved).toMatchObject({ status: 'confirmed', resourceId: ids.vr2 });
    const ev = await one(`SELECT count(*)::int n FROM app.outbox_events WHERE event_type = 'booking.rescheduled' AND payload ->> 'bookingId' = $1`, [booking.id]);
    expect(ev.n).toBe(1);
    const card = await ok(crm('admin', 'GET', `/repairs/${reg.repair.id}`));
    expect(card.timeline.map((t: { action: string }) => t.action)).toEqual(expect.arrayContaining(['repair.registered', 'repair.block_linked']));
  });

  it('TC-13: праздник – комната целиком ≥ 120 мин, гости 1–10; время праздника занято на сайте и для VR-места; план отдельно от факта (18 §7.4)', async () => {
    const base = { typeId: ids.type_birthday_party, branchId: ids.lenina, customer: { clientId: client.id, name: 'Анна', phone: '+79131110001' }, birthdayPerson: { clientId: client.id } };
    expect(await errorOf(crm('owner', 'POST', '/events', { ...base, party: { format: 'h2', guests: 11 } }))).toEqual([422, 'PARTY_GUESTS_LIMIT']);
    const e = await ok(crm('owner', 'POST', '/events', { ...base, participantsCount: 8, plannedStart: '2026-11-16T05:00:00Z', plannedEnd: '2026-11-16T07:00:00Z', party: { format: 'h2', guests: 8 } }), 201);
    ids.party = e.id;
    expect((await errorOf(crm('owner', 'POST', `/events/${e.id}/resources`, { resourceId: ids.whole, start: '2026-11-16T05:00:00Z', end: '2026-11-16T06:30:00Z' })))[1]).toBe('PARTY_TOO_SHORT');
    expect((await errorOf(crm('owner', 'POST', `/events/${e.id}/resources`, { resourceId: ids.vr1, start: '2026-11-16T05:00:00Z', end: '2026-11-16T07:00:00Z' })))[1]).toBe('PARTY_RESOURCE_INVALID');
    await ok(crm('owner', 'POST', `/events/${e.id}/resources`, { resourceId: ids.whole, start: '2026-11-16T05:00:00Z', end: '2026-11-16T07:00:00Z' }), 201);
    // С19: время праздника на сайте – booked, удержание VR-места – SLOT_TAKEN
    const av = (await app.inject({ method: 'GET', url: `${LK}/branches/${ids.lenina}/availability?date=2026-11-16`, headers: { cookie: `yu_visitor=${randomUUID()}` } })).json();
    for (const r of av.resources as Array<{ resourceId: string; slots: Array<{ start: string; state: string }> }>) {
      if (![ids.vr1, ids.vr2, ids.whole].includes(r.resourceId)) continue;
      expect([r.resourceId, r.slots.find((s) => s.start === '2026-11-16T06:00:00.000Z')?.state]).toEqual([r.resourceId, 'booked']);
    }
    const hold = await lk('POST', '/holds', { branchId: ids.lenina, items: [{ resourceId: ids.vr2, start: '2026-11-16T06:00:00Z', end: '2026-11-16T06:30:00Z' }] });
    expect(hold.json().error.code).toBe('SLOT_TAKEN');
    // неподтверждённая цена не рассчитывается: без строк подтвердить нельзя
    const ready = await ok(crm('owner', 'POST', `/events/${e.id}/status`, { rowVersion: e.rowVersion, to: 'awaiting_confirmation' }));
    const v1 = ready.event.rowVersion;
    const notReady = await crm('owner', 'POST', `/events/${e.id}/status`, { rowVersion: v1, to: 'confirmed' });
    expect([notReady.statusCode, notReady.json().error.code, notReady.json().error.details.fields]).toEqual([422, 'EVENT_NOT_READY', ['lines']]);
    await ok(crm('owner', 'POST', `/events/${e.id}/lines`, { kind: 'room_rent', name: 'Комната VR+PS4, 2 часа', quantity: 1, unit: 'шт', priceKop: 1_000_000, planCostKop: 200_000 }), 201);
    const confirmed = await ok(crm('owner', 'POST', `/events/${e.id}/status`, { rowVersion: (await ok(crm('owner', 'GET', `/events/${e.id}`))).rowVersion, to: 'confirmed' }));
    expect(confirmed.event.status).toBe('confirmed');
    // 18 §7.4: план и факт раздельно – согласовано, получено, плановая и фактическая себестоимость
    await ok(crm('owner', 'POST', `/events/${e.id}/income`, { method: 'card', amountKop: 300_000, occurredAt: '2026-11-16T03:00:00Z' }), 201);
    await ok(crm('owner', 'POST', `/events/${e.id}/expense`, { method: 'card', amountKop: 150_000, categoryId: ids.expenseCategory, subcategoryId: ids.expenseSubcategory, occurredAt: '2026-11-16T03:10:00Z', comment: 'аниматор' }), 201);
    const money = await ok(crm('owner', 'GET', `/events/${e.id}/money`));
    expect(money.summary).toMatchObject({ agreedKop: 1_000_000, receivedKop: 300_000, dueKop: 700_000, planCostKop: 200_000, factCostKop: 150_000 });
    const asAdmin = await ok(crm('admin', 'GET', `/events/${e.id}`));
    expect(JSON.stringify(asAdmin)).not.toContain('planCostKop');
  });

  it('TC-14: подарок имениннику через сайт – 60 дней, только будни без праздников, два VR, без PS4/PS VR/еды; оплата 0; приход → used', async () => {
    const v = (await ok(crm('owner', 'GET', `/events/${ids.party}`))).rowVersion;
    expect((await ok(crm('admin', 'POST', `/events/${ids.party}/status`, { rowVersion: v, to: 'in_progress' }))).event.status).toBe('in_progress');
    const gift = await ok(crm('director', 'POST', '/gifts', { clientId: client.id, basisEventId: ids.party }), 201);
    expect(gift).toMatchObject({ status: 'issued', issuedOn: '2026-11-16', validUntil: '2027-01-15' });
    expect(gift.terms).toMatchObject({ devices: 2, weekdays: [1, 2, 3, 4, 5], excludesHolidays: true, notIncluded: ['PS4', 'PS VR', 'food'] });
    expect((await errorOf(crm('owner', 'POST', '/gifts', { clientId: client.id, basisEventId: ids.party })))[1]).toBe('GIFT_ALREADY_ISSUED');
    await ok(crm('owner', 'POST', '/holidays', { scope: 'network', date: '2026-11-18', name: 'Праздник сети' }), 201);
    const day = async (date: string) => (await lk('GET', `/me/gifts/${gift.id}/slots?branchId=${ids.lenina}&date=${date}`)).json();
    expect(await day('2026-11-21')).toMatchObject({ closedReason: 'GIFT_WEEKDAY_ONLY', slots: [] });
    expect(await day('2026-11-18')).toMatchObject({ closedReason: 'GIFT_HOLIDAY', slots: [] });
    expect(await day('2027-01-18')).toMatchObject({ closedReason: 'GIFT_EXPIRED', slots: [] });
    const today = await day('2026-11-16');
    expect(today.closedReason).toBeNull();
    // праздник занимает комнату до 14:00 – окна подарка начинаются не раньше
    expect(today.slots.every((s: { start: string; end: string }) => s.start >= '2026-11-16T07:00:00.000Z' || s.end <= '2026-11-16T05:00:00.000Z')).toBe(true);
    const start = today.slots.find((s: { start: string }) => s.start >= '2026-11-16T09:00:00.000Z').start as string;
    const h = await lk('POST', `/me/gifts/${gift.id}/hold`, { branchId: ids.lenina, start });
    expect(h.statusCode, h.body).toBe(201);
    expect(h.json().items.map((i: { resourceId: string; priceKop: number }) => [i.resourceId, i.priceKop])).toEqual([[ids.gift, 0]]);
    const done = await lk('POST', `/holds/${h.json().id}/confirm`, {});
    expect(done.statusCode, done.body).toBe(201);
    const booking = done.json().bookings[0];
    expect(booking.priceKop).toBe(0);
    await deliver({ 'booking.confirmed': GIFT_HANDLERS.bookingConfirmed });
    expect((await ok(crm('admin', 'GET', `/gifts?clientId=${client.id}`))).items[0]).toMatchObject({ status: 'reserved', bookingId: booking.id });
    // оплата: способ none, денег в кассе нет
    expect((await one(`SELECT count(*)::int n FROM journal.finance_operations WHERE ref_type = 'booking' AND ref_id = $1`, [booking.id])).n).toBe(0);
    now.value = new Date(start);
    await ok(crm('admin', 'POST', `/bookings/${booking.id}/arrive`, { rowVersion: 1 }));
    await deliver({ 'visit.confirmed': GIFT_HANDLERS.visitConfirmed });
    expect((await ok(crm('admin', 'GET', `/gifts?clientId=${client.id}`))).items[0].status).toBe('used');
    expect((await lk('GET', '/me/gifts')).json().items[0].status).toBe('used');
  });

  it('TC-15: Администратор двух филиалов – последовательные смены можно, пересекающиеся нельзя; другой город не открывается (18 §7.4)', async () => {
    await ok(crm('owner', 'POST', `/staff/${ids.admin}/rates`, { validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 0, reason: 'старт' }), 201);
    const shift = (branch: string, from: string, to: string) => crm('owner', 'POST', '/shifts', { staffId: ids.admin, branchId: ids[branch], start: at(from, '2026-11-20'), end: at(to, '2026-11-20') });
    await ok(shift('lenina', '10:00', '14:00'), 201);
    await ok(shift('marksa', '14:00', '18:00'), 201);
    expect(await errorOf(shift('marksa', '13:00', '15:00'))).toEqual([409, 'SHIFT_OVERLAP']);
    expect((await ok(crm('admin', 'GET', `/shifts?staffId=${ids.admin}&from=2026-11-20&to=2026-11-20`))).items).toHaveLength(2);
    expect((await crm('admin', 'GET', `/shifts?branchIds=${ids.tomsk}&from=2026-11-20&to=2026-11-20`)).statusCode).toBe(404);
    expect((await crm('admin', 'GET', `/branches/${ids.tomsk}`)).statusCode).toBe(404);
    const [code] = await errorOf(shift('tomsk', '19:00', '21:00'));
    expect([404, 422]).toContain(code); // в филиал вне назначений смену не поставить
  });

  it('TC-16: Директор зоны {lenina} видит только её, не назначает директоров и не расширяет доступ; делегированное право в одном филиале не открывает другой (04 §9)', async () => {
    const foreign = await ok(crm('owner', 'POST', '/shifts', { staffId: ids.adminMarksa, branchId: ids.marksa, start: at('10:00', '2026-11-21'), end: at('12:00', '2026-11-21') }), 201);
    expect((await crm('director', 'GET', `/shifts/${foreign.id}`)).statusCode).toBe(404);
    expect((await crm('director', 'GET', `/shifts?branchIds=${ids.marksa}&from=2026-11-21&to=2026-11-21`)).statusCode).toBe(404);
    const eq = await ok(crm('owner', 'POST', '/equipment', { name: 'Шлем марксa', categoryId: ids.category, branchId: ids.marksa }), 201);
    expect((await crm('director', 'GET', `/equipment/${eq.id}`)).statusCode).toBe(404);
    expect((await ok(crm('director', 'GET', '/events'))).items.every((x: { branchId: string }) => x.branchId === ids.lenina)).toBe(true);
    expect((await crm('director', 'POST', '/staff', { firstName: 'Н', lastName: 'Д', email: 'new-dir@yu.test', role: 'director', branchIds: [ids.lenina] })).statusCode).toBe(403);
    const card = await ok(crm('owner', 'GET', `/staff/${ids.adminMarksa}`));
    expect((await crm('director', 'PATCH', `/staff/${ids.adminMarksa}`, { rowVersion: card.rowVersion, branchIds: [ids.lenina, ids.marksa] })).statusCode).toBe(404);
    expect((await crm('director', 'POST', `/staff/${ids.adminMarksa}/grants`, { action: 'payroll.view', branchId: ids.lenina, validFrom: '2026-11-16' })).statusCode).toBe(403);
    // делегирование: payroll.view Администратору только в lenina – суммы смен видны там и не видны в marksa
    const accrual = async (branch: string) => (await ok(crm('admin', 'GET', `/shifts?branchIds=${ids[branch]}&from=2026-11-20&to=2026-11-20`))).items[0].plannedAccrualKop;
    expect(await accrual('lenina')).toBeNull();
    await ok(crm('owner', 'POST', `/staff/${ids.admin}/grants`, { action: 'payroll.view', branchId: ids.lenina, validFrom: '2026-11-16', reason: 'замещает директора' }), 201);
    expect(await accrual('lenina')).toBe(240_000);
    expect(await accrual('marksa')).toBeNull();
    const audit = await one(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'staff.grant.created' AND result = 'success'`);
    expect(audit.n).toBe(1);
  });

  it('TC-19 и 18 §7.4: короткая смена по факту, начисление из ставки и часов, штраф с основанием и историей, выплата и расход ровно один раз, сверка без расхождений', async () => {
    const p = await ok(crm('owner', 'POST', '/payroll/periods', { from: '2026-10-01', to: '2026-10-31' }), 201);
    const s = await ok(crm('owner', 'POST', '/shifts', { staffId: ids.admin, branchId: ids.lenina, start: at('12:00', '2026-10-10'), end: at('18:00', '2026-10-10') }), 201);
    expect(s.plannedAccrualKop).toBe(360_000);
    // короткая смена: 6 ч в плане, 90 мин по факту – начисление по факту
    await ok(crm('owner', 'POST', `/shifts/${s.id}/attendance`, { rowVersion: 1, status: 'worked', paidMinutes: 90, reason: 'ушёл раньше' }));
    await deliver({ 'shift.attendance_changed': HANDLER_ATTENDANCE, 'staff.rate_set': HANDLER_RATE });
    expect((await ok(crm('owner', 'GET', `/shifts/${s.id}`))).factAccrualKop).toBe(90_000);
    // штраф: без основания нельзя; правка – новая запись, прежняя отменена с причиной
    expect((await errorOf(crm('director', 'POST', '/payroll/penalties', { staffId: ids.admin, branchId: ids.lenina, date: '2026-10-10', amountKop: 10_000, reason: ' ' })))[0]).toBeGreaterThanOrEqual(400);
    const pen = await ok(crm('director', 'POST', '/payroll/penalties', { staffId: ids.admin, branchId: ids.lenina, date: '2026-10-10', amountKop: 10_000, reason: 'опоздание' }), 201);
    const amended = await ok(crm('director', 'POST', `/payroll/penalties/${pen.id}/amend`, { amountKop: 5_000, why: 'опоздание 10 минут, не 30' }));
    const history = (await ok(crm('director', 'GET', `/payroll/penalties?staffId=${ids.admin}&periodId=${p.id}`))).items as Array<{ id: string; status: string; amountKop: number; reason: string }>;
    expect(history.find((x) => x.id === pen.id)).toMatchObject({ status: 'cancelled', amountKop: 10_000, reason: 'опоздание' });
    expect(history.find((x) => x.id === (amended.id ?? amended.penalty?.id))).toMatchObject({ status: 'active', amountKop: 5_000 });
    // начисления воспроизводятся: расчёт = 1,5 ч × 600 ₽ − штраф 50 ₽
    const calc = (await ok(crm('owner', 'POST', `/payroll/periods/${p.id}/calculate`, {}))) as Array<{ id: string; staffId: string; totals: { toPayKop: number } }>;
    const st = calc.find((x) => x.staffId === ids.admin)!;
    expect(st.totals.toPayKop).toBe(85_000);
    expect((await ok(crm('owner', 'POST', `/payroll/periods/${p.id}/calculate`, {}))).find((x: { staffId: string }) => x.staffId === ids.admin).totals.toPayKop).toBe(85_000);
    await ok(crm('owner', 'POST', `/payroll/periods/${p.id}/close`, {}));
    const checked = await ok(crm('director', 'POST', `/payroll/statements/${st.id}/status`, { rowVersion: (await ok(crm('owner', 'GET', `/payroll/statements/${st.id}`))).rowVersion, status: 'checked' }));
    const ready = await ok(crm('owner', 'POST', `/payroll/statements/${st.id}/status`, { rowVersion: checked.rowVersion, status: 'ready' }));
    expect((await ok(crm('owner', 'POST', `/payroll/statements/${st.id}/paid`, { rowVersion: ready.rowVersion, actualPayoutDate: '2026-11-16' }))).status).toBe('paid');
    const before = (await ok(crm('owner', 'GET', `/branches/${ids.lenina}/finance/summary?from=2026-11-16&to=2026-11-16`))).total.expenseKop as number;
    const key = randomUUID();
    const body = { place: 'cash', method: 'cash', split: 'by_branch', occurredAt: now.value.toISOString() };
    const e1 = await ok(crm('owner', 'POST', `/payroll/statements/${st.id}/payout-expense`, body, key), 201);
    const e2 = await ok(crm('owner', 'POST', `/payroll/statements/${st.id}/payout-expense`, body, key), 201);
    expect(e2.operations.map((o: { id: string }) => o.id)).toEqual(e1.operations.map((o: { id: string }) => o.id));
    expect((await errorOf(crm('owner', 'POST', `/payroll/statements/${st.id}/payout-expense`, body)))[1]).toBe('PAYOUT_EXPENSE_EXISTS');
    const after = (await ok(crm('owner', 'GET', `/branches/${ids.lenina}/finance/summary?from=2026-11-16&to=2026-11-16`))).total.expenseKop as number;
    expect(after - before).toBe(85_000);
    // С21: ночная сверка S3-95 на тех же данных – без расхождений
    const report = await runReconcile(pool, { trigger: 'manual', clock, logger: { info: () => undefined, error: () => undefined } });
    expect(report!.discrepancies).toEqual([]);
  });
});
