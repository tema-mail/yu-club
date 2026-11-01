// Раннер миграций: чистый SQL, вверх и вниз, учёт применённых в schema_migrations.
//
// Формат файла: db/migrations/NNNN_имя.sql с двумя секциями:
//   -- migrate:up
//   ...SQL...
//   -- migrate:down
//   ...SQL...
// Каждая миграция выполняется в своей транзакции (CREATE INDEX CONCURRENTLY и
// прочее «вне транзакции» не поддерживается намеренно). Повторный «вверх» – no-op.
// Применённый файл менять нельзя: контрольная сумма не совпадёт, раннер остановится.
// Параллельные запуски сериализуются advisory-блокировкой.
//
// CLI: DATABASE_URL=... node db/migrate.ts up | down [N] | status
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 7_204_513_001; // произвольная константа проекта для pg_advisory_lock
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: string;
  name: string;
  up: string;
  down: string;
  checksum: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const result: Migration[] = [];
  for (const file of files) {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`Имя миграции не по формату NNNN_name.sql: ${file}`);
    const text = await readFile(path.join(dir, file), 'utf8');
    const upAt = text.indexOf('-- migrate:up');
    const downAt = text.indexOf('-- migrate:down');
    if (upAt === -1 || downAt === -1 || downAt < upAt) {
      throw new Error(`В ${file} нужны секции "-- migrate:up" и затем "-- migrate:down"`);
    }
    result.push({
      version: m[1]!,
      name: m[2]!,
      up: text.slice(upAt + '-- migrate:up'.length, downAt).trim(),
      down: text.slice(downAt + '-- migrate:down'.length).trim(),
      checksum: createHash('sha256').update(text).digest('hex'),
    });
  }
  const seen = new Set<string>();
  for (const mig of result) {
    if (seen.has(mig.version)) throw new Error(`Повтор номера миграции ${mig.version}`);
    seen.add(mig.version);
  }
  return result;
}

interface Applied {
  version: string;
  checksum: string;
}

async function withLock<T>(client: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

async function applied(client: pg.ClientBase): Promise<Applied[]> {
  const res = await client.query<Applied>('SELECT version, checksum FROM public.schema_migrations ORDER BY version');
  return res.rows;
}

async function inTx(client: pg.ClientBase, fn: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await fn();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** Применяет все неприменённые миграции по порядку. Возвращает версии применённых сейчас. */
export async function migrateUp(client: pg.ClientBase, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  return withLock(client, async () => {
    const done = new Map((await applied(client)).map((a) => [a.version, a.checksum]));
    for (const [version, checksum] of done) {
      const file = migrations.find((m) => m.version === version);
      if (file && file.checksum !== checksum) {
        throw new Error(`Применённая миграция ${version} изменена после применения`);
      }
    }
    const ran: string[] = [];
    for (const mig of migrations) {
      if (done.has(mig.version)) continue;
      await inTx(client, async () => {
        await client.query(mig.up);
        await client.query('INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          mig.version,
          mig.name,
          mig.checksum,
        ]);
      });
      ran.push(mig.version);
    }
    return ran;
  });
}

/** Откатывает последние `steps` применённых миграций. Возвращает версии откаченных. */
export async function migrateDown(client: pg.ClientBase, steps = 1, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  if (!Number.isInteger(steps) || steps < 1) throw new Error('Число шагов отката – целое ≥ 1');
  const migrations = await loadMigrations(dir);
  return withLock(client, async () => {
    const targets = (await applied(client)).reverse().slice(0, steps);
    const reverted: string[] = [];
    for (const target of targets) {
      const mig = migrations.find((m) => m.version === target.version);
      if (!mig) throw new Error(`Нет файла для отката применённой миграции ${target.version}`);
      await inTx(client, async () => {
        await client.query(mig.down);
        await client.query('DELETE FROM public.schema_migrations WHERE version = $1', [mig.version]);
      });
      reverted.push(mig.version);
    }
    return reverted;
  });
}

export async function migrationStatus(
  client: pg.ClientBase,
  dir: string = MIGRATIONS_DIR,
): Promise<{ version: string; name: string; applied: boolean }[]> {
  const migrations = await loadMigrations(dir);
  const done = await withLock(client, () => applied(client));
  const set = new Set(done.map((a) => a.version));
  return migrations.map((m) => ({ version: m.version, name: m.name, applied: set.has(m.version) }));
}

async function cli(argv: string[]): Promise<void> {
  const [command, arg] = argv;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Нужен DATABASE_URL (учётка мигратора, не yu_app)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (command === 'up') {
      const ran = await migrateUp(client);
      console.log(ran.length ? `Применены: ${ran.join(', ')}` : 'Нечего применять');
    } else if (command === 'down') {
      const reverted = await migrateDown(client, arg ? Number(arg) : 1);
      console.log(reverted.length ? `Откачены: ${reverted.join(', ')}` : 'Нечего откатывать');
    } else if (command === 'status') {
      for (const s of await migrationStatus(client)) console.log(`${s.applied ? '[x]' : '[ ]'} ${s.version}_${s.name}`);
    } else {
      throw new Error('Команды: up | down [N] | status');
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
