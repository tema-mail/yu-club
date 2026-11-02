// S2-39: миграция 0207 и товары за баллы (K15 §6, №26–28; 07 §7): каталог, выдача целиком, остаток под блокировкой,
// возврат невыданного в исходные партии с причиной.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { createBatch, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { createGoods, issueGoods, listBranchGoods, returnGoods, updateGoods, type GoodsInput } from '../../apps/api/src/modules/loyalty/goods.ts';
import { lockAccounts } from '../../apps/api/src/core/ledger.ts';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let now = new Date('2026-11-14T05:00:00Z');
const clock: Clock = { now: () => now };
const DAY = 86_400_000;
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};

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
const ctxOf = (role: 'owner' | 'director' | 'admin'): AccessContext => ({ actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set([ids.b1!]), at: now });
const metaOf = (ctx: AccessContext): AuditRequestMeta => ({ actor: ctx.actor, source: 'crm', requestId: randomUUID() });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (err: { code?: string; details?: { reason?: string } }) => [err.code, err.details?.reason].filter(Boolean).join(':'));
async function clientWith(centi: number, expiresAt: Date | null = null): Promise<string> {
  const c = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).rows[0]!.id;
  await inTx(async (tx) => {
    await openAccount(tx, c, now);
    const p = await postPoints(tx, c, { amount: centi, type: 'loyalty.accrual', branchId: null, occurredAt: now }, randomUUID(), SYSTEM_AUTHOR);
    await createBatch(tx, { clientId: c, entryId: p.entryId, amount: centi, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt, accruedAt: now });
  });
  return c;
}
const goods = (input: Partial<GoodsInput> = {}) =>
  inTx((tx) => createGoods(tx, ctxOf('director'), { name: 'Энергетик', pricePointsCenti: 3000, priceRubKop: 15000, branches: [{ branchId: ids.b1!, stock: null }], ...input }, metaOf(ctxOf('director')), clock));
