// S2-83. Нагрузка гонок денег (по образцу booking-race.ts): три гонки на настоящем API по HTTP (buildServer на 127.0.0.1)
// и embedded-postgres во временной папке. Только локально – на стенд нагрузку НЕ давать (общий сервер).
//   1) LOAD_PAYMENTS (100) параллельных оплат одной брони с разными Idempotency-Key (две вкладки, двойной клик);
//   2) двойное погашение: LOAD_CERT_PAIRS (20) сертификатов с остатком ровно на один сеанс, по две брони на каждый – обе
//      оплаты одним сертификатом одновременно;
//   3) списание баллов против штрафа: LOAD_POINT_CLIENTS (20) клиентов с 60 баллами ровно на час ПК – оплата баллами
//      одной брони параллельно с обработчиком штрафа за неявку другой (processEvent, как worker).
// После прогона – запросы к базе: ноль второго живого платежа, ноль отрицательных остатков сертификатов, остаток
// сертификата = номинал − погашения, Σ партий = max(0, баланс), баланс = Σ записей K3 по всем счетам, касса = операции,
// баланс баллов не ниже −50. Печатает p50/p95 по каждой гонке.
//
//   npm run load:money                                 – пул API 10 (как depsFromConfig на сервере)
//   LOAD_PAYMENTS=300 LOAD_POOL=20 npm run load:money
// Код выхода 1 – нарушен инвариант, ответ 5xx или гонка не дала ни одного успеха.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { loadConfig } from '../../apps/api/src/config.ts';
import { processEvent } from '../../apps/api/src/core/outbox.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { registerPaymentMethod } from '../../apps/api/src/modules/finance/methods.ts';
import { PENALTY_HANDLERS, registerPenaltyHandlers } from '../../apps/api/src/modules/loyalty/penalty.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { migrateUp } from '../../db/migrate.ts';

