// S2-41: API ЛК баллов (K15 §11) через buildServer и настоящий вход по коду: только своя карточка, история без
// внутренних комментариев (07 §12.2, 03 §8.3), «не возвращено» строкой, резерв чужого удержания → RESERVE_HOLD_INVALID,
// каталог; ЛК доступен при −50 (07 §9.3).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { createBatch, debitBatches, openAccount, postPoints, returnSpend, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { adjust } from '../../apps/api/src/modules/loyalty/adjust.ts';
import { createGoods } from '../../apps/api/src/modules/loyalty/goods.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const BASE = '/api/public/v1';
const DAY = 86_400_000;
let now = new Date('2026-11-14T05:00:00Z');
const clock: Clock = { now: () => now };
const sms = createDevSmsSender('dev');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function inTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
async function login(who: string, phone: string): Promise<void> {
  const req = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/request`, headers: { 'idempotency-key': randomUUID() }, payload: { phone, purpose: 'login' } });
  expect(req.statusCode).toBe(202);
  const code = /\d{6}/.exec(sms.sent.at(-1)!.text)![0];
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/verify`, payload: { challengeId: req.json().challengeId, code, consents: { pdProcessing: true } } });
  expect(res.statusCode).toBe(200);
  cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
  ids[who] = (await one(`SELECT id FROM app.clients WHERE phone_e164 = $1`, [phone])).id;
}
const call = (who: string, method: 'GET' | 'POST' | 'DELETE', url: string, key?: string) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { cookie: cookies[who]!, ...(key ? { 'idempotency-key': key } : {}) }, ...(method === 'POST' ? { payload: {} } : {}) });
const owner: AccessContext = { actor: { kind: 'staff', staffId: SYS, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: now };
const staffMeta = { actor: owner.actor, source: 'crm' as const, requestId: 'test' };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'Клуб на Ленина', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:30', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`UPDATE app.dict_resource_types SET step_minutes = 5 WHERE code = 'pc'`); // удержание на 5 минут = 5 баллов
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 5, 100, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC', 'PC') RETURNING id`, [ids.b1]);
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, u.id]);
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients: { pool, auth: clientAuthConfig('c'.repeat(40)), sms, clock } });
  await login('a', '+79135000001');
  await login('b', '+79135000002');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('GET /me/loyalty и история', () => {
  it('без входа – 401; своя карточка; в истории нет внутреннего комментария, «не возвращено» – строкой', async () => {
    expect((await app.inject({ method: 'GET', url: `${BASE}/me/loyalty` })).statusCode).toBe(401);
    const c = ids.a!;
    // 3 балла со сроком 1 день и 5 бессрочных; списание 6 баллов (3 + 3); возврат после истечения – 3 «не возвращено»
    const spend = await inTx(async (tx) => {
      await openAccount(tx, c, now);
      for (const [amount, exp] of [[300, new Date(now.getTime() + DAY)], [500, null]] as const) {
        const p = await postPoints(tx, c, { amount, type: 'loyalty.accrual', branchId: ids.b1!, occurredAt: now }, randomUUID(), SYSTEM_AUTHOR);
        await createBatch(tx, { clientId: c, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, source: 'visit', branchId: ids.b1!, expiresAt: exp, accruedAt: now });
      }
      const s = await postPoints(tx, c, { amount: -600, type: 'loyalty.spend_time', branchId: ids.b1!, occurredAt: now }, randomUUID(), SYSTEM_AUTHOR);
      await debitBatches(tx, { clientId: c, entryId: s.entryId, amount: 600, balanceBefore: s.balanceBefore, kind: 'spend_time' });
      return s.entryId;
    });
    now = new Date(now.getTime() + 2 * DAY);
    await inTx((tx) => returnSpend(tx, { originalEntryId: spend, reason: 'возврат платежа', idempotencyKey: randomUUID(), author: SYSTEM_AUTHOR, occurredAt: now }));
    await inTx((tx) => adjust(tx, owner, { clientId: c, deltaCenti: 100, reason: 'ВНУТРЕННЕЕ: клиент ругался на админа' }, staffMeta, clock));
    const me = await call('a', 'GET', '/me/loyalty');
    expect(me.json()).toMatchObject({ balanceCenti: 600, availableCenti: 600, preBookingBlocked: false });
    const h = await call('a', 'GET', '/me/loyalty/history');
    expect(h.statusCode).toBe(200);
    expect(h.body).not.toContain('ВНУТРЕННЕЕ');
    expect(h.body).not.toContain('возврат платежа');
    const items = h.json().items as Array<{ type: string; deltaCenti: number; branchName: string | null }>;
    expect(items.map((i) => `${i.type}:${i.deltaCenti}`)).toEqual(['manual:100', 'not_returned:0', 'return:300', 'spend_time:-600', 'accrual:500', 'accrual:300']);
    expect(items.find((i) => i.type === 'accrual')?.branchName).toBe('Клуб на Ленина');
    expect((await call('b', 'GET', '/me/loyalty')).json().balanceCenti).toBe(0); // чужой счёт не виден
    const page = await call('a', 'GET', '/me/loyalty/history?limit=2');
    const next = await call('a', 'GET', `/me/loyalty/history?limit=2&cursor=${page.json().nextCursor as string}`);
    expect(page.json().items.map((i: { type: string }) => i.type)).toEqual(['manual', 'not_returned', 'return']); // limit – по записям журнала
    expect(next.json().items[0]).toMatchObject({ type: 'spend_time' });
  });

  it('при −50 ЛК и история доступны, preBookingBlocked = true', async () => {
    await inTx((tx) => adjust(tx, owner, { clientId: ids.b!, deltaCenti: -5000, reason: 'тест' }, staffMeta, clock));
    expect((await call('b', 'GET', '/me/loyalty')).json()).toMatchObject({ balanceCenti: -5000, preBookingBlocked: true });
    expect((await call('b', 'GET', '/me/loyalty/history')).statusCode).toBe(200);
  });
});