const issue = (clientId: string, goodsId: string, key = randomUUID(), ctx = ctxOf('admin')) => inTx((tx) => issueGoods(tx, ctx, { clientId, goodsId, branchId: ids.b1!, idempotencyKey: key }, metaOf(ctx), clock));
const bal = async (c: string) => (await getBalance(pool, c, now)).balanceCenti;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const city = (await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`)).rows[0]!;
  ids.b1 = (await db.client.query<{ id: string }>(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

it('миграция 0207: вниз и снова вверх', async () => {
  const t = await createTestDatabase({ migrate: true });
  try {
    // откат до 0207 включительно – вместе с более поздними миграциями (раннер откатывает с конца)
    const later = (await t.client.query<{ version: string }>(`SELECT version FROM public.schema_migrations WHERE version >= '0207' ORDER BY version`)).rows.map((r) => r.version);
    expect((await migrateDown(t.client, later.length)).at(-1)).toBe('0207');
    expect((await t.client.query(`SELECT to_regclass('app.loyalty_goods') AS r`)).rows[0].r).toBeNull();
    expect(await migrateUp(t.client)).toEqual(later);
  } finally {
    await t.drop();
  }
});

describe('каталог', () => {
  it('Директор создаёт и архивирует; Администратор – FORBIDDEN; цены в ₽ и баллах раздельно', async () => {
    expect(await codeOf(inTx((tx) => createGoods(tx, ctxOf('admin'), { name: 'Чипсы', pricePointsCenti: 1000, branches: [{ branchId: ids.b1! }] }, metaOf(ctxOf('admin')), clock)))).toBe('FORBIDDEN');
    const g = await goods({ name: 'Наушники' });
    expect(g).toMatchObject({ priceRubKop: 15000, pricePointsCenti: 3000, status: 'active' });
    expect((await listBranchGoods(pool, ids.b1!)).find((x) => x.id === g.id)).toMatchObject({ available: true });
    const archived = await inTx((tx) => updateGoods(tx, ctxOf('director'), g.id, { rowVersion: g.rowVersion, status: 'archived' }, metaOf(ctxOf('director')), clock));
    expect(archived.status).toBe('archived');
    expect((await listBranchGoods(pool, ids.b1!)).some((x) => x.id === g.id)).toBe(false);
    const c = await clientWith(10_000);
    expect(await codeOf(issue(c, g.id))).toBe('GOODS_UNAVAILABLE:archived');
    expect(await codeOf(inTx((tx) => updateGoods(tx, ctxOf('director'), g.id, { rowVersion: g.rowVersion, name: 'x' }, metaOf(ctxOf('director')), clock)))).toBe('VERSION_CONFLICT');
  });
});

describe('выдача целиком (Q-47)', () => {
  it('списание цены, остаток −1; остаток 0 – GOODS_UNAVAILABLE; повтор с ключом – тот же заказ', async () => {
    const g = await goods({ branches: [{ branchId: ids.b1!, stock: 1 }] });
    const c = await clientWith(10_000);
    const key = randomUUID();
    const r = await issue(c, g.id, key);
    expect(await issue(c, g.id, key)).toEqual(r);
    expect(await bal(c)).toBe(7000);
    expect((await listBranchGoods(pool, ids.b1!)).find((x) => x.id === g.id)).toMatchObject({ stock: 0, available: false });
    expect(await codeOf(issue(c, g.id))).toBe('GOODS_UNAVAILABLE:out_of_stock');
  });

  it('остаток 1 и две параллельные выдачи разным клиентам → одна выдача', async () => {
    const g = await goods({ branches: [{ branchId: ids.b1!, stock: 1 }] });
    const [a, b] = [await clientWith(10_000), await clientWith(10_000)];
    const res = await Promise.all([codeOf(issue(a, g.id)), codeOf(issue(b, g.id))]);
    expect(res.sort()).toEqual(['GOODS_UNAVAILABLE:out_of_stock', 'ok']);
  });

  it('баллов меньше цены – POINTS_INSUFFICIENT, частичной выдачи нет', async () => {
    const g = await goods();
    const c = await clientWith(2000);
    await expect(issue(c, g.id)).rejects.toMatchObject({ code: 'POINTS_INSUFFICIENT', details: { availableCenti: 2000, requiredCenti: 3000 } });
    expect(await bal(c)).toBe(2000);
  });
});

describe('возврат невыданного (07 §7.2)', () => {
  it('без причины – COMMENT_REQUIRED; с причиной – баллы в партию, остаток +1; повторно – ALREADY_REVERSED', async () => {
    const g = await goods({ branches: [{ branchId: ids.b1!, stock: 2 }] });
    const c = await clientWith(10_000);
    const { orderId } = await issue(c, g.id);
    const admin = ctxOf('admin');
    expect(await codeOf(inTx((tx) => returnGoods(tx, admin, { orderId, reason: '' }, metaOf(admin), clock)))).toBe('COMMENT_REQUIRED');
    expect(await inTx((tx) => returnGoods(tx, admin, { orderId, reason: 'товара не оказалось' }, metaOf(admin), clock))).toEqual({ returnedCenti: 3000, notReturnedCenti: 0 });
    expect(await bal(c)).toBe(10_000);
    expect((await listBranchGoods(pool, ids.b1!)).find((x) => x.id === g.id)?.stock).toBe(2);
    expect(await codeOf(inTx((tx) => returnGoods(tx, admin, { orderId, reason: 'ещё' }, metaOf(admin), clock)))).toBe('ALREADY_REVERSED');
  });

  it('партия истекла к возврату – «не возвращено»', async () => {
    const g = await goods();
    const c = await clientWith(5000, new Date(now.getTime() + DAY));
    const { orderId } = await issue(c, g.id);
    now = new Date(now.getTime() + 2 * DAY);
    const admin = ctxOf('admin');
    expect(await inTx((tx) => returnGoods(tx, admin, { orderId, reason: 'отмена' }, metaOf(admin), clock))).toEqual({ returnedCenti: 0, notReturnedCenti: 3000 });
    expect(await bal(c)).toBe(0);
    now = new Date('2026-11-14T05:00:00Z');
  });
});

describe('ревизия 02.11: порядок блокировок – счёт до заказа', () => {
  it('возврат товара параллельно с командой «счёт → заказ FOR UPDATE» – без дедлока', async () => {
    const c = await clientWith(10_000);
    const g = await goods();
    const { orderId } = await issue(c, g.id);
    const admin = ctxOf('admin');
    const x = await pool.connect();
    try {
      await x.query('BEGIN');
      const acc = (await db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_id = $1`, [c])).rows[0]!;
      await lockAccounts(x, [acc.id]);
      const run = inTx((tx) => returnGoods(tx, admin, { orderId, reason: 'не выдали' }, metaOf(admin), clock));
      for (let i = 0; i < 200; i++) {
        if ((await db.client.query<{ n: number }>(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await x.query('SELECT 1 FROM app.loyalty_goods_orders WHERE id = $1 FOR UPDATE', [orderId]);
      await x.query('COMMIT');
      expect(await run).toEqual({ returnedCenti: 3000, notReturnedCenti: 0 });
    } catch (err) {
      await x.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      x.release();
    }
    expect(await bal(c)).toBe(10_000);
  });
});