const PAYMENTS = Number(process.env.LOAD_PAYMENTS ?? 100);
const CERT_PAIRS = Number(process.env.LOAD_CERT_PAIRS ?? 20);
const POINT_CLIENTS = Number(process.env.LOAD_POINT_CLIENTS ?? 20);
const POOL = Number(process.env.LOAD_POOL ?? 10);
const SYS = '00000000-0000-0000-0000-000000000001';
const PEPPER = randomBytes(24).toString('hex');
const PASSWORD = `Нагрузка-${randomUUID()}`;
const PRICE = 40_000; // час ПК: 200 ₽ за 30 мин
// 16.11 по Новосибирску: брони создаются в 09:00; в 11:05 – неявка на 10:00 уже можно, приход на 11:30 – уже можно (Q-101)
const T_CREATE = Date.parse('2026-11-16T02:00:00Z');
const T_RACE = Date.parse('2026-11-16T04:05:00Z');
const EARLY = { start: '2026-11-16T03:00:00Z', end: '2026-11-16T04:00:00Z' };
const MAIN = { start: '2026-11-16T04:30:00Z', end: '2026-11-16T05:30:00Z' };

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50).toFixed(0)} мс p95=${pct(xs, 95).toFixed(0)} мс max=${Math.max(...xs).toFixed(0)} мс`;
const tally = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yu-load-money-'));
  const password = randomBytes(12).toString('hex');
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const pgServer = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: false, postgresFlags: ['-c', 'max_connections=300'], onLog: () => {} });
  await pgServer.initialise();
  await pgServer.start();
  const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let pool: pg.Pool | undefined;
  let app: ReturnType<typeof buildServer> | undefined;
  let sql: pg.Client | undefined;
  let failed = false;
  try {
    await admin.query(`CREATE ROLE yu_app NOLOGIN`);
    await admin.query(`CREATE ROLE yu_reports NOLOGIN`); // без неё миграция 0406 останавливается
    await admin.query(`CREATE DATABASE yu_load`);
    await admin.end();
    const dbUrl = adminUrl.replace(/\/postgres$/, '/yu_load');
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
    await migrateUp(sql);
    const one = async <T = { id: string }>(text: string, params: unknown[] = []) => (await sql!.query(text, params)).rows[0] as T;
    pool = new pg.Pool({ connectionString: dbUrl, options: '-c role=yu_app -c search_path=app,journal', max: POOL });
    let now = T_CREATE;
    const clock: Clock = { now: () => new Date(now) };

    // ---- сеть: филиал, часы, тариф ПК, ресурсы (по одному ПК на бронь – брони не пересекаются)
    const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
    const branchId = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'Красный', 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
    await sql.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchId, SYS]);
    await sql.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 20000, '2026-01-01', 'active', $2)`, [branchId, SYS]);
    await sql.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('loyalty.penalties_from', 'network', '"2026-11-01T00:00:00.000Z"', '2026-01-01', $1)`, [SYS]);
    const pcCount = 1 + CERT_PAIRS * 2 + POINT_CLIENTS;
    const pcs = (await sql.query<{ id: string }>(
      `WITH u AS (INSERT INTO app.occupancy_units (branch_id, code, name) SELECT $1, 'PC' || g, 'PC' || g FROM generate_series(1, $2) g RETURNING id, code),
            r AS (INSERT INTO app.resources (branch_id, resource_type, name) SELECT $1, 'pc', code FROM u RETURNING id, name)
       INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT r.id, u.id, '2026-01-01' FROM r JOIN u ON u.code = r.name RETURNING resource_id AS id`,
      [branchId, pcCount],
    )).rows.map((r) => r.id);
    await sql.query(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'Л', 'owner@yu.test', 'owner', $1)`, [await hashPassword(PASSWORD)]);
    const newClient = async (i: number) => (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(3_000_000 + i).padStart(7, '0')}`])).id;

    registerPaymentMethod(createCertificatePaymentMethod({ pepper: PEPPER }));
    registerPenaltyHandlers({ bookings: paymentBookingProvider, clock });
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent', APP_ENV: 'dev' }), { staff: { pool, auth: staffAuthConfig(randomBytes(32).toString('hex')), clock }, certificates: { pepper: PEPPER } });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    let cookie = '';
    const login = async () => {
      const r = await fetch(`${base}/api/crm/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@yu.test', password: PASSWORD }) });
      if (r.status !== 200) throw new Error(`вход: ${r.status} ${await r.text()}`);
      cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    };
    const api = async (method: string, url: string, body?: unknown) => {
      const t0 = performance.now();
      const r = await fetch(`${base}/api/crm/v1${url}`, {
        method,
        headers: { cookie, 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: { code: string } };
      return { status: r.status, json, ms: performance.now() - t0, code: r.status < 300 ? 'ok' : (json.error?.code ?? String(r.status)) };
    };
    const must = async (method: string, url: string, body?: unknown) => {
      const r = await api(method, url, body);
      if (r.status >= 300) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
      return r.json as Record<string, unknown> & { id: string; rowVersion: number };
    };
    const book = async (clientId: string, resourceId: string, at: { start: string; end: string }) =>
      (await must('POST', `/branches/${branchId}/bookings`, { resourceId, ...at, client: { clientId } })).id;
    const rowVersion = async (id: string) => (await must('GET', `/bookings/${id}`)).rowVersion;

    // ---- подготовка (не в замере): брони в 09:00, сертификаты, баллы; в 11:05 – приходы и неявки
    await login();
    let pc = 0;
    const payTarget = await book(await newClient(0), pcs[pc++]!, MAIN);
    const certs: Array<{ number: string; pin: string; id: string; bookings: [string, string] }> = [];
    for (let i = 0; i < CERT_PAIRS; i++) {
      const s = (await must('POST', `/branches/${branchId}/certificates`, { nominalKop: PRICE, method: 'cash' })) as unknown as { certificate: { id: string; number: string }; pin: string };
      const pair: [string, string] = [await book(await newClient(100 + 2 * i), pcs[pc++]!, MAIN), await book(await newClient(101 + 2 * i), pcs[pc++]!, MAIN)];
      certs.push({ id: s.certificate.id, number: s.certificate.number, pin: s.pin, bookings: pair });
    }
    const pointClients: Array<{ clientId: string; paid: string; missed: string }> = [];
    for (let i = 0; i < POINT_CLIENTS; i++) {
      const clientId = await newClient(500 + i);
      await must('POST', `/clients/${clientId}/loyalty/adjust`, { deltaCenti: 6_000, reason: 'нагрузка: 60 баллов' });
      const resource = pcs[pc++]!;
      pointClients.push({ clientId, missed: await book(clientId, resource, EARLY), paid: await book(clientId, resource, MAIN) });
    }
    now = T_RACE;
    await login();
    const arrivals = [payTarget, ...certs.flatMap((c) => c.bookings), ...pointClients.map((p) => p.paid)];
    for (const id of arrivals) await must('POST', `/bookings/${id}/arrive`, { rowVersion: await rowVersion(id) });
    const penaltyEvents = new Map<string, string>();
    for (const p of pointClients) {
      await must('POST', `/bookings/${p.missed}/no-show`, { rowVersion: await rowVersion(p.missed) });
      penaltyEvents.set(p.clientId, (await one(`SELECT id FROM app.outbox_events WHERE event_type = 'no_show.marked' AND payload ->> 'bookingId' = $1`, [p.missed])).id);
    }
    console.log(`Подготовка: ${arrivals.length} приходов, ${certs.length} сертификатов по ${PRICE / 100} ₽, ${pointClients.length} клиентов по 60 баллов; пул API ${POOL}`);

    // ---- гонка 1: N оплат одной брони
    const t1 = performance.now();
    const r1 = await Promise.all(Array.from({ length: PAYMENTS }, (_, i) => api('POST', `/bookings/${payTarget}/payment`, { lines: [{ method: i % 2 ? 'cash' : 'card', amountKop: PRICE }] })));
    const wall1 = performance.now() - t1;
    console.log(`Гонка 1: ${PAYMENTS} оплат одной брони за ${wall1.toFixed(0)} мс – исходы ${JSON.stringify(tally(r1.map((r) => `${r.status} ${r.code}`)))}; ${fmt(r1.map((r) => r.ms))}`);

    // ---- гонка 2: двойное погашение
    const t2 = performance.now();
    const r2 = await Promise.all(certs.flatMap((c) => c.bookings.map((b) => api('POST', `/bookings/${b}/payment`, { lines: [{ method: 'certificate', amountKop: PRICE, certificate: { number: c.number, pin: c.pin } }] }))));
    const wall2 = performance.now() - t2;
    console.log(`Гонка 2: ${certs.length} сертификатов × 2 погашения за ${wall2.toFixed(0)} мс – исходы ${JSON.stringify(tally(r2.map((r) => `${r.status} ${r.code}`)))}; ${fmt(r2.map((r) => r.ms))}`);

    // ---- гонка 3: оплата баллами против штрафа
    const t3 = performance.now();
    const r3 = await Promise.all(
      pointClients.map(async (p) => {
        const [payRes, penalty] = await Promise.all([
          api('POST', `/bookings/${p.paid}/payment`, { lines: [{ method: 'points', amountKop: PRICE }] }),
          (async () => {
            // обработчик в процессе быстрее HTTP: случайная задержка 0–150 мс, чтобы выигрывали обе стороны
            await new Promise((r) => setTimeout(r, Math.random() * 150));
            const s = performance.now();
            const out = await processEvent(pool!, PENALTY_HANDLERS.marked, penaltyEvents.get(p.clientId)!, clock.now()).then((x) => x, (e: unknown) => `ошибка ${(e as Error).message}`);
            return { out, ms: performance.now() - s };
          })(),
        ]);
        return { pay: payRes, penalty };
      }),
    );
    const wall3 = performance.now() - t3;
    console.log(`Гонка 3: ${pointClients.length} × (оплата баллами ‖ штраф) за ${wall3.toFixed(0)} мс – оплата ${JSON.stringify(tally(r3.map((r) => `${r.pay.status} ${r.pay.code}`)))}, штраф ${JSON.stringify(tally(r3.map((r) => String(r.penalty.out))))}`);
    console.log(`  оплата баллами: ${fmt(r3.map((r) => r.pay.ms))}; штраф: ${fmt(r3.map((r) => r.penalty.ms))}`);

    // ---- проверка базой
    const n = async (text: string, params: unknown[] = []) => Number((await one<{ n: string }>(text, params)).n);
    const checks = {
      'второй живой платёж (сеансов)': await n(`SELECT count(*) AS n FROM (SELECT session_id FROM app.payments WHERE status IN ('active','partially_refunded') GROUP BY session_id HAVING count(*) > 1) x`),
      'платежей у брони гонки 1 сверх одного': (await n(`SELECT count(*) AS n FROM app.payments WHERE session_id = $1`, [payTarget])) - 1,
      'операций кассы по брони гонки 1 сверх одной': (await n(`SELECT count(*) AS n FROM journal.finance_operations o JOIN app.payments p ON p.id = o.ref_id WHERE o.source = 'session' AND p.session_id = $1`, [payTarget])) - 1,
      'отрицательных остатков сертификатов': await n(`SELECT count(*) AS n FROM app.ledger_accounts WHERE kind = 'certificate' AND balance < 0`),
      'сертификатов с двумя живыми погашениями': await n(`SELECT count(*) AS n FROM (SELECT certificate_id FROM app.certificate_redemptions WHERE status = 'active' GROUP BY certificate_id HAVING count(*) > 1) x`),
      'остаток сертификата ≠ номинал − погашения': await n(
        `SELECT count(*) AS n FROM app.certificates c JOIN app.ledger_accounts la ON la.id = c.ledger_account_id
         WHERE la.balance <> c.nominal_kop - coalesce((SELECT sum(amount_kop) FROM app.certificate_redemptions r WHERE r.certificate_id = c.id AND r.status = 'active'), 0)`,
      ),
      'Σ партий ≠ max(0, баланс)': await n(
        `SELECT count(*) AS n FROM (SELECT a.owner_id FROM app.ledger_accounts a LEFT JOIN app.loyalty_batches b ON b.client_id = a.owner_id AND b.status = 'active'
         WHERE a.kind = 'loyalty_client' GROUP BY a.owner_id, a.balance HAVING coalesce(sum(b.remaining_centi), 0) <> greatest(0, a.balance)) x`,
      ),
      'баланс ≠ Σ записей K3 (все счета)': await n(
        `SELECT count(*) AS n FROM (SELECT a.id FROM app.ledger_accounts a LEFT JOIN journal.ledger_entries e ON e.account_id = a.id GROUP BY a.id HAVING a.balance <> coalesce(sum(e.amount), 0)) x`,
      ),
      'баллы ниже −50': await n(`SELECT count(*) AS n FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND balance < -5000`),
      'касса ≠ операции': await n(
        `SELECT count(*) AS n FROM app.ledger_accounts a WHERE a.kind IN ('cash_branch','cash_branch_noncash') AND a.balance <> coalesce((SELECT sum(CASE WHEN o.direction = 'in' THEN o.amount_kop ELSE -o.amount_kop END)
         FROM journal.finance_operations o WHERE o.branch_id = a.owner_id AND o.place = CASE a.kind WHEN 'cash_branch' THEN 'cash' ELSE 'noncash' END), 0)`,
      ),
      'штрафов не записано': POINT_CLIENTS - (await n(`SELECT count(*) AS n FROM app.loyalty_penalties WHERE booking_id = ANY($1::uuid[])`, [pointClients.map((p) => p.missed)])),
    };
    const pointsOutcome = tally(
      (await sql.query<{ balance: string }>(`SELECT balance FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_id = ANY($1::uuid[])`, [pointClients.map((p) => p.clientId)])).rows.map((r) => `баланс ${Number(r.balance) / 100}`),
    );
    console.log(`  база: ${JSON.stringify(checks)}`);
    console.log(`  баллы после гонки 3: ${JSON.stringify(pointsOutcome)} (60 → −5: оплата первой; 60 → 55: штраф первым, оплате не хватило)`);
    const all = [...r1.map((r) => r.status), ...r2.map((r) => r.status), ...r3.map((r) => r.pay.status)];
    const errors5xx = all.filter((s) => s >= 500).length + r3.filter((r) => String(r.penalty.out).startsWith('ошибка')).length;
    const ok1 = r1.filter((r) => r.status === 201).length;
    const ok2 = r2.filter((r) => r.status === 201).length;
    const bad = Object.entries(checks).filter(([, v]) => v !== 0);
    if (bad.length || errors5xx || ok1 !== 1 || ok2 !== CERT_PAIRS) {
      failed = true;
      console.error(`ПРОВАЛ: ${JSON.stringify(Object.fromEntries(bad))}, 5xx/ошибок обработчика=${errors5xx}, успешных оплат гонки 1=${ok1} (ждали 1), погашений гонки 2=${ok2} (ждали ${CERT_PAIRS})`);
    } else {
      console.log(`ОК: один живой платёж из ${PAYMENTS}, ${ok2} погашений на ${CERT_PAIRS} сертификатов без минуса, Σ партий = max(0, баланс), баланс = Σ записей`);
    }
  } finally {
    await app?.close();
    await pool?.end();
    await sql?.end();
    await pgServer.stop();
    await rm(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
