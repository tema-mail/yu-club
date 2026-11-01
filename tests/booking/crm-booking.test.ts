// S1-13: CRM-маршруты брони (K11 №2–12) на живом сервере: бронь администратором с клиентом и без профиля
// (проверки не обходятся, Q-09 – пересечение по телефону), Администратор чужого филиала – 404 как у
// несуществующего, календарь филиала (брони + удержания + блокировки по ресурсам) совпадает с availability K5 по
// занятым слотам (18 §5.5), карточка с хронологией, отмена/перенос/приход/неявка с rowVersion, двойной клик.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { CalendarDto, CrmBooking, CrmBookingCard, CrmBookingList } from '../../packages/contracts/src/crm/booking.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const PASSWORD = 'Пароль-брони-администратора-1';
const BASE = '/api/crm/v1';
let t = new Date('2026-11-14T05:00:00Z').getTime(); // 12:00 Новосибирска
const clock: Clock = { now: () => new Date(t) };
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const units: Record<string, string> = {};
const bodies: string[] = [];

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function login(key: string, role: string, branchId?: string): Promise<string> {
  const r = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  if (branchId) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.id, branchId]);
  }
  await signIn(key);
  return r.id;
}
async function signIn(key: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
/** Перевести часы: сессия сотрудника живёт по тем же часам – входим заново. */
async function setTime(iso: string): Promise<void> {
  t = Date.parse(iso);
  for (const k of Object.keys(cookies)) await signIn(k);
}
async function req(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = key;
  const r = await app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
  bodies.push(r.body);
  return r;
}
function valid<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  expect(r.success, JSON.stringify(body)).toBe(true);
  return r.data!;
}
async function unit(branchId: string, roomId: string | null, code: string): Promise<string> {
  return (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [branchId, roomId, code])).id;
}
async function resource(branchId: string, roomId: string | null, type: string, name: string, unitIds: string[]): Promise<string> {
  const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [branchId, roomId, type, name]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, unitIds]);
  return r.id;
}
const slot = (resourceId: string, start: string, minutes = 60) => ({ resourceId, start, end: new Date(Date.parse(start) + minutes * 60_000).toISOString() });
const create = (who: string, body: object, key?: string) => req(who, 'POST', `/branches/${ids.b1}/bookings`, body, key);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    staff: { pool, auth: staffAuthConfig('s'.repeat(40)), clock },
    clients: { pool, auth: clientAuthConfig('k'.repeat(40)), sms: createDevSmsSender('dev', () => {}), clock },
  });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
    await db.client.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
      [ids[code], SYS],
    );
    for (const type of ['pc', 'vr_seat', 'room_whole']) {
      await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, 30, 20000, '2026-01-01', 'active', $3)`, [ids[code], type, SYS]);
    }
  }
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR-комната', true) RETURNING id`, [ids.b1])).id;
  for (const c of ['VR1', 'VR2', 'PS4']) units[c] = await unit(ids.b1!, ids.room, c);
  ids.vr1 = await resource(ids.b1!, ids.room, 'vr_seat', 'VR-место 1', [units.VR1!]);
  ids.vr2 = await resource(ids.b1!, ids.room, 'vr_seat', 'VR-место 2', [units.VR2!]);
  ids.whole = await resource(ids.b1!, ids.room, 'room_whole', 'VR-комната целиком', [units.VR1!, units.VR2!, units.PS4!]);
  ids.pc1 = await resource(ids.b1!, null, 'pc', 'ПК-1', [await unit(ids.b1!, null, 'PC1')]);
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type) VALUES ('+79131112233', 'Анна', 'Смирнова', 'active', 'system') RETURNING id`)).id;
  ids.owner = await login('owner', 'owner');
  ids.admin = await login('admin', 'admin', ids.b1);
  ids.admin2 = await login('admin2', 'admin', ids.b1);
  ids.foreign = await login('foreign', 'admin', ids.b2);
  ids.reason = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' AND code = 'other'`)).id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('бронь администратором (K11 №4)', () => {
  it('с клиентом: 201 CrmBooking, source crm, событие booking.confirmed; двойной клик (тот же ключ) – одна бронь', async () => {
    const key = randomUUID();
    const body = { ...slot(ids.pc1!, '2026-11-15T05:00:00Z'), client: { clientId: ids.client }, internalComment: 'постоянный' };
    const [r1, r2] = [await create('admin', body, key), await create('admin', body, key)];
    expect(r1.statusCode).toBe(201);
    const b = valid(CrmBooking, r1.json());
    expect(b).toMatchObject({ status: 'confirmed', source: 'crm', priceKop: 40000, internalComment: 'постоянный', client: { id: ids.client, name: 'Анна Смирнова', isGuest: false }, allowedActions: ['cancel', 'reschedule', 'arrive'] });
    expect(b.client.phoneMasked).not.toContain('1112233');
    expect(r2.headers['idempotent-replay']).toBe('true');
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.bookings WHERE client_id = $1`, [ids.client])).n).toBe(1);
    const ev = await one<{ payload: { source: string; bookingVersion: number } }>(`SELECT payload FROM app.outbox_events WHERE event_type = 'booking.confirmed' AND aggregate_id = $1`, [b.id]);
    expect(ev.payload).toMatchObject({ source: 'crm', bookingVersion: 1 });
    ids.booking = b.id;
  });

  it('без профиля: гость по телефону; тот же телефон на пересекающееся время – CLIENT_OVERLAP (Q-09); проверки не обходятся', async () => {
    const guest = { phone: '8 (913) 555-44-33', firstName: 'Олег' };
    const r = await create('admin', { ...slot(ids.vr1!, '2026-11-15T06:00:00Z'), client: guest });
    expect(r.statusCode).toBe(201);
    const b = valid(CrmBooking, r.json());
    expect(b.client).toMatchObject({ name: 'Олег', isGuest: true });
    const overlap = await create('admin', { ...slot(ids.pc1!, '2026-11-15T06:30:00Z'), client: { phone: '+79135554433', firstName: 'Олег' } });
    expect([overlap.statusCode, overlap.json().error.code]).toEqual([409, 'CLIENT_OVERLAP']);
    const later = valid(CrmBooking, (await create('admin', { ...slot(ids.pc1!, '2026-11-15T08:00:00Z'), client: { phone: '+79135554433', firstName: 'Олег' } })).json());
    expect(later.client.id).toBe(b.client.id);
    // занято, вне часов, комната поверх места, неверный телефон, нет клиента
    const codes = [];
    for (const body of [
      { ...slot(ids.pc1!, '2026-11-15T05:00:00Z'), client: guest },
      { ...slot(ids.pc1!, '2026-11-15T16:00:00Z'), client: { clientId: ids.client } },
      { ...slot(ids.whole!, '2026-11-15T06:00:00Z'), client: { clientId: ids.client } },
      { ...slot(ids.pc1!, '2026-11-16T05:00:00Z'), client: { phone: '12', firstName: 'X' } },
      { ...slot(ids.pc1!, '2026-11-16T05:00:00Z'), client: { clientId: randomUUID() } },
    ]) codes.push((await create('admin', body)).json().error.code);
    expect(codes).toEqual(['SLOT_TAKEN', 'OUTSIDE_SCHEDULE', 'SLOT_TAKEN', 'VALIDATION_FAILED', 'NOT_FOUND']);
  });

  it('Администратор чужого филиала – 404 как у несуществующего; отказ записан в аудит', async () => {
    const body = { ...slot(ids.pc1!, '2026-11-16T05:00:00Z'), client: { clientId: ids.client } };
    const foreign = await create('foreign', body);
    const missing = await req('foreign', 'POST', `/branches/${randomUUID()}/bookings`, body);
    expect([foreign.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect({ ...foreign.json().error, requestId: '' }).toEqual({ ...missing.json().error, requestId: '' });
    for (const [method, url, payload] of [
      ['GET', `/bookings/${ids.booking}`, undefined],
      ['POST', `/bookings/${ids.booking}/cancel`, { rowVersion: 1, initiator: 'club', reasonId: ids.reason, comment: 'x' }],
      ['POST', `/bookings/${ids.booking}/arrive`, { rowVersion: 1 }],
      ['POST', `/bookings/${ids.booking}/reschedule`, { rowVersion: 1, ...slot(ids.pc1!, '2026-11-16T09:00:00Z'), reason: 'x' }],
      ['GET', `/branches/${ids.b1}/calendar?from=2026-11-15&to=2026-11-15`, undefined],
      ['GET', `/branches/${ids.b1}/bookings`, undefined],
    ] as const) {
      const r = await req('foreign', method, url, payload);
      expect([url, r.statusCode, r.json().error.code]).toEqual([url, 404, 'NOT_FOUND']);
    }
    const denied = await one<{ n: number }>(`SELECT count(*)::int n FROM journal.audit_events WHERE result = 'denied' AND actor_id = $1`, [ids.foreign]);
    expect(denied.n).toBeGreaterThanOrEqual(3);
  });
});

describe('календарь (K11 №2) и список (№3)', () => {
  it('брони, удержания и блокировки по ресурсам; комната целиком – на трёх ресурсах; совпадает с availability K5', async () => {
    await create('admin', { ...slot(ids.whole!, '2026-11-17T05:00:00Z'), client: { clientId: ids.client } });
    const v = `yu_visitor=${randomUUID()}`;
    const hold = await app.inject({ method: 'POST', url: '/api/public/v1/holds', headers: { cookie: v, 'idempotency-key': randomUUID() }, payload: { branchId: ids.b1, items: [slot(ids.vr2!, '2026-11-17T07:00:00Z', 30)] } });
    expect(hold.statusCode).toBe(201);
    const blk = await req('admin', 'POST', `/branches/${ids.b1}/blocks`, { target: { type: 'unit', ids: [units.VR1] }, start: '2026-11-17T08:00:00Z', end: '2026-11-17T09:00:00Z', reasonId: (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`)).id });
    expect(blk.statusCode).toBe(201);
    const cal = valid(CalendarDto, (await req('admin', 'GET', `/branches/${ids.b1}/calendar?from=2026-11-17&to=2026-11-17`)).json());
    const room = cal.items.find((i) => i.kind === 'booking')!;
    expect(room.resourceIds.sort()).toEqual([ids.vr1, ids.vr2, ids.whole].sort());
    expect(room.booking).toMatchObject({ clientName: 'Анна Смирнова', status: 'confirmed', needsDecision: false });
    expect(cal.items.find((i) => i.kind === 'hold')).toMatchObject({ resourceIds: expect.arrayContaining([ids.vr2, ids.whole]), hold: { expiresAt: '2026-11-14T05:15:00.000Z' } });
    expect(cal.items.find((i) => i.kind === 'block')).toMatchObject({ block: { reasonName: 'Ремонт' } });
    expect(cal.openIntervals).toEqual([{ start: '2026-11-17T03:00:00.000Z', end: '2026-11-17T15:00:00.000Z' }]);
    // 18 §5.5: занятые слоты K5 = интервалы календаря по каждому ресурсу
    const av = (await app.inject({ method: 'GET', url: `/api/public/v1/branches/${ids.b1}/availability?date=2026-11-17`, headers: { cookie: `yu_visitor=${randomUUID()}` } })).json();
    for (const r of av.resources as Array<{ resourceId: string; slots: Array<{ start: string; end: string; state: string }> }>) {
      const busy = r.slots.filter((s) => ['booked', 'held', 'blocked'].includes(s.state)).map((s) => s.start);
      const covered = r.slots
        .filter((s) => cal.items.some((i) => i.resourceIds.includes(r.resourceId) && Date.parse(i.start) < Date.parse(s.end) && Date.parse(i.end) > Date.parse(s.start)))
        .map((s) => s.start);
      expect([r.resourceId, covered]).toEqual([r.resourceId, busy]);
    }
    const tooLong = await req('admin', 'GET', `/branches/${ids.b1}/calendar?from=2026-11-15&to=2026-11-22`);
    expect([tooLong.statusCode, tooLong.json().error.code]).toEqual([422, 'RANGE_TOO_LONG']);
    expect((await req('admin', 'GET', `/branches/${ids.b1}/calendar?from=2026-11-15&to=2026-11-21`)).statusCode).toBe(200);
  });

  it('список: порядок (start, number), курсор, needsDecision – прошедшие confirmed без отметки (R-08)', async () => {
    await setTime('2026-11-15T07:30:00Z');
    const page1 = valid(CrmBookingList, (await req('admin', 'GET', `/branches/${ids.b1}/bookings?date=2026-11-15&limit=2`)).json());
    const page2 = valid(CrmBookingList, (await req('admin', 'GET', `/branches/${ids.b1}/bookings?date=2026-11-15&limit=2&cursor=${page1.nextCursor}`)).json());
    expect([...page1.items, ...page2.items].map((b) => b.start)).toEqual(['2026-11-15T05:00:00.000Z', '2026-11-15T06:00:00.000Z', '2026-11-15T08:00:00.000Z']);
    const nd = valid(CrmBookingList, (await req('admin', 'GET', `/branches/${ids.b1}/bookings?needsDecision=true`)).json());
    expect(nd.items.map((b) => b.id)).toEqual([ids.booking, expect.any(String)]);
    expect(nd.items.every((b) => b.needsDecision)).toBe(true);
    await setTime('2026-11-14T05:00:00Z');
  });
});

