// SQL-проверка «ни одной пары пересечений по активным единицам» (план §8) – запрос в tests/support/overlap-check.sql.
//
//   node tests/support/overlap-check.ts postgres://…/база
//     – один запрос к базе; печатает счётчики, код выхода 1 при пересечениях или двойных бронях.
//   OVERLAP_ADMIN_URL=postgres://…/postgres node tests/support/overlap-check.ts --watch
//     – наблюдатель для .github/workflows/races-nightly.yml. Тесты гонок создают базы t_* (tests/helpers/pg.ts) и удаляют их
//       в afterAll, поэтому «после прогона» проверять нечего: наблюдатель во время цикла раз в 300 мс обходит живые базы t_*
//       кластера и гоняет тот же SQL в каждой, где есть app.occupancy. По SIGTERM печатает сводку (баз проверено, замеров,
//       пропусков, пересечений). Код выхода 1 – нашлось пересечение или ни одной базы не проверено: пустая проверка – тоже провал.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const SQL = readFileSync(new URL('./overlap-check.sql', import.meta.url), 'utf8');
/** Замок на таблице (миграция в соседней транзакции) не должен подвешивать проверку. */
const OPTIONS = '-c lock_timeout=5000 -c statement_timeout=20000';

interface Row { name: string; n: number }

/** Базу могут снести DROP … WITH (FORCE) посреди запроса: сервер шлёт 57P01, pg поднимает событие error –
 *  без слушателя это падение процесса, со слушателем – отказ запроса, который ловит вызывающий. */
function client(url: string): pg.Client {
  const c = new pg.Client({ connectionString: url, options: OPTIONS });
  c.on('error', () => undefined);
  return c;
}

async function check(url: string): Promise<Row[]> {
  const c = client(url);
  await c.connect();
  try {
    return (await c.query<Row>(SQL)).rows;
  } finally {
    await c.end().catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function single(url: string): Promise<number> {
  const rows = await check(url);
  for (const r of rows) console.log(`${r.name}: ${r.n}`);
  const bad = rows.filter((r) => r.n > 0);
  if (bad.length) {
    console.error(`ПРОВАЛ: ${bad.map((r) => `${r.name}=${r.n}`).join(', ')}`);
    return 1;
  }
  console.log('ОК: пересечений занятости и двойных броней нет');
  return 0;
}

async function watch(adminUrl: string): Promise<number> {
  const admin = client(adminUrl);
  await admin.connect();
  const seen = new Set<string>();
  const bad = new Map<string, string>(); // база → что нашлось
  let samples = 0;
  let skipped = 0; // база удалена между списком и запросом, схемы ещё нет, сессия снята DROP … WITH (FORCE)
  let stop = false;
  const onStop = () => {
    stop = true;
  };
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  console.log(`наблюдатель пересечений: ${new Date().toISOString()}, кластер ${new URL(adminUrl).host}`);
  while (!stop) {
    const dbs = (
      await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE 't\\_%' AND NOT datistemplate AND datallowconn ORDER BY 1",
      )
    ).rows;
    for (const { datname } of dbs) {
      const url = new URL(adminUrl);
      url.pathname = `/${datname}`;
      try {
        const rows = await check(url.toString());
        samples++;
        seen.add(datname);
        const found = rows.filter((r) => r.n > 0);
        if (found.length && !bad.has(datname)) {
          const what = found.map((r) => `${r.name}=${r.n}`).join(', ');
          bad.set(datname, what);
          console.error(`${new Date().toISOString()} ПЕРЕСЕЧЕНИЕ в ${datname}: ${what}`);
        }
      } catch {
        skipped++;
      }
    }
    await sleep(300);
  }
  await admin.end().catch(() => undefined);
  console.log(`сводка: баз проверено ${seen.size}, замеров ${samples}, пропусков ${skipped}, баз с пересечениями ${bad.size}`);
  for (const [db, what] of bad) console.error(`  ${db}: ${what}`);
  if (bad.size) {
    console.error('ПРОВАЛ: нашлись пересечения по активным единицам');
    return 1;
  }
  if (seen.size === 0) {
    console.error('ПРОВАЛ: ни одной базы t_* с app.occupancy не проверено – цикл гонок не шёл или наблюдатель запущен не в тот кластер');
    return 1;
  }
  console.log('ОК: ни одной пары пересечений по активным единицам');
  return 0;
}

const [arg] = process.argv.slice(2);
let code: number;
if (arg === '--watch') {
  const admin = process.env.OVERLAP_ADMIN_URL ?? process.env.TEST_DATABASE_URL;
  if (!admin) throw new Error('--watch: нужен OVERLAP_ADMIN_URL (или TEST_DATABASE_URL) – админское подключение к кластеру');
  code = await watch(admin);
} else {
  const url = arg ?? process.env.OVERLAP_DATABASE_URL;
  if (!url) throw new Error('нужен адрес базы аргументом или в OVERLAP_DATABASE_URL, либо --watch');
  code = await single(url);
}
process.exitCode = code;
