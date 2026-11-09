// S4-131. Нагрузка отчётов на синтетике Q-93 (K24 §9, 17 §4.1): 20 филиалов × 12 месяцев прямым SQL (≈ 390 тыс. броней, ≈ 1 млн операций кассы),
// настоящий API по HTTP (buildServer на 127.0.0.1) и embedded-postgres во временной папке. Только локально – на стенд нагрузку НЕ давать.
//   0) без отчётов: базовый замер подтверждения брони клиентом (вход по OTP, удержание, подтверждение) в демо-филиале засева Э0+Э1;
//   1) план запросов: каждый отчёт сводки за месяц и каждый поиск по отдельности – прирост seq_scan по app.bookings (pg_stat_user_tables)
//      должен быть 0 («EXPLAIN без полного просмотра bookings»); соединения отчётов закрываются после запроса, чтобы счётчик дошёл до статистики;
//   2) под нагрузкой одновременно: сводка за месяц по сети (5 отчётов), поиск, два экспорта ≥ 100 000 строк (Владелец и Директор города)
//      и тот же поток подтверждений броней.
// Пороги плана: p95 сводки ≤ 5 с, поиска ≤ 2 с; p95 подтверждения во время отчётов не хуже базового более чем на 20%; полного просмотра bookings нет.
//
//   npm run load:reports
//   LOAD_BRANCHES=10 LOAD_BOOKINGS=60 npm run load:reports  – меньше объём для отладки
// Код выхода 1 – порог не держится, экспорт не готов или меньше 100 000 строк, ответ 5xx.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createFileStore } from '../../apps/api/src/core/files.ts';
import { addDays, localToInstant, systemClock, todayIn, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { branchIdsOfCities, timezonesOf } from '../../apps/api/src/modules/network/index.ts';
import { startExportRunner } from '../../apps/api/src/modules/reports/export.ts';
import { createReportsPool } from '../../apps/api/src/modules/reports/framework.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { migrateUp } from '../../db/migrate.ts';
import { DEMO_EMAIL_DOMAIN, seedDev } from '../../db/seed/dev.ts';
import { seedResources } from '../../db/seed/resources.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';

const BRANCHES = Number(process.env.LOAD_BRANCHES ?? 20);
const BOOKINGS = Number(process.env.LOAD_BOOKINGS ?? 120); // подтверждений в каждом замере (база и под нагрузкой)
const STREAMS = Number(process.env.LOAD_STREAMS ?? 4); // параллельных клиентов
const POOL = Number(process.env.LOAD_POOL ?? 10);
const SUMMARY_P95_MS = 5_000;
const SEARCH_P95_MS = 2_000;
const CONFIRM_SLOWDOWN = 1.2;
const EXPORT_MIN_ROWS = 100_000;
const PASSWORD = `Нагрузка-${randomUUID()}`;
const SYS = '00000000-0000-4000-8000-000000000000';
const SUMMARY = ['dashboard', 'bookings', 'utilization', 'finance', 'clients'] as const;
const SEARCHES = ['Фамилия12', '+79132000500', '0500', '150', 'расход'];

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50).toFixed(0)} мс p95=${pct(xs, 95).toFixed(0)} мс max=${Math.max(...xs).toFixed(0)} мс`;
const ipOf = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Синтетика одного филиала: 8 ПК и 2 VR-места, слоты 10–21 ч, ≈ 53 брони в день, посещение и оплата на завершённую, 100 расходов в день. */
async function seedBranch(q: pg.Client, branchId: string, tz: string, from: string, to: string, clients: string[], category: string): Promise<void> {
  await q.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, wd, '10:00', '22:00', '2020-01-01', $2 FROM generate_series(1, 7) wd`, [branchId, SYS]);
  await q.query(
    `WITH u AS (INSERT INTO app.occupancy_units (branch_id, code, name) SELECT $1, 'u' || n, 'Место ' || n FROM generate_series(1, 10) n RETURNING id, code),
          r AS (INSERT INTO app.resources (branch_id, resource_type, name) SELECT $1, CASE WHEN n <= 8 THEN 'pc' ELSE 'vr_seat' END, 'Место ' || n FROM generate_series(1, 10) n RETURNING id, name)
     INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT r.id, u.id, '2020-01-01' FROM r JOIN u ON u.code = 'u' || replace(r.name, 'Место ', '')`,
    [branchId],
  );
  await q.query('BEGIN');
  await q.query(
    `CREATE TEMP TABLE seed_bookings ON COMMIT DROP AS
     SELECT gen_random_uuid() AS id, r.id AS resource_id, ru.unit_id, s, abs(hashtext(r.id::text || s::text)) AS h
     FROM app.resources r JOIN app.resource_units ru ON ru.resource_id = r.id,
          generate_series($3::timestamp, $4::timestamp - interval '1 day', '1 day') AS day, generate_series(10, 21) AS hour,
          LATERAL (SELECT ((day + make_interval(hours => hour)) AT TIME ZONE $2) AS s) x
     WHERE r.branch_id = $1 AND abs(hashtext(r.id::text || day::text || hour)) % 9 < 4`,
    [branchId, tz, from, to],
  );
  await q.query(
    `INSERT INTO app.bookings (id, checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status, created_at, cancelled_at, cancel_comment)
     SELECT id, gen_random_uuid(), $1, ($2::uuid[])[1 + (h % array_length($2::uuid[], 1))], resource_id, tstzrange(s, s + interval '1 hour', '[)'), 30000 + h % 50000, 'crm', 'staff',
            CASE WHEN h % 100 < 70 THEN 'completed' WHEN h % 100 < 80 THEN 'no_show' WHEN h % 100 < 90 THEN 'cancelled_by_client' WHEN h % 100 < 95 THEN 'cancelled_by_club' ELSE 'confirmed' END,
            s - interval '2 days', CASE WHEN h % 100 BETWEEN 80 AND 94 THEN s - interval '1 hour' END, CASE WHEN h % 100 BETWEEN 80 AND 94 THEN 'отмена' END
     FROM seed_bookings`,
    [branchId, clients],
  );
  await q.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     SELECT id, 1, resource_id, tstzrange(s, s + interval '1 hour', '[)'), $1, ARRAY[unit_id], '{}', 30000, '{}', 'staff' FROM seed_bookings`,
    [tz],
  );
  await q.query(
    `INSERT INTO app.occupancy (unit_id, branch_id, period, source_type, source_id, booking_version)
     SELECT unit_id, $1, tstzrange(s, s + interval '1 hour', '[)'), 'booking', id, 1 FROM seed_bookings WHERE h % 100 NOT BETWEEN 80 AND 94`,
    [branchId],
  );
  await q.query(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) SELECT b.id, b.branch_id, b.client_id, lower(b.period), $2 FROM app.bookings b WHERE b.branch_id = $1 AND b.status = 'completed'`, [branchId, SYS]);
  await q.query(`INSERT INTO app.no_shows (booking_id, branch_id, client_id, marked_at, marked_by) SELECT b.id, b.branch_id, b.client_id, upper(b.period), $2 FROM app.bookings b WHERE b.branch_id = $1 AND b.status = 'no_show'`, [branchId, SYS]);
  await q.query(
    `INSERT INTO app.payment_sessions (booking_id, branch_id, client_id, amount_due_kop, booking_version, status)
     SELECT b.id, b.branch_id, b.client_id, b.price_kop, 1, 'paid' FROM app.bookings b WHERE b.branch_id = $1 AND b.status = 'completed'`,
    [branchId],
  );
  await q.query(
    `WITH p AS (
       INSERT INTO app.payments (session_id, attempt, total_kop, topup_rule_snapshot, recorded_by, recorded_at)
       SELECT b.id, 1, b.price_kop, false, $2, lower(b.period) FROM app.bookings b WHERE b.branch_id = $1 AND b.status = 'completed'
       RETURNING id, total_kop, recorded_at),
     f AS (
       INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, source, ref_type, ref_id, occurred_at, author_type, posting_id)
       SELECT $1, 'income', CASE WHEN p.total_kop % 2 = 0 THEN 'cash' ELSE 'noncash' END, CASE WHEN p.total_kop % 2 = 0 THEN 'cash' ELSE 'card' END, 'in', p.total_kop, 'session', 'payment', p.id, p.recorded_at, 'system', gen_random_uuid()
       FROM p RETURNING id, ref_id, method, amount_kop, posting_id)
     INSERT INTO app.payment_lines (payment_id, line_no, method, amount_kop, ledger_posting_id, finance_operation_id)
     SELECT f.ref_id, 1, f.method, f.amount_kop, f.posting_id, f.id FROM f`,
    [branchId, SYS],
  );
  await q.query(
    `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, category_id, comment, occurred_at, author_type, posting_id)
     SELECT $1, 'expense', 'cash', 'cash', 'out', 500 + n, $2, 'расход ' || day::date, (day + make_interval(mins => 600 + n * 7)) AT TIME ZONE $5, 'system', gen_random_uuid()
     FROM generate_series($3::timestamp, $4::timestamp - interval '1 day', '1 day') AS day, generate_series(1, 100) n`,
    [branchId, category, from, to, tz],
  );
  await q.query('COMMIT');
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yu-load-reports-'));
  const exportDir = await mkdtemp(path.join(tmpdir(), 'yu-load-exports-'));
  const password = randomBytes(12).toString('hex');
  const reportsPassword = randomBytes(12).toString('hex');
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const pgServer = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: false, postgresFlags: ['-c', 'max_connections=300'], onLog: () => undefined, onError: () => undefined });
  await pgServer.initialise();
  await pgServer.start();
  const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let pool: pg.Pool | undefined;
  let reports: pg.Pool | undefined;
  let workerReports: pg.Pool | undefined;
  let probeReports: pg.Pool | undefined;
  let sql: pg.Client | undefined;
  let app: ReturnType<typeof buildServer> | undefined;
  let probe: ReturnType<typeof buildServer> | undefined;
  let runner: ReturnType<typeof startExportRunner> | undefined;
  let failed = false;
  const fail = (msg: string) => {
    failed = true;
    console.error(`ПРОВАЛ: ${msg}`);
  };
  try {
    await admin.query(`CREATE ROLE yu_app NOLOGIN`);
    await admin.query(`CREATE ROLE yu_reports LOGIN PASSWORD '${reportsPassword}'`);
    await admin.query(`ALTER ROLE yu_reports SET default_transaction_read_only = on`);
    await admin.query(`CREATE DATABASE yu_load`);
    await admin.end();
    const dbUrl = adminUrl.replace(/\/postgres$/, '/yu_load');
    const reportsUrl = `postgres://yu_reports:${reportsPassword}@127.0.0.1:${port}/yu_load`;
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
    await migrateUp(sql);
    pool = new pg.Pool({ connectionString: dbUrl, options: '-c role=yu_app -c search_path=app,journal', max: POOL });
    pool.on('error', (err) => console.error('пул yu_app:', err.message));
    // как на сервере: у API свой пул yu_reports (3), у воркера экспорта – свой (worker.ts)
    reports = createReportsPool(reportsUrl);
    workerReports = createReportsPool(reportsUrl);

    // ---- синтетика Q-93 (не в замере): 12 полных месяцев до начала текущего, филиалы в 4 городах, город A – для Директора
    const t0 = performance.now();
    const now = new Date();
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1));
    const monthFrom = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
    const monthQs = `from=${iso(monthFrom)}&to=${iso(addDaysUtc(to, -1))}`;
    const category = (await sql.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее'`)).rows[0]!.id;
    const clients = (
      await sql.query<{ id: string }>(
        `INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type, registered_at, created_at)
         SELECT '+7913' || (2000000 + n)::text, 'Имя' || n, 'Фамилия' || n, 'active', 'system', $1::timestamptz + (n % 365) * interval '1 day', $1::timestamptz + (n % 365) * interval '1 day'
         FROM generate_series(1, 20000) n RETURNING id`,
        [from],
      )
    ).rows.map((r) => r.id);
    const zones = ['Asia/Novosibirsk', 'Europe/Moscow', 'Asia/Yekaterinburg', 'Europe/Kaliningrad'];
    const cityIds: string[] = [];
    for (const tz of zones) cityIds.push(await createTestCity(sql, { timezone: tz }));
    const synthetic: Array<{ id: string; city: number }> = [];
    for (let i = 0; i < BRANCHES; i++) {
      const city = i < Math.ceil(BRANCHES * 0.35) ? 0 : 1 + (i % 3);
      const b = await createTestBranch(sql, { cityId: cityIds[city]!, timezone: zones[city]! });
      await seedBranch(sql, b.id, zones[city]!, iso(from), iso(to), clients, category);
      synthetic.push({ id: b.id, city });
      process.stdout.write(`\rсинтетика: филиал ${i + 1}/${BRANCHES}, ${((performance.now() - t0) / 1000).toFixed(0)} с`);
    }
    await sql.query('ANALYZE');
    const vol = (await sql.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM app.bookings) bookings, (SELECT count(*) FROM app.visits) visits, (SELECT count(*) FROM journal.finance_operations) finance`,
    )).rows[0]!;
    console.log(`\nОбъём: ${JSON.stringify(vol)} за ${((performance.now() - t0) / 1000).toFixed(0)} с; период ${iso(from)}…${iso(addDaysUtc(to, -1))}, сводка за ${iso(monthFrom)}`);
    // демо-сеть для живых броней (засев Э0+Э1) и сотрудники
    await seedDev(pool, { env: { APP_ENV: 'test' }, password: PASSWORD });
    const seeded = await seedResources(pool, { env: { APP_ENV: 'test' } });
    const directorEmail = 'director-a@load.test';
    const director = (await sql.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Д', 'Города', $1, 'director', $2) RETURNING id`, [directorEmail, await hashPassword(PASSWORD)])).rows[0]!.id;
    await sql.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, valid_from, created_by) VALUES ($1, 'city', $2, '2020-01-01', $1)`, [director, cityIds[0]]);

    // ---- сервер: сотрудники, клиенты (OTP через тестовый адаптер), отчёты и экспорт
    const codes = new Map<string, string>();
    const sms = createDevSmsSender('dev');
    const smsCapture = { send: async (m: { phoneE164: string; text: string; idempotencyKey: string }) => (codes.set(m.phoneE164, /(\d{6})/.exec(m.text)![1]!), sms.send(m)) };
    const store = createFileStore({ root: exportDir });
    const staffAuth = staffAuthConfig(randomBytes(32).toString('hex'));
    const config = loadConfig({ LOG_LEVEL: 'silent', APP_ENV: 'dev' });
    app = buildServer(config, { staff: { pool, auth: staffAuth }, clients: { pool, auth: clientAuthConfig(randomBytes(32).toString('hex')), sms: smsCapture }, reports: { pool: reports, exportStore: store } });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    // второй экземпляр – для замера планов: соединение отчёта закрывается сразу, статистика seq_scan доходит без 10 с ожидания
    probeReports = new pg.Pool({ connectionString: reportsUrl, options: '-c search_path=app', max: 1, idleTimeoutMillis: 1 });
    probeReports.on('error', () => undefined);
    probe = buildServer(config, { staff: { pool, auth: staffAuth }, reports: { pool: probeReports } });
    const probeBase = await probe.listen({ host: '127.0.0.1', port: 0 });

    const login = async (email: string) => {
      const r = await fetch(`${base}/api/crm/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
      if (r.status !== 200) throw new Error(`вход ${email}: ${r.status} ${await r.text()}`);
      return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    };
    const ownerCookie = await login(`owner@${DEMO_EMAIL_DOMAIN}`);
    const directorCookie = await login(directorEmail);
    const crm = async (method: string, url: string, cookie: string, body?: unknown, at = base) => {
      const t = performance.now();
      const r = await fetch(`${at}/api/crm/v1${url}`, { method, headers: { cookie, 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await r.text();
      return { status: r.status, text, ms: performance.now() - t };
    };

    // ---- клиенты для броней: 2 × BOOKINGS, вход по OTP пачками (не в замере)
    const pub = (i: number, method: string, url: string, body: unknown, cookie?: string) =>
      fetch(`${base}/api/public/v1${url}`, { method, headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-forwarded-for': ipOf(i + 1), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const cookies: string[] = [];
    for (let k = 0; k < 2 * BOOKINGS; k += 20) {
      cookies.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(20, 2 * BOOKINGS - k) }, async (_, j) => {
            const i = k + j;
            const phone = `+7914${String(1_000_000 + i).padStart(7, '0')}`;
            const req = await pub(i, 'POST', '/auth/otp/request', { phone, purpose: 'login' });
            const { challengeId } = (await req.json()) as { challengeId: string };
            const ver = await pub(i, 'POST', '/auth/otp/verify', { challengeId, code: codes.get(phone), consents: { pdProcessing: true } });
            const token = /yu_client=([^;]+)/.exec(ver.headers.get('set-cookie') ?? '')?.[1];
            if (!token) throw new Error(`нет куки клиента ${i}: ${ver.status}`);
            return `yu_client=${token}`;
          }),
        )),
      );
    }
    const krasny = (await sql.query<{ id: string; timezone: TimeZone }>(`SELECT id, timezone FROM app.branches WHERE code = 'demo-nsk-krasny'`)).rows[0]!;
    const pcs = seeded.branches['demo-nsk-krasny']!.pcs;
    const slotsPerDay = pcs.length * 12;
    /** Бронь i: свой ПК и час, дни – начиная с послезавтра; клиент – свой, удержание и подтверждение. Возвращает время подтверждения. */
    const book = async (i: number): Promise<{ ms: number; status: number }> => {
      const day = addDays(todayIn(systemClock, krasny.timezone), 2 + Math.floor(i / slotsPerDay));
      const hour = 10 + (Math.floor(i / pcs.length) % 12);
      const start = localToInstant(day, `${String(hour).padStart(2, '0')}:00` as LocalTime, krasny.timezone);
      const h = await pub(i, 'POST', '/holds', { branchId: krasny.id, items: [{ resourceId: pcs[i % pcs.length], start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() }] }, cookies[i]);
      const hb = (await h.json()) as { id?: string };
      if (h.status !== 201) return { ms: NaN, status: h.status };
      const t = performance.now();
      const c = await pub(i, 'POST', `/holds/${hb.id}/confirm`, {}, cookies[i]);
      await c.text();
      return { ms: performance.now() - t, status: c.status };
    };
    const stream = async (offset: number): Promise<Array<{ ms: number; status: number }>> => {
      const out: Array<{ ms: number; status: number }> = [];
      let next = 0;
      await Promise.all(Array.from({ length: STREAMS }, async () => {
        while (next < BOOKINGS) out.push(await book(offset + next++));
      }));
      return out;
    };

    // ---- 0) базовый замер подтверждения
    const baseline = await stream(0);
    const baseMs = baseline.filter((x) => x.status === 201).map((x) => x.ms);
    console.log(`0) подтверждение брони без отчётов (${STREAMS} потока): ${fmt(baseMs)}; не 201: ${baseline.filter((x) => x.status !== 201).length}`);

    // ---- 1) планы: прирост seq_scan по app.bookings на каждый запрос, по одному
    const seqScan = async () => {
      await sql!.query('SELECT pg_stat_clear_snapshot()');
      return Number((await sql!.query<{ n: string }>(`SELECT seq_scan n FROM pg_stat_user_tables WHERE relid = 'app.bookings'::regclass`)).rows[0]!.n);
    };
    const fullScans: string[] = [];
    for (const url of [...SUMMARY.map((r) => `/reports/${r}?${monthQs}`), ...SEARCHES.map((s) => `/search?q=${encodeURIComponent(s)}`)]) {
      const before = await seqScan();
      const r = await crm('GET', url, ownerCookie, undefined, probeBase);
      await sleep(600); // соединение пула закрылось – статистика backend сброшена
      const delta = (await seqScan()) - before;
      console.log(`1) ${url.split('?')[0]}${url.startsWith('/search') ? ` «${decodeURIComponent(url.split('=')[1]!)}»` : ''}: ${r.status}, ${r.ms.toFixed(0)} мс, seq_scan bookings +${delta}`);
      if (r.status !== 200) fail(`${url}: ${r.status} ${r.text.slice(0, 200)}`);
      if (delta > 0) fullScans.push(url.split('?')[0]!);
    }

    // ---- 2) под нагрузкой: экспорты, сводки, поиск и подтверждения одновременно
    const perDay = Number(vol.bookings) / 365;
    const ownerFrom = addDaysUtc(to, -Math.ceil((EXPORT_MIN_ROWS * 1.05) / perDay));
    const exportReq = [
      { cookie: ownerCookie, body: { report: 'bookings', format: 'csv', detail: true, params: { from: iso(ownerFrom), to: iso(addDaysUtc(to, -1)), metric: 'created' } } },
      { cookie: directorCookie, body: { report: 'bookings', format: 'xlsx', detail: true, params: { from: iso(from), to: iso(addDaysUtc(to, -1)), metric: 'created' } } },
    ];
    runner = startExportRunner({ pool, reports: workerReports, store, network: { branchesOfCities: branchIdsOfCities, timezonesOf }, log: (e) => console.error('экспорт:', e) }, { intervalMs: 500 });
    const tLoad = performance.now();
    const jobs: string[] = [];
    for (const e of exportReq) {
      const r = await crm('POST', '/reports/exports', e.cookie, e.body);
      if (r.status !== 202) throw new Error(`экспорт: ${r.status} ${r.text}`);
      jobs.push((JSON.parse(r.text) as { id: string }).id);
    }
    const waitExports = (async () => {
      for (;;) {
        const r = await sql!.query<{ id: string; status: string; rows: number | null; started_at: Date | null; finished_at: Date | null; error_code: string | null }>(
          `SELECT id, status, rows, started_at, finished_at, error_code FROM app.report_exports WHERE id = ANY($1::uuid[])`,
          [jobs],
        );
        if (r.rows.every((x) => !['queued', 'running'].includes(x.status))) return r.rows;
        await sleep(500);
      }
    })();
    let exportsDone = false;
    void waitExports.then(() => (exportsDone = true));
    const summaryMs: number[] = [];
    const searchMs: number[] = [];
    const errors: string[] = [];
    const reportLoop = async (worker: number) => {
      for (let round = 0; round < 3 || !exportsDone; round++) {
        const name = SUMMARY[(round + worker) % SUMMARY.length]!;
        const r = await crm('GET', `/reports/${name}?${monthQs}`, ownerCookie);
        if (r.status !== 200) errors.push(`${name} ${r.status} ${r.text.slice(0, 120)}`);
        else summaryMs.push(r.ms);
      }
    };
    const searchLoop = async () => {
      for (let round = 0; round < 10 || !exportsDone; round++) {
        const r = await crm('GET', `/search?q=${encodeURIComponent(SEARCHES[round % SEARCHES.length]!)}`, ownerCookie);
        if (r.status !== 200) errors.push(`search ${r.status} ${r.text.slice(0, 120)}`);
        else searchMs.push(r.ms);
        await sleep(200);
      }
    };
    const [loaded] = await Promise.all([stream(BOOKINGS), reportLoop(0), reportLoop(1), searchLoop()]);
    const exportRows = await waitExports;
    const loadMs = performance.now() - tLoad;
    const loadConfirm = loaded.filter((x) => x.status === 201).map((x) => x.ms);
    console.log(`2) под нагрузкой ${(loadMs / 1000).toFixed(0)} с:`);
    console.log(`   сводка за месяц по сети: ${fmt(summaryMs)}`);
    console.log(`   поиск: ${fmt(searchMs)}`);
    for (const e of exportRows) {
      const took = e.started_at && e.finished_at ? `${((e.finished_at.getTime() - e.started_at.getTime()) / 1000).toFixed(0)} с` : '–';
      console.log(`   экспорт ${e.id.slice(0, 8)}: ${e.status}${e.error_code ? ` ${e.error_code}` : ''}, строк ${e.rows}, расчёт ${took}`);
    }
    console.log(`   подтверждение брони: ${fmt(loadConfirm)}; не 201: ${loaded.filter((x) => x.status !== 201).length}`);

    const p95Base = pct(baseMs, 95);
    const p95Load = pct(loadConfirm, 95);
    const ratio = p95Load / p95Base;
    console.log(`Итог: p95 сводки ${pct(summaryMs, 95).toFixed(0)} мс (порог ${SUMMARY_P95_MS}), p95 поиска ${pct(searchMs, 95).toFixed(0)} мс (порог ${SEARCH_P95_MS}), ` +
      `p95 подтверждения ${p95Base.toFixed(0)} → ${p95Load.toFixed(0)} мс (×${ratio.toFixed(2)}, порог ×${CONFIRM_SLOWDOWN}), полный просмотр bookings: ${fullScans.length ? fullScans.join(', ') : 'нет'}`);
    if (pct(summaryMs, 95) > SUMMARY_P95_MS) fail(`p95 сводки ${pct(summaryMs, 95).toFixed(0)} мс > ${SUMMARY_P95_MS}`);
    if (pct(searchMs, 95) > SEARCH_P95_MS) fail(`p95 поиска ${pct(searchMs, 95).toFixed(0)} мс > ${SEARCH_P95_MS}`);
    if (!(ratio <= CONFIRM_SLOWDOWN)) fail(`p95 подтверждения под отчётами ×${ratio.toFixed(2)} > ×${CONFIRM_SLOWDOWN}`);
    if (fullScans.length) fail(`полный просмотр bookings: ${fullScans.join(', ')}`);
    if (errors.length) fail(`ошибки отчётов: ${errors.slice(0, 5).join('; ')}`);
    for (const e of exportRows) if (e.status !== 'ready' || (e.rows ?? 0) < EXPORT_MIN_ROWS) fail(`экспорт ${e.id}: ${e.status}, строк ${e.rows} (нужно ≥ ${EXPORT_MIN_ROWS})`);
    if ([...baseline, ...loaded].some((x) => x.status >= 500)) fail('ответ 5xx на брони');
    if (!failed) console.log('ОК: пороги S4-131 держатся');
  } finally {
    await runner?.stop();
    await app?.close();
    await probe?.close();
    await reports?.end();
    await workerReports?.end();
    await probeReports?.end();
    await pool?.end();
    await sql?.end();
    await pgServer.stop();
    await rm(dir, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
