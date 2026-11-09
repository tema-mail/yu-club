// K24 §9, §13: права yu_reports выдаёт миграция, создающая представление (ALTER DEFAULT PRIVILEGES нет). Все rpt_*, которые использует модуль,
// читаются под yu_reports; любое новое представление Э3 и Э4 – тоже. Исключение – представления ночной сверки 0211: она идёт основным пулом,
// и заказчик мероприятия 0434 (имя и телефон – ПДн, K24 §6): его читает только глобальный поиск, тоже основным пулом.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const DIR = join(import.meta.dirname, '../../apps/api/src/modules/reports');
const RECONCILE_ONLY = new Set(['rpt_ledger_balances', 'rpt_loyalty_points', 'rpt_loyalty_batches', 'rpt_certificate_balances', 'rpt_cash_places']);
const MAIN_POOL_ONLY = new Set([...RECONCILE_ONLY, 'rpt_event_customers']);

let db: TestDatabase;
let reports: pg.Client;
beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  reports = new pg.Client({ connectionString: db.reportsUrl });
  await reports.connect();
}, 60_000);
afterAll(async () => {
  await reports.end();
  await db.drop();
});

describe('права yu_reports', () => {
  it('каждое rpt_*, упомянутое в коде отчётов, читается под yu_reports', async () => {
    const used = new Set<string>();
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.ts') && x !== 'reconcile.ts')) {
      for (const m of readFileSync(join(DIR, f), 'utf8').matchAll(/app\.(rpt_[a-z_]+)/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(10);
    for (const view of [...used].filter((v) => !MAIN_POOL_ONLY.has(v))) await expect(reports.query(`SELECT * FROM app.${view} LIMIT 0`), view).resolves.toBeTruthy();
  });

  const closedViews = async (): Promise<string[]> => {
    const views = await db.client.query<{ viewname: string; ok: boolean }>(
      `SELECT viewname, has_table_privilege('yu_reports', format('app.%I', viewname), 'SELECT') AS ok FROM pg_views WHERE schemaname = 'app' AND viewname LIKE 'rpt\\_%'`,
    );
    expect(views.rows.length).toBeGreaterThan(10);
    return views.rows.filter((v) => !v.ok && !MAIN_POOL_ONLY.has(v.viewname)).map((v) => v.viewname);
  };

  it('каждое представление rpt_* в базе, кроме сверки 0211 и ПДн заказчика 0434, доступно yu_reports', async () => {
    expect(await closedViews()).toEqual([]);
  });

  it('ПДн заказчика мероприятия (0434) yu_reports не читает', async () => {
    await expect(reports.query('SELECT * FROM app.rpt_event_customers LIMIT 0')).rejects.toThrow(/permission denied/);
  });

  it('страж ловит представление, созданное без GRANT (как забытый в 0311)', async () => {
    await db.client.query('CREATE VIEW app.rpt_zz_probe AS SELECT 1 AS n');
    try {
      expect(await closedViews()).toEqual(['rpt_zz_probe']);
    } finally {
      await db.client.query('DROP VIEW app.rpt_zz_probe');
    }
  });
});
