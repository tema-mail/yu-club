import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSubscriptions,
  dispatchOutbox,
  listSubscriptions,
  processEvent,
  publish,
  subscribe,
  type OutboxJob,
  type Tx,
} from '../../apps/api/src/core/outbox.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

declare module '../../apps/api/src/core/outbox.ts' {
  interface EventRegistry {
    'test.happened': { n: number };
    'test.unwatched': { n: number };
  }
}

let db: TestDatabase;
let pool: pg.Pool;
const now = new Date('2026-11-15T07:00:00Z');

async function inTx<T>(fn: (tx: Tx) => Promise<T>, opts: { rollback?: boolean } = {}): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query(opts.rollback ? 'ROLLBACK' : 'COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

const happened = (aggregateId: string, n = 1, aggregateVersion: number | string = 1) => ({
  type: 'test.happened' as const,
  aggregateType: 'booking' as const,
  aggregateId,
  aggregateVersion,
  branchId: null,
  payload: { n },
  occurredAt: now,
});

const effects = async (eventId: string): Promise<number> =>
  Number((await db.client.query('SELECT count(*) AS n FROM app.t_effects WHERE event_id = $1', [eventId])).rows[0].n);

/** Обработчик-пример: пишет эффект в своей транзакции; первые `failures` раз бросает уже после записи. */
function effectHandler(failures = 0) {
  const state = { calls: 0 };
  return {
    state,
    handler: async (tx: Tx, e: { eventId: string; payload: { n: number } }) => {
      state.calls++;
      await tx.query('INSERT INTO app.t_effects (event_id, n) VALUES ($1, $2)', [e.eventId, e.payload.n]);
      if (state.calls <= failures) throw new Error(`сбой обработчика, попытка ${state.calls}`);
    },
  };
}

async function collectDispatch(): Promise<OutboxJob[]> {
  const jobs: OutboxJob[] = [];
  await dispatchOutbox(pool, async (j) => void jobs.push(j), now);
  return jobs;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await db.client.query('CREATE TABLE app.t_effects (id bigserial PRIMARY KEY, event_id uuid NOT NULL, n int NOT NULL)');
  pool = new pg.Pool({ connectionString: db.url, max: 10 });
  pool.on('connect', (c) => {
    void c.query('SET ROLE yu_app');
  });
});

afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

beforeEach(async () => {
  clearSubscriptions();
  await collectDispatch(); // разослать хвосты прошлых тестов без подписчиков
});

describe('S0-08 outbox: запись и рассылка', () => {
  it('после миграций журнальные таблицы только на вставку', async () => {
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
  });

  it('откат транзакции факта → события нет ни в outbox, ни у подписчика', async () => {
    const h = effectHandler();
    subscribe('test.happened', 'test.rollback', h.handler);
    const agg = randomUUID();
    await inTx((tx) => publish(tx, happened(agg)), { rollback: true });
    expect((await db.client.query('SELECT count(*)::int AS n FROM app.outbox_events WHERE aggregate_id = $1', [agg])).rows[0].n).toBe(0);
    expect(await collectDispatch()).toEqual([]);
    expect(h.state.calls).toBe(0);
  });

  it('фиксация → задача на каждого подписчика с singletonKey, dispatched_at = now, второй проход пуст', async () => {
    subscribe('test.happened', 'test.a', effectHandler().handler);
    subscribe('test.happened', 'test.b', effectHandler().handler, { retryLimit: 3 });
    subscribe('test.unwatched', 'test.c', effectHandler().handler);
    const { eventId } = await inTx((tx) => publish(tx, happened(randomUUID())));
    const jobs = await collectDispatch();
    expect(jobs).toEqual([
      { queue: 'outbox/test.a', handler: 'test.a', eventId, singletonKey: `${eventId}:test.a`, retryLimit: 10, retryBackoff: true },
      { queue: 'outbox/test.b', handler: 'test.b', eventId, singletonKey: `${eventId}:test.b`, retryLimit: 3, retryBackoff: true },
    ]);
    const row = (await db.client.query('SELECT dispatched_at FROM app.outbox_events WHERE id = $1', [eventId])).rows[0];
    expect(row.dispatched_at.toISOString()).toBe(now.toISOString());
    expect(await collectDispatch()).toEqual([]);
  });

  it('ошибка постановки откатывает проход – событие берётся снова', async () => {
    subscribe('test.happened', 'test.enqueue-fail', effectHandler().handler);
    const { eventId } = await inTx((tx) => publish(tx, happened(randomUUID())));
    await expect(dispatchOutbox(pool, async () => Promise.reject(new Error('очередь недоступна')), now)).rejects.toThrow(/недоступна/);
    expect((await collectDispatch()).map((j) => j.eventId)).toEqual([eventId]);
  });

  it('два диспетчера параллельно не ставят событие дважды (SKIP LOCKED)', async () => {
    subscribe('test.happened', 'test.parallel', effectHandler().handler);
    const ids = await inTx(async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 30; i++) out.push((await publish(tx, happened(randomUUID(), i))).eventId);
      return out;
    });
    const a: OutboxJob[] = [];
    const b: OutboxJob[] = [];
    await Promise.all([
      dispatchOutbox(pool, async (j) => void a.push(j), now, 10),
      dispatchOutbox(pool, async (j) => void b.push(j), now, 10),
      dispatchOutbox(pool, async (j) => void a.push(j), now, 10),
      dispatchOutbox(pool, async (j) => void b.push(j), now, 10),
    ]);
    const rest = await collectDispatch();
    const all = [...a, ...b, ...rest].map((j) => j.eventId).sort();
    expect(all).toEqual([...ids].sort());
  });

  it('publish того же факта дважды в одной команде → одна строка, тот же eventId', async () => {
    const agg = randomUUID();
    const [first, second] = await inTx(async (tx) => [await publish(tx, happened(agg, 1)), await publish(tx, happened(agg, 2))]);
    expect(second.eventId).toBe(first.eventId);
    const rows = await db.client.query('SELECT payload, event_version, dedupe_key FROM app.outbox_events WHERE aggregate_id = $1', [agg]);
    expect(rows.rows).toEqual([{ payload: { n: 1 }, event_version: 1, dedupe_key: `test.happened:${agg}:1` }]);
    const next = await inTx((tx) => publish(tx, happened(agg, 3, 2)));
    expect(next.eventId).not.toBe(first.eventId);
  });

  it('NOTIFY outbox приходит только после фиксации', async () => {
    const listener = new pg.Client({ connectionString: db.url });
    await listener.connect();
    const got: string[] = [];
    listener.on('notification', (m) => void got.push(m.payload ?? ''));
    await listener.query('LISTEN outbox');
    try {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const { eventId } = await publish(c, happened(randomUUID()));
        await new Promise((r) => setTimeout(r, 200));
        expect(got).toEqual([]);
        await c.query('COMMIT');
        await expect.poll(() => got, { timeout: 2000 }).toEqual([eventId]);
      } finally {
        c.release();
      }
    } finally {
      await listener.end();
    }
  });
});

