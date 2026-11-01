// Общий хелпер тестов с настоящей Postgres.
//
// globalSetup (vitest.config.ts): если задан DATABASE_URL (CI, сервис postgres:16) –
// берём его как админское подключение; иначе поднимаем embedded-postgres 16
// во временной папке и гасим после прогона. Каждый тест-файл создаёт себе
// отдельную базу через createTestDatabase() – тесты не мешают друг другу.
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

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.DATABASE_URL;
  if (external) {
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
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  project.provide('pgAdminUrl', `postgres://postgres:${password}@127.0.0.1:${port}/postgres`);
  return async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  };
}

export interface TestDatabase {
  url: string;
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

  return {
    url: url.toString(),
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
