// Ошибка простаивающего соединения пула без обработчика 'error' роняет процесс API (pg генерирует событие на самом пуле). Обработчик – как в worker.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createReportsPool } from '../../apps/api/src/modules/reports/framework.ts';
import { depsFromConfig } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
}, 60_000);
afterAll(async () => {
  await db.drop();
});

describe('пулы API не падают от обрыва простаивающего соединения', () => {
  it('пул отчётов: соединение убито на сервере – процесс жив, пул работает дальше', async () => {
    const pool = createReportsPool(db.reportsUrl);
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await db.client.query('SELECT pg_terminate_backend($1)', [pid]);
    await new Promise((r) => setTimeout(r, 100));
    expect((await pool.query<{ n: number }>('SELECT 1 AS n')).rows[0]!.n).toBe(1);
    await pool.end();
  });

  it('основной пул и пул отчётов из depsFromConfig – с обработчиком', async () => {
    const { deps, close, sender } = depsFromConfig(loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: db.url, REPORTS_DATABASE_URL: db.reportsUrl }));
    expect(sender?.pool && (sender.pool as unknown as { listenerCount(e: string): number }).listenerCount('error')).toBeGreaterThan(0);
    expect(deps.reports!.pool.listenerCount('error')).toBeGreaterThan(0);
    await close();
  });
});