describe('S0-08 outbox: обработка', () => {
  it('двойная доставка одной задачи → processed_events гасит вторую, эффект один', async () => {
    const h = effectHandler();
    subscribe('test.happened', 'test.twice', h.handler);
    const { eventId } = await inTx((tx) => publish(tx, happened(randomUUID(), 7)));
    expect(await processEvent(pool, 'test.twice', eventId)).toBe('processed');
    expect(await processEvent(pool, 'test.twice', eventId)).toBe('duplicate');
    expect(await effects(eventId)).toBe(1);
    expect(h.state.calls).toBe(1);
  });

  it('параллельная двойная доставка → один processed, один duplicate', async () => {
    const h = effectHandler();
    subscribe('test.happened', 'test.race', h.handler);
    const { eventId } = await inTx((tx) => publish(tx, happened(randomUUID())));
    const results = await Promise.all([processEvent(pool, 'test.race', eventId), processEvent(pool, 'test.race', eventId)]);
    expect(results.sort()).toEqual(['duplicate', 'processed']);
    expect(await effects(eventId)).toBe(1);
  });

  it('обработчик бросает 2 раза → откат каждой попытки, третья успешна, эффект один', async () => {
    const h = effectHandler(2);
    subscribe('test.happened', 'test.flaky', h.handler);
    const { eventId } = await inTx((tx) => publish(tx, happened(randomUUID())));
    await expect(processEvent(pool, 'test.flaky', eventId)).rejects.toThrow(/попытка 1/);
    await expect(processEvent(pool, 'test.flaky', eventId)).rejects.toThrow(/попытка 2/);
    expect(await effects(eventId)).toBe(0);
    const marks = await db.client.query('SELECT count(*)::int AS n FROM app.processed_events WHERE event_id = $1', [eventId]);
    expect(marks.rows[0].n).toBe(0);
    expect(await processEvent(pool, 'test.flaky', eventId)).toBe('processed');
    expect(await effects(eventId)).toBe(1);
  });

  it('обработчики независимы: сбой одного не мешает другому; конверт события полный', async () => {
    const seen: unknown[] = [];
    subscribe('test.happened', 'test.ok', async (_tx, e) => void seen.push(e));
    subscribe('test.happened', 'test.bad', async () => Promise.reject(new Error('плохой')));
    const agg = randomUUID();
    const { eventId } = await inTx((tx) => publish(tx, happened(agg, 5)));
    await expect(processEvent(pool, 'test.bad', eventId)).rejects.toThrow(/плохой/);
    expect(await processEvent(pool, 'test.ok', eventId)).toBe('processed');
    expect(seen).toEqual([
      {
        eventId,
        type: 'test.happened',
        version: 1,
        aggregateType: 'booking',
        aggregateId: agg,
        branchId: null,
        occurredAt: now.toISOString(),
        payload: { n: 5 },
      },
    ]);
  });

  it('подписка: имя уникально и без запрещённых символов', () => {
    subscribe('test.happened', 'test.unique', async () => {});
    expect(() => subscribe('test.happened', 'test.unique', async () => {})).toThrow(/уже зарегистрирован/);
    expect(() => subscribe('test.happened', 'bad:name', async () => {})).toThrow(/только/);
    expect(listSubscriptions().map((s) => s.name)).toEqual(['test.unique']);
  });
});
