import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import {
  canonicalJson,
  claimKey,
  idempotencyScope,
  purgeExpiredKeys,
  requestHash,
  requireIdempotencyKey,
  runIdempotent,
  type IdempotentResult,
} from '../../apps/api/src/core/idempotency.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-15T07:00:00Z');
const scope = idempotencyScope('client', randomUUID(), 'booking.confirm');

let db: TestDatabase;
let pool: pg.Pool;

/** Команда-пример: создаёт строку заказа в своей транзакции через runIdempotent от роли yu_app. */
async function placeOrder(key: string, body: { item: string }, opts: { fail?: boolean } = {}): Promise<IdempotentResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await runIdempotent(c, { scope, key, request: { route: 'POST /orders', body }, clock }, async () => {
      const r = await c.query<{ id: string }>('INSERT INTO app.t_orders (item) VALUES ($1) RETURNING id::text', [body.item]);
      if (opts.fail) throw new AppError('VALIDATION_FAILED', 400, 'отказ по правилу');
      return { status: 201, body: { orderId: r.rows[0]!.id, item: body.item } };
    });
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

const count = async (): Promise<number> =>
  Number((await db.client.query('SELECT count(*) AS n FROM app.t_orders')).rows[0].n);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await db.client.query('CREATE TABLE app.t_orders (id bigserial PRIMARY KEY, item text NOT NULL)');
  // Пул рантайма: роль yu_app, 25 соединений – больше 20 параллельных, чтобы проверять базу, а не очередь пула.
  pool = new pg.Pool({ connectionString: db.url, max: 25 });
  pool.on('connect', (c) => {
    void c.query('SET ROLE yu_app');
  });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S0-05 идемпотентность команд', () => {
  it('после миграций журнальные таблицы только на вставку', async () => {
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
  });

  it('повтор с тем же ключом → тот же ответ, эффект один', async () => {
    const key = randomUUID();
    const before = await count();
    const first = await placeOrder(key, { item: 'pc-1' });
    const second = await placeOrder(key, { item: 'pc-1' });
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(second.status).toBe(201);
    expect(await count()).toBe(before + 1);
  });

  it('другой запрос с тем же ключом → 409 IDEMPOTENCY_KEY_REUSED, команда не выполняется', async () => {
    const key = randomUUID();
    await placeOrder(key, { item: 'pc-2' });
    const before = await count();
    await expect(placeOrder(key, { item: 'pc-3' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      httpStatus: 409,
    });
    expect(await count()).toBe(before);
  });

  it('20 параллельных одинаковых → одна запись, 19 повторов с тем же телом', async () => {
    const key = randomUUID();
    const before = await count();
    const results = await Promise.all(Array.from({ length: 20 }, () => placeOrder(key, { item: 'pc-par' })));
    expect(await count()).toBe(before + 1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const bodies = new Set(results.map((r) => JSON.stringify([r.status, r.body])));
    expect(bodies.size).toBe(1);
    const keys = await db.client.query('SELECT count(*)::int AS n FROM app.idempotency_keys WHERE key = $1', [key]);
    expect(keys.rows[0].n).toBe(1);
  });

  it('отказ команды откатывает и ключ: повтор выполняется заново', async () => {
    const key = randomUUID();
    const before = await count();
    await expect(placeOrder(key, { item: 'pc-4' }, { fail: true })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await count()).toBe(before);
    const retry = await placeOrder(key, { item: 'pc-4' });
    expect(retry.replayed).toBe(false);
    expect(await count()).toBe(before + 1);
  });

  it('ключи разных акторов не пересекаются', async () => {
    const key = randomUUID();
    const otherScope = idempotencyScope('client', randomUUID(), 'booking.confirm');
    await placeOrder(key, { item: 'pc-5' });
    await db.client.query('BEGIN');
    const claim = await claimKey(db.client, { scope: otherScope, key, requestHash: requestHash({ route: 'x' }), now: clock.now() });
    await db.client.query('ROLLBACK');
    expect(claim.kind).toBe('claimed');
  });

  it('created_at и expires_at – из Clock, +72 ч; очистка удаляет только просроченные', async () => {
    const key = randomUUID();
    await placeOrder(key, { item: 'pc-6' });
    const row = (
      await db.client.query('SELECT created_at, expires_at FROM app.idempotency_keys WHERE scope = $1 AND key = $2', [scope, key])
    ).rows[0];
    expect(row.created_at.toISOString()).toBe('2026-11-15T07:00:00.000Z');
    expect(row.expires_at.toISOString()).toBe('2026-11-18T07:00:00.000Z');
    const total = Number((await db.client.query('SELECT count(*) AS n FROM app.idempotency_keys')).rows[0].n);
    expect(await purgeExpiredKeys(pool, new Date('2026-11-18T06:59:59Z'))).toBe(0);
    expect(await purgeExpiredKeys(pool, new Date('2026-11-18T07:00:01Z'))).toBe(total);
  });

  it('заголовок: нет → 400 IDEMPOTENCY_KEY_REQUIRED, не UUID → VALIDATION_FAILED', () => {
    expect(() => requireIdempotencyKey(undefined)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED', httpStatus: 400 }));
    expect(() => requireIdempotencyKey('  ')).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(() => requireIdempotencyKey('abc')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    const k = randomUUID();
    expect(requireIdempotencyKey([k.toUpperCase()])).toBe(k);
  });

  it('канонический JSON не зависит от порядка ключей', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(requestHash({ route: 'r', body: { a: 1, b: 2 } })).toBe(requestHash({ route: 'r', body: { b: 2, a: 1 } }));
    expect(requestHash({ route: 'r', body: { a: 1 } })).not.toBe(requestHash({ route: 'r2', body: { a: 1 } }));
  });
});
