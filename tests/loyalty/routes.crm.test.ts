// S2-40: API CRM баллов №24–28 (K15 §11) через buildServer: права (Администратор не корректирует), IDOR
// (клиент и филиал чужой зоны – 404, как несуществующие), Idempotency-Key у корректировки и выдачи.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-для-баллов-1';
const SYS = '00000000-0000-0000-0000-000000000001';
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function addStaff(key: string, role: string, branch?: string): Promise<void> {
  const r = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  if (branch) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.id, branch]);
  const res = await app.inject({ method: 'POST', url: '/api/crm/v1/auth/login', payload: { email: `${key}@yu.test`, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
const req = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url: `/api/crm/v1${url}`, headers: { cookie: cookies[who]!, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
/** Клиент с бронью в филиале – так он попадает в зону сотрудников филиала (K1 через брони). */
async function clientIn(branch: 'b1' | 'b2'): Promise<string> {
  const c = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).id;
  const start = new Date('2026-11-16T05:00:00Z');
  const h = await runOccupancyCommand(pool, (tx) => createHold(tx, { clientId: c, visitorId: null }, { branchId: ids[branch]!, items: [{ resourceId: ids[`${branch}pc`]!, start, end: new Date(start.getTime() + 3_600_000) }] }, clock));
  await runOccupancyCommand(pool, (tx) => confirmHold(tx, c, h.id, clock));
  return c;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const b of ['b1', 'b2']) {
    ids[b] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, b])).id;
    await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:30', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids[b], SYS]);
    await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 100, '2026-01-01', 'active', $2)`, [ids[b], SYS]);
    const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC', 'PC') RETURNING id`, [ids[b]]);
    ids[`${b}pc`] = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [ids[b]])).id;
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids[`${b}pc`], u.id]);
  }
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock } });
  await addStaff('owner', 'owner');
  await addStaff('director', 'director', ids.b1);
  await addStaff('admin', 'admin', ids.b1);
  await addStaff('admin2', 'admin', ids.b2);
  ids.a = await clientIn('b1');
  ids.b = await clientIn('b2');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('№24 бонусный счёт клиента', () => {
  it('Администратор своей зоны – 200; клиент чужой зоны – 404; Владелец видит всех', async () => {
    const r = await req('admin', 'GET', `/clients/${ids.a}/loyalty`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ balanceCenti: 0, availableCenti: 0, preBookingBlocked: false, accrualBasis: 'planned', history: [], issues: [], blockedReason: null });
    expect((await req('admin', 'GET', `/clients/${ids.b}/loyalty`)).statusCode).toBe(404);
    expect((await req('admin', 'GET', `/clients/${randomUUID()}/loyalty`)).statusCode).toBe(404);
    expect((await req('owner', 'GET', `/clients/${ids.b}/loyalty`)).statusCode).toBe(200);
  });
});

