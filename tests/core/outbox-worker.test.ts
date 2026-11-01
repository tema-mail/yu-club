import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSubscriptions, outboxQueue, publish, subscribe, type Tx } from '../../apps/api/src/core/outbox.ts';
import { startOutboxWorker, type OutboxWorker } from '../../apps/api/src/core/outbox-worker.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

declare module '../../apps/api/src/core/outbox.ts' {
  interface EventRegistry {
    'worker.happened': { n: number };
  }
}

const clock = fixedClock('2026-11-15T07:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let boss: PgBoss;
let worker: OutboxWorker;
const logged: Record<string, unknown>[] = [];
const calls = new Map<string, number>(); // `${handler}|${eventId}` → число вызовов

async function publishHappened(n: number, opts: { rollback?: boolean } = {}): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { eventId } = await publish(c, {
      type: 'worker.happened',
      aggregateType: 'booking',
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      branchId: null,
      payload: { n },
      occurredAt: clock.now(),
    });
    await c.query(opts.rollback ? 'ROLLBACK' : 'COMMIT');
    return eventId;
  } finally {
    c.release();
  }
}

/** Обработчик: пишет эффект; бросает, пока номер вызова ≤ failuresBefore(payload.n). */
function handler(name: string, failures: (n: number) => number) {
  return async (tx: Tx, e: { eventId: string; payload: { n: number } }) => {
    const k = `${name}|${e.eventId}`;
    const attempt = (calls.get(k) ?? 0) + 1;
    calls.set(k, attempt);
    await tx.query('INSERT INTO app.t_effects (handler, event_id) VALUES ($1, $2)', [name, e.eventId]);
    if (attempt <= failures(e.payload.n)) throw new Error(`сбой ${attempt}`);
  };
}

const effects = async (name: string, eventId: string): Promise<number> =>
  Number(
    (await db.client.query('SELECT count(*) AS n FROM app.t_effects WHERE handler = $1 AND event_id = $2', [name, eventId])).rows[0].n,
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await db.client.query('CREATE TABLE app.t_effects (id bigserial PRIMARY KEY, handler text NOT NULL, event_id uuid NOT NULL)');
  pool = new pg.Pool({ connectionString: db.url, max: 10 });
  pool.on('connect', (c) => {
    void c.query('SET ROLE yu_app');
  });
  // pg-boss держит свою схему; в тесте – от владельца базы (см. отчёт: роль для pgboss на сервере).
  boss = new PgBoss({ connectionString: db.url, schema: 'pgboss' });
  boss.on('error', (err) => logged.push({ bossError: String(err) }));
  await boss.start();

  clearSubscriptions();
  // n = число сбоев до успеха; n = 99 – всегда падает (до лимита 2 повторов)
  subscribe('worker.happened', 'worker.main', handler('worker.main', (n) => (n === 99 ? 0 : n)));
  subscribe('worker.happened', 'worker.dying', handler('worker.dying', (n) => (n === 99 ? Infinity : 0)), { retryLimit: 2 });
  worker = await startOutboxWorker({
    pool,
    boss,
    clock,
    intervalMs: 300,
    pollingIntervalSeconds: 0.5,
    retryDelaySeconds: 1,
    logger: { error: (obj) => void logged.push(obj) },
  });
}, 60_000);

afterAll(async () => {
  await worker?.stop();
  await boss?.stop({ graceful: false });
  clearSubscriptions();
  await pool?.end();
  await db?.drop();
});

describe('S0-08 доставка через pg-boss', () => {
  it('событие доходит до подписчика только после фиксации', async () => {
    const lost = await publishHappened(0, { rollback: true });
    const kept = await publishHappened(0);
    await expect.poll(() => effects('worker.main', kept), { timeout: 15_000, interval: 200 }).toBe(1);
    expect(await effects('worker.main', lost)).toBe(0);
    expect(calls.has(`worker.main|${lost}`)).toBe(false);
  });

  it('обработчик бросает 2 раза → повтор pg-boss, третья попытка успешна, эффект один', async () => {
    const eventId = await publishHappened(2);
    await expect.poll(() => effects('worker.main', eventId), { timeout: 25_000, interval: 250 }).toBe(1);
    expect(calls.get(`worker.main|${eventId}`)).toBe(3);
    const marks = await db.client.query('SELECT count(*)::int AS n FROM app.processed_events WHERE handler = $1 AND event_id = $2', [
      'worker.main',
      eventId,
    ]);
    expect(marks.rows[0].n).toBe(1);
  }, 30_000);

  it('повторная доставка задачи (вторая задача на то же событие) не дублирует эффект', async () => {
    const eventId = await publishHappened(0);
    await expect.poll(() => effects('worker.main', eventId), { timeout: 15_000, interval: 200 }).toBe(1);
    await boss.send(outboxQueue('worker.main'), { eventId }, { singletonKey: `${eventId}:worker.main:again` });
    const job = await boss.send(outboxQueue('worker.main'), { eventId });
    await expect
      .poll(async () => (await boss.findJobs(outboxQueue('worker.main'), { id: job! }))[0]?.state, { timeout: 15_000, interval: 200 })
      .toBe('completed');
    expect(await effects('worker.main', eventId)).toBe(1);
    expect(calls.get(`worker.main|${eventId}`)).toBe(1);
  }, 30_000);

  it('исчерпаны повторы → задача failed, лог error с eventId и handler; другой подписчик не пострадал', async () => {
    const eventId = await publishHappened(99);
    await expect
      .poll(() => logged.find((l) => l.eventId === eventId && l.handler === 'worker.dying'), { timeout: 25_000, interval: 250 })
      .toMatchObject({ eventId, handler: 'worker.dying', attempts: 3 });
    expect(calls.get(`worker.dying|${eventId}`)).toBe(3);
    expect(await effects('worker.dying', eventId)).toBe(0);
    await expect.poll(() => effects('worker.main', eventId), { timeout: 15_000, interval: 200 }).toBe(1);
    const jobs = await boss.findJobs(outboxQueue('worker.dying'), { data: { eventId } });
    await expect.poll(async () => (await boss.findJobs(outboxQueue('worker.dying'), { data: { eventId } }))[0]?.state).toBe('failed');
    expect(jobs).toHaveLength(1);
  }, 30_000);

  it('подписка после старта воркера – ошибка (очереди созданы по снимку)', () => {
    expect(() => subscribe('worker.happened', 'worker.late', handler('worker.late', () => 0))).toThrow(/подписки закрыты/);
  });

  it('dispatchNow: пустой outbox – ноль, без ошибок в логе диспетчера', async () => {
    await worker.dispatchNow();
    expect(await worker.dispatchNow()).toBe(0);
    expect(logged.filter((l) => 'bossError' in l || (typeof l.err === 'string' && !('eventId' in l)))).toEqual([]);
  });
});