describe('карточка и команды (K11 №5–12)', () => {
  it('карточка с хронологией; два сотрудника с одним rowVersion – второй VERSION_CONFLICT; двойной клик «Отменить» – одна отмена', async () => {
    const b = valid(CrmBooking, (await create('admin', { ...slot(ids.pc1!, '2026-11-18T05:00:00Z'), client: { clientId: ids.client } })).json());
    const card = valid(CrmBookingCard, (await req('admin', 'GET', `/bookings/${b.id}`)).json());
    expect(card.timeline.map((e) => e.action)).toEqual(['booking.created']);
    expect(card.versions).toHaveLength(1);
    const patched = await req('admin', 'PATCH', `/bookings/${b.id}`, { rowVersion: 1, internalComment: 'VIP' });
    expect(valid(CrmBooking, patched.json())).toMatchObject({ internalComment: 'VIP', rowVersion: 2 });
    const stale = await req('admin2', 'PATCH', `/bookings/${b.id}`, { rowVersion: 1, internalComment: 'другое' });
    expect([stale.statusCode, stale.json().error.code, stale.json().error.details.current]).toEqual([409, 'VERSION_CONFLICT', 2]);
    const key = randomUUID();
    const cancel = { rowVersion: 2, initiator: 'club', reasonId: ids.reason, comment: 'Сбой' };
    const [c1, c2] = await Promise.all([req('admin', 'POST', `/bookings/${b.id}/cancel`, cancel, key), req('admin', 'POST', `/bookings/${b.id}/cancel`, cancel, key)]);
    expect([c1.statusCode, c2.statusCode].sort()).toEqual([200, 200].sort());
    expect(valid(CrmBooking, c1.json())).toMatchObject({ status: 'cancelled_by_club', cancel: { by: 'сотрудник', reasonName: 'Другое', comment: 'Сбой' }, allowedActions: [] });
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'booking.cancelled' AND object_id = $1`, [b.id])).n).toBe(1);
    const noComment = await req('admin', 'POST', `/bookings/${ids.booking}/cancel`, { rowVersion: 1, initiator: 'club', reasonId: ids.reason, comment: '' });
    expect([noComment.statusCode, noComment.json().error.code]).toEqual([422, 'COMMENT_REQUIRED']);
  });

  it('перенос → версия 2; приход → arrived; завершение; неявка – после начала', async () => {
    const b = valid(CrmBooking, (await create('admin', { ...slot(ids.pc1!, '2026-11-19T05:00:00Z'), client: { clientId: ids.client } })).json());
    const moved = valid(CrmBooking, (await req('admin', 'POST', `/bookings/${b.id}/reschedule`, { rowVersion: 1, ...slot(ids.vr2!, '2026-11-19T06:00:00Z', 30), reason: 'Попросил' })).json());
    expect(moved).toMatchObject({ currentVersion: 2, resourceId: ids.vr2, priceKop: 20000, rowVersion: 2 });
    expect(moved.versions.map((v) => [v.version, v.reason])).toEqual([[1, null], [2, 'Попросил']]);
    const arrived = valid(CrmBooking, (await req('admin', 'POST', `/bookings/${b.id}/arrive`, { rowVersion: 2 })).json());
    expect(arrived).toMatchObject({ status: 'arrived', allowedActions: ['complete'], visit: { arrivedAt: '2026-11-14T05:00:00.000Z', completedAt: null } });
    expect((await req('admin', 'POST', `/bookings/${b.id}/arrive`, { rowVersion: 3 })).json().error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(valid(CrmBooking, (await req('admin', 'POST', `/bookings/${b.id}/complete`, { rowVersion: 3 })).json()).status).toBe('completed');
    const ns = await req('admin', 'POST', `/bookings/${ids.booking}/no-show`, { rowVersion: 1 });
    expect(ns.json().error).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', details: { reason: 'not_started' } });
    await setTime('2026-11-15T05:20:00Z');
    expect(valid(CrmBooking, (await req('admin', 'POST', `/bookings/${ids.booking}/no-show`, { rowVersion: 1 })).json()).status).toBe('no_show');
    const revert = await req('admin', 'POST', `/bookings/${ids.booking}/revert-visit`, { rowVersion: 2, reason: 'ошибка' });
    expect([revert.statusCode, revert.json().error.code]).toEqual([403, 'FORBIDDEN']);
    expect(valid(CrmBooking, (await req('owner', 'POST', `/bookings/${ids.booking}/revert-visit`, { rowVersion: 2, reason: 'ошибка' })).json()).status).toBe('confirmed');
    await setTime('2026-11-14T05:00:00Z');
  });

  it('в ответах CRM нет полного телефона клиента (03 §14)', () => {
    const all = bodies.join('\n');
    for (const phone of ['+79131112233', '79131112233', '+79135554433']) expect(all).not.toContain(phone);
  });
});