describe('№25 корректировка', () => {
  it('Администратор – 403; без ключа – 400; Директор – 201, повтор с ключом – тот же ответ; чужая зона – 404', async () => {
    const body = { deltaCenti: 1500, reason: 'компенсация за сбой ПК' };
    const denied = await req('admin', 'POST', `/clients/${ids.a}/loyalty/adjust`, body, randomUUID());
    expect(denied.statusCode).toBe(403);
    expect((await req('director', 'POST', `/clients/${ids.a}/loyalty/adjust`, body)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const first = await req('director', 'POST', `/clients/${ids.a}/loyalty/adjust`, body, key);
    expect(first.statusCode).toBe(201);
    const again = await req('director', 'POST', `/clients/${ids.a}/loyalty/adjust`, body, key);
    expect([again.statusCode, again.headers['idempotent-replay'], again.json()]).toEqual([201, 'true', first.json()]);
    expect((await req('director', 'POST', `/clients/${ids.b}/loyalty/adjust`, body, randomUUID())).statusCode).toBe(404);
    const card = (await req('admin', 'GET', `/clients/${ids.a}/loyalty`)).json();
    expect(card.balanceCenti).toBe(1500);
    expect(card.history[0]).toMatchObject({ type: 'loyalty.manual', deltaCenti: 1500, comment: 'компенсация за сбой ПК' });
  });

  it('без причины – COMMENT_REQUIRED; ниже −50 Директором – LIMIT_OVERRIDE_NOT_ALLOWED', async () => {
    expect((await req('director', 'POST', `/clients/${ids.a}/loyalty/adjust`, { deltaCenti: 100, reason: '' }, randomUUID())).json().error.code).toBe('COMMENT_REQUIRED');
    expect((await req('director', 'POST', `/clients/${ids.a}/loyalty/adjust`, { deltaCenti: -9000, reason: 'долг', belowLimit: true }, randomUUID())).json().error.code).toBe('LIMIT_OVERRIDE_NOT_ALLOWED');
  });
});

describe('объединённая карточка (K9 «Слияние», D5-09)', () => {
  it('корректировка и выдача товара на merged – 409 CLIENT_MERGED (баллы живут у основной); счёт читается', async () => {
    const m = (await one(`INSERT INTO app.clients (status, merged_into_id, created_by_type) VALUES ('merged', $1, 'system') RETURNING id`, [ids.a])).id;
    const adj = await req('owner', 'POST', `/clients/${m}/loyalty/adjust`, { deltaCenti: 100, reason: 'тест' }, randomUUID());
    expect(adj.statusCode).toBe(409);
    expect(adj.json().error).toMatchObject({ code: 'CLIENT_MERGED', details: { clientId: m, mergedIntoId: ids.a } });
    const iss = await req('owner', 'POST', `/clients/${m}/goods-orders`, { goodsId: randomUUID(), branchId: ids.b1 }, randomUUID());
    expect(iss.statusCode).toBe(409);
    expect((await req('owner', 'GET', `/clients/${m}/loyalty`)).statusCode).toBe(200);
  });
});

describe('№26–28 товары', () => {
  it('каталог: Директор создаёт, Администратор – 403, чужой филиал – 404; выдача и возврат с IDOR', async () => {
    const goods = { name: 'Кружка клуба', priceRubKop: 50000, pricePointsCenti: 1000, branches: [{ branchId: ids.b1, stock: 3 }] };
    expect((await req('admin', 'POST', '/goods', goods)).statusCode).toBe(403);
    const created = await req('director', 'POST', '/goods', goods);
    expect(created.statusCode).toBe(201);
    const g = created.json();
    expect((await req('admin', 'GET', `/branches/${ids.b1}/goods`)).json().items).toMatchObject([{ id: g.id, available: true, stock: 3 }]);
    expect((await req('admin2', 'GET', `/branches/${ids.b1}/goods`)).statusCode).toBe(404);
    expect((await req('admin2', 'PATCH', `/goods/${g.id}`, { rowVersion: g.rowVersion, name: 'чужая' })).statusCode).toBe(404);

    const order = { goodsId: g.id, branchId: ids.b1 };
    expect((await req('admin2', 'POST', `/clients/${ids.a}/goods-orders`, order, randomUUID())).statusCode).toBe(404);
    const issued = await req('admin', 'POST', `/clients/${ids.a}/goods-orders`, order, randomUUID());
    expect(issued.statusCode).toBe(201);
    const { orderId } = issued.json();
    expect((await req('admin2', 'POST', `/goods-orders/${orderId}/return`, { reason: 'нет' })).statusCode).toBe(404);
    expect((await req('admin', 'POST', `/goods-orders/${orderId}/return`, { reason: '' })).json().error.code).toBe('COMMENT_REQUIRED');
    const ret = await req('admin', 'POST', `/goods-orders/${orderId}/return`, { reason: 'товар не выдан' });
    expect([ret.statusCode, ret.json()]).toEqual([201, { returnedCenti: 1000, notReturnedCenti: 0 }]);
    const card = (await req('admin', 'GET', `/clients/${ids.a}/loyalty`)).json();
    expect(card.goodsOrders[0]).toMatchObject({ id: orderId, goodsName: 'Кружка клуба', priceCenti: 1000, status: 'returned', returnReason: 'товар не выдан' });
    expect(card.batches.find((b: { source: string }) => b.source === 'manual')).toMatchObject({ amountCenti: 1500, remainingCenti: 1500, expiresAt: null, status: 'active' });
    const archived = await req('director', 'PATCH', `/goods/${g.id}`, { rowVersion: g.rowVersion, status: 'archived' });
    expect(archived.json()).toMatchObject({ status: 'archived' });
  });
});
