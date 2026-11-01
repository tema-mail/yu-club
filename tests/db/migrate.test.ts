import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp, migrationStatus } from '../../db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let dir: string;

const writeMig = (file: string, up: string, down: string) =>
  writeFile(path.join(dir, file), `-- migrate:up\n${up}\n-- migrate:down\n${down}\n`);

async function tables(): Promise<string[]> {
  const res = await db.client.query<{ t: string }>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY 1",
  );
  return res.rows.map((r) => r.t);
}

beforeEach(async () => {
  db = await createTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'yu-mig-'));
  await writeMig('0001_a.sql', 'CREATE TABLE a (id int);', 'DROP TABLE a;');
  await writeMig('0002_b.sql', 'CREATE TABLE b (id int);', 'DROP TABLE b;');
});

afterEach(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

describe('раннер миграций', () => {
  it('вверх применяет все по порядку, повтор – no-op', async () => {
    expect(await migrateUp(db.client, dir)).toEqual(['0001', '0002']);
    expect(await tables()).toEqual(['a', 'b']);
    expect(await migrateUp(db.client, dir)).toEqual([]);
    const count = await db.client.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(count.rows[0].n).toBe(2);
  });

  it('вниз откатывает с конца по шагам, затем снова вверх', async () => {
    await migrateUp(db.client, dir);
    expect(await migrateDown(db.client, 1, dir)).toEqual(['0002']);
    expect(await tables()).toEqual(['a']);
    expect(await migrateDown(db.client, 5, dir)).toEqual(['0001']);
    expect(await tables()).toEqual([]);
    expect(await migrateDown(db.client, 1, dir)).toEqual([]);
    expect(await migrateUp(db.client, dir)).toEqual(['0001', '0002']);
  });

  it('упавшая миграция откатывается целиком и не записывается', async () => {
    await writeMig('0003_bad.sql', 'CREATE TABLE c (id int); SELECT * FROM no_such_table;', 'DROP TABLE c;');
    await expect(migrateUp(db.client, dir)).rejects.toThrow(/no_such_table/);
    expect(await tables()).toEqual(['a', 'b']);
    const st = await migrationStatus(db.client, dir);
    expect(st.map((s) => s.applied)).toEqual([true, true, false]);
  });

  it('изменённая после применения миграция останавливает раннер', async () => {
    await migrateUp(db.client, dir);
    await writeMig('0001_a.sql', 'CREATE TABLE a (id bigint);', 'DROP TABLE a;');
    await expect(migrateUp(db.client, dir)).rejects.toThrow(/0001 изменена/);
  });

  it('файл без секций отклоняется', async () => {
    await writeFile(path.join(dir, '0003_x.sql'), 'CREATE TABLE x (id int);');
    await expect(migrateUp(db.client, dir)).rejects.toThrow(/migrate:up/);
  });
});

describe('раннер миграций: порядок и целостность', () => {
  it('пропавший файл применённой миграции останавливает раннер', async () => {
    await migrateUp(db.client, dir);
    await rm(path.join(dir, '0002_b.sql'));
    await expect(migrateUp(db.client, dir)).rejects.toThrow(/0002 отсутствует/);
  });

  it('новая миграция с номером меньше применённого – ошибка порядка', async () => {
    await rm(path.join(dir, '0001_a.sql'));
    await migrateUp(db.client, dir);
    await writeMig('0001_a.sql', 'CREATE TABLE a (id int);', 'DROP TABLE a;');
    await expect(migrateUp(db.client, dir)).rejects.toThrow(/порядок нарушен/);
  });

  it('откат изменённой миграции запрещён', async () => {
    await migrateUp(db.client, dir);
    await writeMig('0002_b.sql', 'CREATE TABLE b (id int);', 'DROP TABLE a;');
    await expect(migrateDown(db.client, 1, dir)).rejects.toThrow(/0002 изменена/);
    expect(await tables()).toEqual(['a', 'b']);
  });
});
