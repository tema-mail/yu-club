import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '../../db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const run = promisify(execFile);

async function asApp<T>(db: TestDatabase, fn: () => Promise<T>): Promise<T> {
  await db.client.query('SET ROLE yu_app');
  try {
    return await fn();
  } finally {
    await db.client.query('RESET ROLE');
  }
}

describe('0001_init на мигрированной базе', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    await db.client.query('CREATE TABLE journal.t_events (id bigserial PRIMARY KEY, v text NOT NULL)');
    await db.client.query('CREATE TABLE app.t_items (id bigserial PRIMARY KEY, v text NOT NULL)');
  });
  afterAll(async () => {
    await db.drop();
  });

  it('btree_gist даёт EXCLUDE по ресурсу и интервалу', async () => {
    await db.client.query(`CREATE TABLE app.t_slots (
      resource_id int NOT NULL, during tstzrange NOT NULL,
      EXCLUDE USING gist (resource_id WITH =, during WITH &&))`);
    await db.client.query("INSERT INTO app.t_slots VALUES (1, '[2026-11-01 10:00+03, 2026-11-01 11:00+03)')");
    await db.client.query("INSERT INTO app.t_slots VALUES (1, '[2026-11-01 11:00+03, 2026-11-01 12:00+03)')");
    await expect(
      db.client.query("INSERT INTO app.t_slots VALUES (1, '[2026-11-01 10:30+03, 2026-11-01 10:45+03)')"),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('yu_app в journal: вставка и чтение есть, UPDATE/DELETE/TRUNCATE – нет', async () => {
    await asApp(db, async () => {
      await db.client.query("INSERT INTO journal.t_events (v) VALUES ('a')");
      const r = await db.client.query('SELECT count(*)::int AS n FROM journal.t_events');
      expect(r.rows[0].n).toBe(1);
      await expect(db.client.query("UPDATE journal.t_events SET v = 'b'")).rejects.toMatchObject({ code: '42501' });
      await expect(db.client.query('DELETE FROM journal.t_events')).rejects.toMatchObject({ code: '42501' });
      await expect(db.client.query('TRUNCATE journal.t_events')).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('yu_app в app: полный DML, но не DDL', async () => {
    await asApp(db, async () => {
      await db.client.query("INSERT INTO app.t_items (v) VALUES ('a')");
      await db.client.query("UPDATE app.t_items SET v = 'b'");
      await db.client.query('DELETE FROM app.t_items');
      await expect(db.client.query('DROP TABLE app.t_items')).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('append_only_violations ловит лишние права, make_append_only их снимает', async () => {
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
    await db.client.query('GRANT UPDATE ON journal.t_events TO yu_app');
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([
      { table_name: 'journal.t_events', privilege: 'UPDATE' },
    ]);
    await db.client.query("SELECT journal.make_append_only('journal.t_events')");
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
  });

  it('колоночный GRANT UPDATE тоже считается нарушением', async () => {
    await db.client.query('GRANT UPDATE (v) ON journal.t_events TO yu_app');
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([
      { table_name: 'journal.t_events', privilege: 'UPDATE' },
    ]);
    await db.client.query("SELECT journal.make_append_only('journal.t_events')");
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
    await asApp(db, async () => {
      await expect(db.client.query("UPDATE journal.t_events SET v = 'x'")).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('CLI db/migrate.ts на чистой базе', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  const cli = async (...args: string[]) =>
    (await run(process.execPath, ['db/migrate.ts', ...args], { env: { ...process.env, MIGRATION_DATABASE_URL: db.url } })).stdout.trim();

  const objects = async () =>
    (
      await db.client.query<{ n: number }>(`SELECT
        (SELECT count(*) FROM pg_namespace WHERE nspname IN ('app', 'journal'))
        + (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist') AS n`)
    ).rows[0]!.n;

  it('вверх → повтор no-op → вниз → вверх', async () => {
    // Список берём из папки: тест не ломается от каждой новой миграции.
    const all = await loadMigrations();
    const versions = all.map((m) => m.version).join(', ');
    const status = (mark: string) => all.map((m) => `[${mark}] ${m.version}_${m.name}`).join('\n');
    expect(await cli('up')).toBe(`Применены: ${versions}`);
    expect(Number(await objects())).toBe(3);
    expect(await cli('up')).toBe('Нечего применять');
    expect(await cli('status')).toBe(status('x'));
    expect(await cli('down', String(all.length))).toBe(`Откачены: ${[...all].reverse().map((m) => m.version).join(', ')}`);
    expect(Number(await objects())).toBe(0);
    expect(await cli('status')).toBe(status(' '));
    expect(await cli('up')).toBe(`Применены: ${versions}`);
    const role = await db.client.query("SELECT 1 FROM pg_roles WHERE rolname = 'yu_app'");
    expect(role.rowCount).toBe(1); // откат не трогает роль кластера
  });
});