describe('резерв на удержание', () => {
  it('своё – 201 и повтор с ключом; чужое – RESERVE_HOLD_INVALID; DELETE – снят', async () => {
    const start = new Date(now.getTime() + DAY);
    const h = await runOccupancyCommand(pool, (tx) => createHold(tx, { clientId: ids.a!, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc!, start, end: new Date(start.getTime() + 5 * 60_000) }] }, clock));
    const key = randomUUID();
    const first = await call('a', 'POST', `/holds/${h.id}/points-reserve`, key);
    expect([first.statusCode, first.json()]).toMatchObject([201, { amountCenti: 500, availableCenti: 100 }]);
    const again = await call('a', 'POST', `/holds/${h.id}/points-reserve`, key);
    expect([again.statusCode, again.headers['idempotent-replay']]).toEqual([201, 'true']);
    const foreign = await call('b', 'POST', `/holds/${h.id}/points-reserve`, randomUUID());
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([409, 'RESERVE_HOLD_INVALID']);
    expect((await call('b', 'DELETE', `/holds/${h.id}/points-reserve`)).json()).toEqual({ released: false });
    expect((await call('a', 'DELETE', `/holds/${h.id}/points-reserve`)).json()).toEqual({ released: true });
    expect((await call('a', 'GET', '/me/loyalty')).json()).toMatchObject({ reservedCenti: 0, availableCenti: 600 });
  });
});

describe('GET /goods', () => {
  it('каталог филиала: цены в ₽ и баллах, доступность, без остатков', async () => {
    const g = await inTx((tx) => createGoods(tx, owner, { name: 'Кружка', priceRubKop: 50000, pricePointsCenti: 2000, branches: [{ branchId: ids.b1!, stock: 0 }] }, staffMeta, clock));
    const r = await call('a', 'GET', `/goods?branchId=${ids.b1}`);
    expect(r.json().items).toEqual([{ id: g.id, name: 'Кружка', description: null, imageUrl: null, priceRubKop: 50000, pricePointsCenti: 2000, available: false }]);
  });
});
