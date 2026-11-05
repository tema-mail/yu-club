// Ревизия K24 §9: отмена отчёта по закрытию запроса (pg_cancel_backend своей роли) и общий бюджет времени – не только statement_timeout;
// пул из 3 соединений не держат ни брошенный запрос, ни дашборд из десятков запросов.
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withReportTx } from '../../apps/api/src/modules/reports/framework.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { reportFixtures, type Fx } from '../helpers/reports.ts';

let db: TestDatabase;
let fx: Fx;

const codeOf = (e: unknown) => (e instanceof AppError ? e.code : e);
/** Сколько запросов роли yu_reports сейчас идёт в этой базе: чужие запросы видны только своей роли, поэтому спрашиваем её же пулом. */
const running = async (like: string): Promise<number> =>
  Number(
    (
      await fx.reports.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid() AND query LIKE $1`,
        [like],
      )
    ).rows[0]!.n,
  );
async function until(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('бюджет времени отчёта', () => {
  it('десятки коротких запросов подряд: REPORT_TIMEOUT по бюджету, хотя каждый укладывается в statement_timeout', async () => {
    let done = 0;
    const started = Date.now();
    const err = await withReportTx(
      fx.reports,
      async (tx) => {
        for (let i = 0; i < 100; i += 1) {
          await tx.query('SELECT pg_sleep(0.05)');
          done += 1;
        }
      },
      { timeoutMs: 5_000, budgetMs: 300 },
    ).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('REPORT_TIMEOUT');
    expect(done).toBeLessThan(100);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('один долгий запрос отменяется в базе по бюджету, а не ждёт statement_timeout', async () => {
    const started = Date.now();
    const err = await withReportTx(fx.reports, (tx) => tx.query('SELECT pg_sleep(30) /* бюджет */'), { timeoutMs: 60_000, budgetMs: 200 }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('REPORT_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await running('%бюджет%')).toBe(0);
  }, 40_000);

  it('код между запросами: после бюджета следующий запрос не начинается', async () => {
    const err = await withReportTx(
      fx.reports,
      async (tx) => {
        await new Promise((r) => setTimeout(r, 200));
        return tx.query('SELECT 1');
      },
      { budgetMs: 50 },
    ).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('REPORT_TIMEOUT');
  });

  it('уложился в бюджет – обычный результат, соединение возвращается в пул', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await withReportTx(fx.reports, (tx) => tx.query<{ n: number }>('SELECT 1 AS n'), { budgetMs: 10_000 });
      expect(r.rows[0]!.n).toBe(1);
    }
  });
});

describe('отмена по сигналу', () => {
  it('сигнал во время запроса – REPORT_CANCELLED, запрос снят в базе, пул жив', async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctrl.abort(), 150);
    const err = await withReportTx(fx.reports, (tx) => tx.query('SELECT pg_sleep(30) /* сигнал */'), { timeoutMs: 60_000, signal: ctrl.signal }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('REPORT_CANCELLED');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await running('%сигнал%')).toBe(0);
    const again = await withReportTx(fx.reports, (tx) => tx.query<{ n: number }>('SELECT 1 AS n'));
    expect(again.rows[0]!.n).toBe(1);
  }, 40_000);

  it('сигнал уже отменён – соединение не берётся', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let connects = 0;
    const pool = { connect: async () => { connects += 1; throw new Error('не должно'); }, end: async () => {} };
    expect(codeOf(await withReportTx(pool, async () => 1, { signal: ctrl.signal }).catch((e: unknown) => e))).toBe('REPORT_CANCELLED');
    expect(connects).toBe(0);
  });
});

describe('закрытие запроса по HTTP', () => {
  const PASSWORD = 'correct horse battery';
  const clock = fixedClock('2026-11-20T05:00:00Z');
  let app: ReturnType<typeof buildServer>;
  let main: pg.Pool;
  let cookie: string;
  let base: string;

  beforeAll(async () => {
    main = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool: main, auth: staffAuthConfig('t'.repeat(40)), clock }, reports: { pool: fx.reports } });
    await db.client.query(`UPDATE app.staff SET email = 'owner@yu.test', password_hash = $1 WHERE id = $2`, [await hashPassword(PASSWORD), fx.ownerId]);
    const login = await app.inject({ method: 'POST', url: '/api/crm/v1/auth/login', payload: { email: 'owner@yu.test', password: PASSWORD } });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/crm/v1`;
  }, 30_000);
  afterAll(async () => {
    await app.close();
    await main.end();
  });

  it('клиент закрыл запрос: запрос в базе снимается сразу, а не по таймауту; следующий отчёт работает', async () => {
    await fx.branch('Asia/Novosibirsk'); // без филиалов отчёт не идёт в базу
    const locker = new pg.Client({ connectionString: db.url });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE app.bookings IN ACCESS EXCLUSIVE MODE');
    const ctrl = new AbortController();
    const pending = fetch(`${base}/reports/bookings?from=2026-11-01&to=2026-11-30`, { headers: { cookie }, signal: ctrl.signal }).catch((e: unknown) => e);
    try {
      expect(await until(async () => (await running('%rpt_bookings%')) > 0, 5_000)).toBe(true);
      ctrl.abort();
      await pending;
      expect(await until(async () => (await running('%rpt_bookings%')) === 0, 3_000)).toBe(true);
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }
    const next = await fetch(`${base}/reports/bookings?from=2026-11-01&to=2026-11-30`, { headers: { cookie } });
    expect(next.status).toBe(200);
  }, 30_000);

  it('обычный ответ не отменяется и не оставляет отмены пулу', async () => {
    const res = await fetch(`${base}/reports/bookings?from=2026-11-01&to=2026-11-30`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { computedAt: string }).computedAt).toBeTruthy();
  });
});
