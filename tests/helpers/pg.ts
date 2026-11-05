// Общий хелпер тестов с настоящей Postgres.
//
// globalSetup (vitest.config.ts): если задан TEST_DATABASE_URL (CI, сервис postgres:16) –
// берём его как админское подключение (суперпользователь одноразового кластера);
// DATABASE_URL намеренно не читаем: это рантайм-учётка yu_app (ADR 0001), а тесты
// создают и удаляют базы. Иначе поднимаем embedded-postgres 16
// во временной папке и гасим после прогона. Каждый тест-файл создаёт себе
// отдельную базу через createTestDatabase() – тесты не мешают друг другу.
// Роли кластера (yu_app) на сервере создаёт скрипт инициализации, а не миграция –
// здесь это делает globalSetup, чтобы миграции работали так же, как на сервере.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { inject } from 'vitest';
import type { TestProject } from 'vitest/node';
import { migrateUp } from '../../db/migrate.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgReportsPassword: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('нет порта'))));
    });
  });
}

// yu_reports (пул отчётов K24 §9) – с входом: тесты S4-60/S4-62 подключаются под ней, чтобы проверить
// default_transaction_read_only (настройка роли действует при входе, не при SET ROLE). Пароль – одноразовый на прогон.
async function ensureClusterRoles(adminUrl: string, reportsPassword: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yu_app') THEN CREATE ROLE yu_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yu_reports') THEN CREATE ROLE yu_reports LOGIN; END IF;
    END $$`);
    await c.query(`ALTER ROLE yu_reports LOGIN PASSWORD '${reportsPassword}'`);
    await c.query('ALTER ROLE yu_reports SET default_transaction_read_only = on');
  } finally {
    await c.end();
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.TEST_DATABASE_URL;
  const reportsPassword = randomBytes(12).toString('hex');
  project.provide('pgReportsPassword', reportsPassword);
  if (external) {
    await ensureClusterRoles(external, reportsPassword);
    project.provide('pgAdminUrl', external);
    return async () => {};
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = await mkdtemp(path.join(tmpdir(), 'yu-pg-'));
  const port = await freePort();
  const password = randomBytes(12).toString('hex'); // одноразовый, живёт только в прогоне
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password,
    port,
    persistent: false,
    // гонки K6 держат пул ≥ 50 в двух файлах сразу (composite, confirm) – 100 по умолчанию не хватает
    postgresFlags: ['-c', 'max_connections=300'],
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  await ensureClusterRoles(adminUrl, reportsPassword);
  project.provide('pgAdminUrl', adminUrl);
  return async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  };
}

export interface TestDatabase {
  url: string;
  /** Та же база под ролью yu_reports (только чтение, K24 §9). */
  reportsUrl: string;
  client: pg.Client;
  drop: () => Promise<void>;
}

/** Создаёт пустую временную базу; при migrate=true применяет миграции db/migrations. */
export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  if (opts.migrate) await migrateUp(client);

  const reports = new URL(url.toString());
  reports.username = 'yu_reports';
  reports.password = inject('pgReportsPassword');
  return {
    url: url.toString(),
    reportsUrl: reports.toString(),
    client,
    drop: async () => {
      await client.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
