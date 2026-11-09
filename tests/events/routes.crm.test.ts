// S3-55: API мероприятий №361–370 через живой сервер. IDOR: объект чужого филиала – 404; без event.money.view – только dueKop;
// отмена возвращает needsDecision (брони, подарки, деньги), связанные брони не отменены (приёмка 12); идемпотентность ключа;
// блокировка видит мероприятие (registerEventSources подключён сервером).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { buildProposal } from '../../apps/api/src/modules/equipment/items.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-мероприятий-проверка-1';
const BASE = '/api/crm/v1';
const AT = '2026-11-14T04:00:00Z';
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const types: Record<string, string> = {};

type Who = 'owner' | 'director' | 'admin' | 'stranger';
function req(who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = key;
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
const newEvent = async (over: Record<string, unknown> = {}, who: Who = 'owner') => {
  const r = await req(who, 'POST', '/events', { typeId: types.other, branchId: ids.b1, customer: { name: 'Анна Смирнова', phone: '+79131234567' }, ...over });
  expect(r.statusCode).toBe(201);
  return r.json();
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('e'.repeat(40)), clock } });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
  }
  await staff('owner', 'owner', null);
  await staff('director', 'director', ids.b1!);
  await staff('admin', 'admin', ids.b1!);
  await staff('stranger', 'director', ids.b2!);
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, ids.owner]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'vr_seat', 'VR', 15, 10000, '2026-01-01', 'active', $2)`, [ids.b1, ids.owner]);
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR-комната', true) RETURNING id`, [ids.b1])).id;
  ids.u1 = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, 'VR1', 'VR1') RETURNING id`, [ids.b1, ids.room])).id;
  const res = async (type: string, name: string) => {
    const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [ids.b1, ids.room, type, name]);
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [r.id, ids.u1]);
    return r.id as string;
  };
  ids.vr = await res('vr_seat', 'VR-место');
  ids.whole = await res('room_whole', 'Комната');
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type) VALUES ('+79131112233', 'Анна', 'active', 'system') RETURNING id`)).id;
  for (const t of (await db.client.query<{ id: string; code: string }>('SELECT id, code FROM app.event_types')).rows) types[t.code] = t.id;
  const cat = await one(`SELECT p.id AS "categoryId", c.id AS "subcategoryId" FROM app.finance_categories p JOIN app.finance_categories c ON c.parent_id = p.id WHERE p.kind = 'expense' ORDER BY p.sort_order, c.sort_order LIMIT 1`);
  ids.category = cat.categoryId;
  ids.subcategory = cat.subcategoryId;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('S3-55: IDOR и права', () => {
  it('объект чужого филиала – 404 на каждом маршруте; без входа – 401', async () => {
    const e = await newEvent();
    const line = (await req('owner', 'POST', `/events/${e.id}/lines`, { kind: 'service', name: 'Услуга', quantity: 1, unit: 'шт', priceKop: 100 })).json();
    const calls: Array<['GET' | 'POST' | 'PATCH', string, object?]> = [
      ['GET', `/events/${e.id}`],
      ['PATCH', `/events/${e.id}`, { rowVersion: 1, wishes: 'x' }],
      ['POST', `/events/${e.id}/status`, { rowVersion: 1, to: 'negotiation' }],
      ['POST', `/events/${e.id}/lines`, { kind: 'service', name: 'x', quantity: 1, unit: 'шт', priceKop: 0 }],
      ['PATCH', `/event-lines/${line.id}`, { rowVersion: 1, comment: 'x' }],
      ['POST', `/event-lines/${line.id}/remove`, { rowVersion: 1, reason: 'x' }],
      ['POST', `/events/${e.id}/apply-package`, { packageId: randomUUID() }],
      ['POST', `/events/${e.id}/resources`, { resourceId: ids.vr, start: '2026-11-16T05:00:00Z', end: '2026-11-16T05:30:00Z' }],
      ['POST', `/events/${e.id}/resources/${randomUUID()}/release`, { reason: 'x' }],
      ['POST', `/events/${e.id}/move`, { rowVersion: 1, plannedStart: '2026-11-16T05:00:00Z', plannedEnd: '2026-11-16T06:00:00Z', reason: 'x' }],
      ['POST', `/events/${e.id}/bookings`, { bookingId: randomUUID() }],
      ['POST', `/events/${e.id}/bookings/${randomUUID()}/unlink`, {}],
      ['GET', `/events/${e.id}/checklist`],
      ['POST', `/events/${e.id}/checklist`, { title: 'x' }],
      ['PATCH', `/events/${e.id}/checklist`, { itemId: randomUUID(), status: 'done' }],
      ['GET', `/events/${e.id}/money`],
      ['POST', `/events/${e.id}/income`, { method: 'cash', amountKop: 100, occurredAt: AT }],
      ['POST', `/events/${e.id}/refund`, { incomeOperationId: randomUUID(), amountKop: 1, method: 'cash', reason: 'x' }],
      ['POST', `/events/${e.id}/expense`, { method: 'cash', amountKop: 1, categoryId: ids.category, occurredAt: AT, comment: 'x' }],
      ['POST', `/events/${e.id}/expense/link`, { operationId: randomUUID() }],
    ];
    for (const [method, url, body] of calls) {
      const r = await req('stranger', method, url, body);
      expect([url, r.statusCode]).toEqual([url, 404]);
    }
    const list = (await req('stranger', 'GET', '/events')).json();
    expect(list.items.map((x: { id: string }) => x.id)).not.toContain(e.id);
    expect((await app.inject({ method: 'GET', url: `${BASE}/events/${e.id}` })).statusCode).toBe(401);
  });
  it('отказ в зоне: цена Администратором – 403 и запись в аудит', async () => {
    const e = await newEvent();
    const r = await req('admin', 'POST', `/events/${e.id}/lines`, { kind: 'service', name: 'x', quantity: 1, unit: 'шт', priceKop: 100 });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.details.action).toBe('event.price.manage');
    const log = await db.client.query(`SELECT result FROM journal.audit_events WHERE action = 'event.line_added' AND object_id = $1 AND result = 'denied'`, [e.id]);
    expect(log.rowCount).toBe(1);
  });
  it('без event.money.view: только dueKop – в списке и карточке; №368 – 403; плановой себестоимости нет', async () => {
    const e = await newEvent();
    await req('owner', 'POST', `/events/${e.id}/lines`, { kind: 'service', name: 'Услуга', quantity: 1, unit: 'шт', priceKop: 90000, planCostKop: 30000 });
    await req('owner', 'POST', `/events/${e.id}/income`, { method: 'cash', amountKop: 10000, occurredAt: AT });
    const card = (await req('admin', 'GET', `/events/${e.id}`)).json();
    expect(card.money).toEqual({ dueKop: 80000 });
    expect(card.lines[0].priceKop).toBe(90000);
    expect(card.lines[0]).not.toHaveProperty('planCostKop');
    expect(JSON.stringify(card.timeline)).not.toContain('30000');
    const row = (await req('admin', 'GET', '/events?customer=Смирнова')).json().items.find((x: { id: string }) => x.id === e.id);
    expect(row.money).toEqual({ dueKop: 80000 });
    expect((await req('admin', 'GET', `/events/${e.id}/money`)).statusCode).toBe(403);
    const full = (await req('director', 'GET', `/events/${e.id}`)).json();
    expect(full.money).toMatchObject({ agreedKop: 90000, receivedKop: 10000, planCostKop: 30000 });
    expect(full.lines[0].planCostKop).toBe(30000);
    expect(full.timeline.length).toBeGreaterThan(0);
    const m = (await req('director', 'GET', `/events/${e.id}/money`)).json();
    expect(m.summary.dueKop).toBe(80000);
    expect(m.operations.map((o: { role: string }) => o.role)).toEqual(['income']);
  });
});

