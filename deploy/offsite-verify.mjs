/* global process, console -- скрипт Node для мака; deploy/*.mjs не попадает под настройки eslint для Node */
// Пробное восстановление копии вне сервера (S3-99), зовёт deploy/offsite-pull.sh --verify.
// На маке нет pg_restore/psql, поэтому восстанавливаем текстовую форму дампа (<имя>.sql.gz,
// её при заборе делает pg_restore -f - на сервере из того же .dump) во временную
// embedded-postgres 16 (как tests/helpers/pg.ts): SQL – простым запросом, блоки COPY – вставками.
// Затем тот же подсчёт, что в backup.sh, сверяется с <имя>.counts. Кластер и папка удаляются всегда.
// Пароль кластера одноразовый и нигде не выводится.
// Запуск: node deploy/offsite-verify.mjs <дамп.sql.gz> <дамп.counts>
// Модули pg и embedded-postgres берутся из YU_NODE_ROOT (по умолчанию – корень репозитория).
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const [sqlPath, countsPath] = process.argv.slice(2);
if (!sqlPath || !countsPath) {
  console.error('ОШИБКА: нужно два аргумента – <дамп.sql.gz> <дамп.counts>');
  process.exit(2);
}
const root = process.env.YU_NODE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(root, 'package.json'));
const pg = req('pg');
const { default: EmbeddedPostgres } = await import(req.resolve('embedded-postgres'));

const COUNTS_SQL = `
SELECT 'rows ' || n.nspname || '.' || c.relname || ' ' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS l
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY 1`;
const LEDGER_SQL = `
SELECT 'ledger_sum ' || coalesce((
  SELECT (xpath('/row/s/text()', query_to_xml(format('SELECT coalesce(sum(amount), 0) AS s FROM %s', c.oid::regclass), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'amount' AND NOT a.attisdropped
  WHERE c.relname = 'ledger_entries' AND c.relkind IN ('r', 'p') LIMIT 1), 'нет_таблицы') AS l`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => resolve(a.port));
    });
  });
}

// Текстовый формат COPY: \N – NULL, обратная косая экранирует \t \n \r \b \f \v \\ и восьмеричные/\x
function unescapeCopy(f) {
  if (f === '\\N') return null;
  if (!f.includes('\\')) return f;
  const map = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  return f.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e) => {
    if (map[e]) return map[e];
    if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return e;
  });
}

async function restore(client, file) {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let sql = [];
  let copy = null; // { head, cols, rows }
  let inserted = 0;
  const flushSql = async () => {
    const text = sql.join('\n').trim();
    sql = [];
    if (text) await client.query(text);
  };
  const flushRows = async () => {
    if (!copy || copy.rows.length === 0) return;
    const n = copy.cols.length;
    const values = copy.rows.map((_, i) => `(${copy.cols.map((__, j) => `$${i * n + j + 1}`).join(',')})`).join(',');
    await client.query(`INSERT INTO ${copy.table} (${copy.cols.join(',')}) OVERRIDING SYSTEM VALUE VALUES ${values}`, copy.rows.flat());
    inserted += copy.rows.length;
    copy.rows = [];
  };
  for await (const line of rl) {
    if (copy) {
      if (line === '\\.') {
        await flushRows();
        copy = null;
        continue;
      }
      const row = line.split('\t').map(unescapeCopy);
      if (row.length !== copy.cols.length) throw new Error(`COPY ${copy.table}: ${row.length} полей вместо ${copy.cols.length}`);
      copy.rows.push(row);
      if (copy.rows.length * copy.cols.length >= 30000) await flushRows();
      continue;
    }
    if (/^\\(restrict|unrestrict)\b/.test(line)) continue; // мета-команды psql из pg_dump 16.10+
    if (line.startsWith('\\')) throw new Error(`неизвестная мета-команда psql: ${line.slice(0, 40)}`);
    const m = /^COPY (\S+) \((.*)\) FROM stdin;$/.exec(line);
    if (m) {
      await flushSql();
      copy = { table: m[1], cols: m[2].split(', '), rows: [] };
      continue;
    }
    sql.push(line);
  }
  if (copy) throw new Error(`обрыв файла внутри COPY ${copy.table}`);
  await flushSql();
  return inserted;
}

const dir = await mkdtemp(path.join(tmpdir(), 'yu-offsite-'));
const port = await freePort();
const password = randomBytes(16).toString('hex');
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: false, onLog: () => {} });
let code = 0;
try {
  await server.initialise();
  await server.start();
  const admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE DATABASE restore_check');
  await admin.end();
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'restore_check' });
  await client.connect();
  try {
    const inserted = await restore(client, sqlPath);
    const seen = [...(await client.query(COUNTS_SQL)).rows.map((r) => r.l), (await client.query(LEDGER_SQL)).rows[0].l];
    const expected = (await readFile(countsPath, 'utf8')).split('\n').filter(Boolean);
    const diff = [];
    const max = Math.max(seen.length, expected.length);
    for (let i = 0; i < max; i++) if (seen[i] !== expected[i]) diff.push(`  ждали «${expected[i] ?? '—'}», получили «${seen[i] ?? '—'}»`);
    const tables = seen.filter((l) => l.startsWith('rows ')).length;
    const rows = seen.filter((l) => l.startsWith('rows ')).reduce((s, l) => s + Number(l.split(' ')[2]), 0);
    if (diff.length) {
      console.error(`ОШИБКА: восстановленная база не совпала с ${path.basename(countsPath)}:\n${diff.slice(0, 20).join('\n')}`);
      code = 1;
    } else if (tables === 0) {
      console.error('ОШИБКА: в восстановленной базе нет таблиц');
      code = 1;
    } else {
      console.log(`восстановление ${path.basename(sqlPath)} проверено: таблиц ${tables}, записей ${rows} (вставлено ${inserted}), ${seen.at(-1)}`);
    }
  } finally {
    await client.end();
  }
} catch (e) {
  console.error(`ОШИБКА пробного восстановления: ${e instanceof Error ? e.message : String(e)}`.replaceAll(password, '***'));
  code = 1;
} finally {
  await server.stop().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
process.exitCode = code;