describe('S3-55: список', () => {
  it('фильтры: статус, тип, филиал, телефон, hasDue, курсор', async () => {
    const paid = await newEvent({ title: 'Оплаченное', customer: { name: 'Клава', phone: '+79990001122' } });
    const unpaid = await newEvent({ title: 'С долгом', customer: { name: 'Клава', phone: '+79990001122' } });
    await req('owner', 'POST', `/events/${unpaid.id}/lines`, { kind: 'service', name: 'x', quantity: 1, unit: 'шт', priceKop: 100 });
    const byPhone = (await req('owner', 'GET', '/events?customer=0001122')).json().items;
    expect(byPhone.map((x: { id: string }) => x.id).sort()).toEqual([unpaid.id, paid.id].sort());
    const due = (await req('owner', 'GET', '/events?customer=0001122&hasDue=true')).json().items;
    expect(due.map((x: { id: string }) => x.id)).toEqual([unpaid.id]);
    expect((await req('owner', 'GET', `/events?typeId=${types.program}`)).json().items).toEqual([]);
    expect((await req('owner', 'GET', '/events?status=cancelled&customer=Клава')).json().items).toEqual([]);
    const page = (await req('owner', 'GET', '/events?customer=Клава&limit=1')).json();
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = (await req('owner', 'GET', `/events?customer=Клава&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
    expect(next.items[0].id).not.toBe(page.items[0].id);
    expect((await req('owner', 'GET', '/events?status=wrong')).statusCode).toBe(400);
  });
});

describe('ревизия: плановая себестоимость не уходит без event.money.view', () => {
  it('Администратор: POST, PATCH, remove строки, apply-package и GET /event-packages – без planCostKop; Директор видит', async () => {
    const e = await newEvent();
    const added = await req('admin', 'POST', `/events/${e.id}/lines`, { kind: 'service', name: 'Шаблонная', quantity: 1, unit: 'шт', priceKop: 0, planCostKop: 500 });
    expect(added.statusCode).toBe(201);
    expect(added.json()).not.toHaveProperty('planCostKop');
    const mine = added.json();
    const patched = await req('admin', 'PATCH', `/event-lines/${mine.id}`, { rowVersion: mine.rowVersion, comment: 'к столу' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).not.toHaveProperty('planCostKop');
    const removed = await req('admin', 'POST', `/event-lines/${mine.id}/remove`, { rowVersion: patched.json().rowVersion, reason: 'не нужно' });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).not.toHaveProperty('planCostKop');

    const pack = await req('owner', 'POST', '/event-packages', { typeId: types.other, name: 'С себестоимостью', lines: [{ kind: 'service', name: 'x', quantity: 1, unit: 'шт', priceKop: 100, planCostKop: 40 }] });
    expect(pack.statusCode).toBe(201);
    const applied = await req('admin', 'POST', `/events/${e.id}/apply-package`, { packageId: pack.json().id });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().items[0].priceKop).toBe(100);
    expect(applied.json().items[0]).not.toHaveProperty('planCostKop');
    const seen = (await req('admin', 'GET', '/event-packages')).json().items.find((x: { id: string }) => x.id === pack.json().id);
    expect(seen.lines[0].priceKop).toBe(100);
    expect(seen.lines[0]).not.toHaveProperty('planCostKop');

    const dirLine = await req('director', 'POST', `/events/${e.id}/lines`, { kind: 'service', name: 'Д', quantity: 1, unit: 'шт', priceKop: 10, planCostKop: 7 });
    expect(dirLine.json().planCostKop).toBe(7);
    const dirPack = (await req('director', 'GET', '/event-packages')).json().items.find((x: { id: string }) => x.id === pack.json().id);
    expect(dirPack.lines[0].planCostKop).toBe(40);
  });
});

describe('S3-55: команды', () => {
  it('повтор ключа: та же заявка; другой запрос с тем же ключом отвергнут', async () => {
    const key = randomUUID();
    const body = { typeId: types.other, branchId: ids.b1, customer: { name: 'А', phone: '+79131234567' } };
    const a = await req('owner', 'POST', '/events', body, key);
    const b = await req('owner', 'POST', '/events', body, key);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers['idempotent-replay']).toBe('true');
    const c = await req('owner', 'POST', '/events', { ...body, title: 'другое' }, key);
    expect(c.statusCode).toBe(409);
  });
  it('отмена: needsDecision со связанными бронями и деньгами; бронь не отменена; строки занятости сняты; деньги на месте', async () => {
    const e = await newEvent({ typeId: types.group_visit });
    const booking = await req('owner', 'POST', `/branches/${ids.b1}/bookings`, { resourceId: ids.vr, start: '2026-11-16T05:00:00Z', end: '2026-11-16T05:30:00Z', client: { clientId: ids.client } });
    expect(booking.statusCode).toBe(201);
    const bookingId = booking.json().id;
    expect((await req('owner', 'POST', `/events/${e.id}/bookings`, { bookingId })).statusCode).toBe(200);
    const res = await req('owner', 'POST', `/events/${e.id}/resources`, { resourceId: ids.whole, start: '2026-11-17T05:00:00Z', end: '2026-11-17T06:00:00Z' });
    expect(res.statusCode).toBe(201);
    const inc = await req('owner', 'POST', `/events/${e.id}/income`, { method: 'cash', amountKop: 5000, occurredAt: AT });
    expect(inc.statusCode).toBe(201);
    const exp = await req('owner', 'POST', `/events/${e.id}/expense`, { method: 'cash', amountKop: 1000, categoryId: ids.category, subcategoryId: ids.subcategory, occurredAt: AT, comment: 'шарики' });
    expect(exp.statusCode).toBe(201);
    const version = (await req('owner', 'GET', `/events/${e.id}`)).json().rowVersion;
    const r = await req('owner', 'POST', `/events/${e.id}/status`, { rowVersion: version, to: 'cancelled', reason: 'передумали' });
    expect(r.statusCode).toBe(200);
    expect(r.json().needsDecision).toEqual({ bookingIds: [bookingId], giftIds: [], dueKop: -5000, receivedKop: 5000 });
    expect((await one('SELECT status FROM app.bookings WHERE id = $1', [bookingId])).status).toBe('confirmed');
    const occ = await db.client.query(`SELECT 1 FROM app.occupancy WHERE active AND source_type = 'event' AND source_id = $1`, [res.json().eventResourceId]);
    expect(occ.rowCount).toBe(0);
    const money = (await req('owner', 'GET', `/events/${e.id}/money`)).json();
    expect(money.summary).toMatchObject({ receivedKop: 5000, factCostKop: 1000 });
    expect(money.operations).toHaveLength(2);
  });
  it('журнал K17 отдаёт связь с мероприятием: и расход из карточки, и привязанный вручную', async () => {
    const e = await newEvent();
    expect((await req('owner', 'POST', `/events/${e.id}/income`, { method: 'transfer', amountKop: 5000, occurredAt: AT })).statusCode).toBe(201);
    const manual = await req('owner', 'POST', `/branches/${ids.b1}/finance/expense`, { method: 'transfer', amountKop: 700, categoryId: ids.category, subcategoryId: ids.subcategory, occurredAt: AT, comment: 'торт вручную' });
    expect(manual.statusCode).toBe(201);
    expect((await req('owner', 'POST', `/events/${e.id}/expense/link`, { operationId: manual.json().id })).statusCode).toBe(201);
    const own = await req('owner', 'POST', `/events/${e.id}/expense`, { method: 'transfer', amountKop: 300, categoryId: ids.category, subcategoryId: ids.subcategory, occurredAt: AT, comment: 'свечи' });
    expect(own.statusCode).toBe(201);
    const items = (await req('owner', 'GET', `/branches/${ids.b1}/finance/operations?from=2026-11-14&limit=200`)).json().items as Array<{ id: string; ref: unknown; link: unknown }>;
    const byId = new Map(items.map((x) => [x.id, x]));
    expect(byId.get(manual.json().id)).toMatchObject({ ref: null, link: { type: 'event', id: e.id, role: 'expense' } });
    expect(byId.get(own.json().id)).toMatchObject({ ref: { type: 'event', id: e.id }, link: { type: 'event', id: e.id, role: 'expense' } });
    const ofEvent = items.filter((x) => (x.link as { id: string } | null)?.id === e.id).map((x) => (x.link as { role: string }).role);
    expect(ofEvent.sort()).toEqual(['expense', 'expense', 'income']);
  });
  it('связь с бронью: чужой филиал – 404; второе мероприятие – отказ; снятие связи и след в аудите', async () => {
    const e = await newEvent();
    const other = await newEvent();
    const b = await req('owner', 'POST', `/branches/${ids.b1}/bookings`, { resourceId: ids.vr, start: '2026-11-18T05:00:00Z', end: '2026-11-18T05:30:00Z', client: { clientId: ids.client } });
    const bookingId = b.json().id;
    expect((await req('owner', 'POST', `/events/${e.id}/bookings`, { bookingId: randomUUID() })).statusCode).toBe(404);
    await req('owner', 'POST', `/events/${e.id}/bookings`, { bookingId });
    expect((await req('owner', 'POST', `/events/${other.id}/bookings`, { bookingId })).statusCode).toBe(400);
    expect((await req('owner', 'POST', `/events/${e.id}/bookings/${bookingId}/unlink`, {})).statusCode).toBe(200);
    expect((await req('owner', 'POST', `/events/${other.id}/bookings`, { bookingId })).statusCode).toBe(200);
    const log = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'event.booking_unlinked' AND object_id = $1`, [e.id]);
    expect(log.rowCount).toBe(1);
  });
  it('чек-лист: чтение, правка пункта своего мероприятия; чужой пункт – 404', async () => {
    const e = await newEvent();
    const other = await newEvent();
    const items = (await req('admin', 'GET', `/events/${e.id}/checklist`)).json().items;
    expect(items).toHaveLength(10);
    const pay = items.find((i: { code: string }) => i.code === 'payment');
    expect(pay.dueKop).toBe(0);
    const u = await req('admin', 'PATCH', `/events/${e.id}/checklist`, { itemId: pay.id, status: 'done' });
    expect(u.json().status).toBe('done');
    expect((await req('admin', 'PATCH', `/events/${other.id}/checklist`, { itemId: pay.id, status: 'todo' })).statusCode).toBe(404);
  });
  it('перенос и снятие: занятая комната через API; блокировка показывает мероприятие, а не строку ресурса', async () => {
    const e = await newEvent({ typeId: types.group_visit });
    const r = await req('owner', 'POST', `/events/${e.id}/resources`, { resourceId: ids.whole, start: '2026-11-19T05:00:00Z', end: '2026-11-19T06:00:00Z' });
    const rid = r.json().eventResourceId;
    const card = (await req('owner', 'GET', `/events/${e.id}`)).json();
    expect(card.resources[0].id).toBe(rid);
    expect(card.plannedStart).toBe('2026-11-19T05:00:00.000Z');
    const reason = await one(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`);
    const block = await req('owner', 'POST', `/branches/${ids.b1}/blocks`, { target: { type: 'unit', ids: [ids.u1] }, start: '2026-11-19T04:00:00Z', end: '2026-11-19T07:00:00Z', reasonId: reason.id });
    expect(block.statusCode).toBe(201);
    expect(block.json().affectedEventIds).toEqual([e.id]);
    const m = await req('owner', 'POST', `/events/${e.id}/move`, { rowVersion: card.rowVersion, plannedStart: '2026-11-20T05:00:00Z', plannedEnd: '2026-11-20T06:00:00Z', reason: 'блокировка', resources: [{ eventResourceId: rid, resourceId: ids.whole, start: '2026-11-20T05:00:00Z', end: '2026-11-20T06:00:00Z' }] });
    expect(m.statusCode).toBe(200);
    const rel = await req('owner', 'POST', `/events/${e.id}/resources/${rid}/release`, { reason: 'не нужно' });
    expect(rel.json()).toEqual({ released: true });
  });
  it('ревизия: предложение блокировки K19 показывает номер, статус и время мероприятия; сводку подключает сервер', async () => {
    const e = await newEvent({ typeId: types.group_visit });
    await req('owner', 'POST', `/events/${e.id}/resources`, { resourceId: ids.whole, start: '2026-11-23T05:00:00Z', end: '2026-11-23T06:00:00Z' });
    const proposal = await buildProposal(pool, { branchId: ids.b1!, target: { type: 'unit', ids: [ids.u1!] }, period: interval(new Date('2026-11-23T04:00:00Z'), new Date('2026-11-23T07:00:00Z')) }, clock);
    expect(proposal.affectedEvents).toEqual([{ eventId: e.id, number: e.number, status: 'new_request', start: '2026-11-23T05:00:00.000Z', end: '2026-11-23T06:00:00.000Z' }]);
    await req('owner', 'POST', `/events/${e.id}/status`, { rowVersion: (await req('owner', 'GET', `/events/${e.id}`)).json().rowVersion, to: 'cancelled', reason: 'тест' });
  });
  it('справочники №370: чтение всем в зоне, правка – Владелец', async () => {
    const created = await req('owner', 'POST', '/event-packages', { typeId: types.other, name: 'Стандарт', lines: [{ kind: 'service', name: 'x', quantity: 1, unit: 'шт', priceKop: 100 }] });
    expect(created.statusCode).toBe(201);
    expect((await req('admin', 'POST', '/event-packages', { typeId: types.other, name: 'Н', lines: [] })).statusCode).toBe(403);
    expect((await req('admin', 'GET', '/event-packages')).json().items.map((p: { name: string }) => p.name)).toContain('Стандарт');
    expect((await req('admin', 'GET', '/event-types')).json().items).toHaveLength(5);
    const applied = await req('admin', 'POST', `/events/${(await newEvent()).id}/apply-package`, { packageId: created.json().id });
    expect(applied.json().items).toHaveLength(1);
  });
});
