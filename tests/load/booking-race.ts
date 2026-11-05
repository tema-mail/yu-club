// S1-26. Нагрузочный тест гонки: 200 клиентов одновременно на 3 слота VR-комнаты, смесь «вся комната» против мест VR1/VR2.
// Только локально: embedded-postgres во временной папке + API (buildServer) на 127.0.0.1, данные – засев Э0+Э1
// (db/seed/dev.ts, db/seed/resources.ts). На стенд нагрузку НЕ давать: там общий сервер с чужими сайтами.
// Клиенты входят по-настоящему – OTP через тестовый SMS-адаптер (код берётся из отправленного сообщения);
// у каждого свой X-Forwarded-For (как за Caddy), чтобы лимиты по IP считались на клиента, а не на весь тест.
// После прогона – запросы к базе: ноль пересечений активной занятости по единице, на слот – не больше одной брони
// на ресурс и никогда «вся комната» вместе с местом. Порог: p95 удержания ≤ 2 с (18 §5.5); p95 подтверждения – замер.
//
//   npm run load:race                     – 200 клиентов, пул API 10 (как depsFromConfig на сервере)
//   LOAD_CLIENTS=500 LOAD_POOL=20 npm run load:race
// Код выхода 1 – нашлось пересечение / двойная бронь или p95 удержания > 2 с.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { loadConfig } from '../../apps/api/src/config.ts';
import { addDays, localToInstant, systemClock, todayIn, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { migrateUp } from '../../db/migrate.ts';
import { seedDev } from '../../db/seed/dev.ts';
import { seedResources } from '../../db/seed/resources.ts';

const CLIENTS = Number(process.env.LOAD_CLIENTS ?? 200);
const POOL = Number(process.env.LOAD_POOL ?? 10);
const HOLD_P95_LIMIT_MS = 2000;
const BRANCH_CODE = 'demo-nsk-krasny';
const SLOTS: LocalTime[] = ['12:00', '13:00', '14:00'] as LocalTime[];
const SLOT_MINUTES = 60;

interface Outcome {
  target: 'whole' | 'vr1' | 'vr2';
  slot: number;
  holdMs: number;
  holdStatus: number;
  holdCode: string;
  confirmMs?: number;
  confirmStatus?: number;
  confirmCode?: string;
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50).toFixed(0)} мс p95=${pct(xs, 95).toFixed(0)} мс max=${Math.max(...xs).toFixed(0)} мс`;
const tally = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));
const ipOf = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yu-load-'));
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
  let failed = false;
  try {
    await admin.query(`CREATE ROLE yu_app NOLOGIN`);
    await admin.query(`CREATE ROLE yu_reports NOLOGIN`); // без неё миграция 0406 останавливается
    await admin.query(`CREATE DATABASE yu_load`);
    await admin.end();
    const dbUrl = adminUrl.replace(/\/postgres$/, '/yu_load');
    const sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
    await migrateUp(sql);
    pool = new pg.Pool({ connectionString: dbUrl, options: '-c role=yu_app -c search_path=app,journal', max: POOL });
    await seedDev(pool, { env: { APP_ENV: 'test' }, password: `Нагрузка-${randomUUID()}` });
    const seeded = await seedResources(pool, { env: { APP_ENV: 'test' } });
    const vr = seeded.branches[BRANCH_CODE]!;
    const branch = (await sql.query<{ id: string; timezone: TimeZone }>('SELECT id, timezone FROM app.branches WHERE code = $1', [BRANCH_CODE])).rows[0]!;

    const codes = new Map<string, string>();
    const sms = createDevSmsSender('dev');
    const smsCapture = { send: async (m: { phoneE164: string; text: string; idempotencyKey: string }) => (codes.set(m.phoneE164, /(\d{6})/.exec(m.text)![1]!), sms.send(m)) };
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent', APP_ENV: 'dev' }), { clients: { pool, auth: clientAuthConfig(randomBytes(32).toString('hex')), sms: smsCapture } });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const api = (i: number, method: string, url: string, body: unknown, cookie?: string) =>
      fetch(`${base}/api/public/v1${url}`, {
        method,
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-forwarded-for': ipOf(i + 1), ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });

    // 1. Вход 200 клиентов по OTP (не в замере гонки), пачками по 20.
    const cookies: string[] = [];
    for (let k = 0; k < CLIENTS; k += 20) {
      const part = await Promise.all(
        Array.from({ length: Math.min(20, CLIENTS - k) }, async (_, j) => {
          const i = k + j;
          const phone = `+7913${String(1_000_000 + i).padStart(7, '0')}`;
          const req = await api(i, 'POST', '/auth/otp/request', { phone, purpose: 'login' });
          if (req.status !== 202) throw new Error(`OTP request ${i}: ${req.status} ${await req.text()}`);
          const { challengeId } = (await req.json()) as { challengeId: string };
          const ver = await api(i, 'POST', '/auth/otp/verify', { challengeId, code: codes.get(phone), consents: { pdProcessing: true } });
          if (ver.status !== 200) throw new Error(`OTP verify ${i}: ${ver.status} ${await ver.text()}`);
          const token = /yu_client=([^;]+)/.exec(ver.headers.get('set-cookie') ?? '')?.[1];
          if (!token) throw new Error(`нет куки сессии у клиента ${i}`);
          return `yu_client=${token}`;
        }),
      );
      cookies.push(...part);
    }
    console.log(`Вошли по OTP: ${cookies.length} клиентов; пул API ${POOL}`);

    // 2. Гонка: все удержания стартуют одновременно; победитель сразу подтверждает.
    const day = addDays(todayIn(systemClock, branch.timezone), 2);
    const slots = SLOTS.map((t) => {
      const start = localToInstant(day, t, branch.timezone);
      return { start: start.toISOString(), end: new Date(start.getTime() + SLOT_MINUTES * 60_000).toISOString() };
    });
    const targets = { whole: vr.vrWhole, vr1: vr.vr1, vr2: vr.vr2 } as const;
    const order = ['whole', 'vr1', 'vr2'] as const;
    const run = async (i: number): Promise<Outcome> => {
      const slot = i % 3;
      const target = order[Math.floor(i / 3) % 3]!;
      const t0 = performance.now();
      const h = await api(i, 'POST', '/holds', { branchId: branch.id, items: [{ resourceId: targets[target], ...slots[slot]! }] }, cookies[i]);
      const hb = (await h.json()) as { id?: string; error?: { code: string } };
      const out: Outcome = { target, slot, holdMs: performance.now() - t0, holdStatus: h.status, holdCode: h.status === 201 ? 'ok' : (hb.error?.code ?? String(h.status)) };
      if (h.status !== 201) return out;
      const t1 = performance.now();
      const c = await api(i, 'POST', `/holds/${hb.id}/confirm`, {}, cookies[i]);
      const cb = (await c.json()) as { error?: { code: string } };
      return { ...out, confirmMs: performance.now() - t1, confirmStatus: c.status, confirmCode: c.status === 201 ? 'ok' : (cb.error?.code ?? String(c.status)) };
    };
    const tStart = performance.now();
    const results = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => run(i)));
    const wall = performance.now() - tStart;

    // 3. Проверка базой.
    const overlaps = (await sql.query<{ n: number }>(
      `SELECT count(*)::int n FROM app.occupancy a JOIN app.occupancy b ON a.unit_id = b.unit_id AND a.id < b.id
       WHERE a.active AND b.active AND a.period && b.period`,
    )).rows[0]!.n;
    const doubleBooked = (await sql.query<{ n: number }>(
      `SELECT count(*)::int n FROM app.bookings b1 JOIN app.bookings b2 ON b1.resource_id = b2.resource_id AND b1.id < b2.id AND b1.period && b2.period
       WHERE b1.status NOT LIKE 'cancelled%' AND b2.status NOT LIKE 'cancelled%'`,
    )).rows[0]!.n;
    const wholeWithSeat = (await sql.query<{ n: number }>(
      `SELECT count(*)::int n FROM app.bookings w JOIN app.bookings s ON w.period && s.period
       WHERE w.resource_id = $1 AND s.resource_id = ANY($2::uuid[]) AND w.status NOT LIKE 'cancelled%' AND s.status NOT LIKE 'cancelled%'`,
      [vr.vrWhole, [vr.vr1, vr.vr2]],
    )).rows[0]!.n;
    const perSlot = (await sql.query<{ start: Date; whole: number; seats: number }>(
      `SELECT lower(period) AS start, count(*) FILTER (WHERE resource_id = $1)::int whole, count(*) FILTER (WHERE resource_id <> $1)::int seats
       FROM app.bookings WHERE status NOT LIKE 'cancelled%' AND resource_id = ANY($2::uuid[]) GROUP BY 1 ORDER BY 1`,
      [vr.vrWhole, [vr.vrWhole, vr.vr1, vr.vr2]],
    )).rows;
    const occ = new Map((await sql.query<{ start: Date; n: number }>(
      `SELECT lower(period) AS start, count(*)::int n FROM app.occupancy WHERE active AND source_type = 'booking' GROUP BY 1`,
    )).rows.map((r) => [r.start.toISOString(), r.n]));
    await sql.end();

    const holdMs = results.map((r) => r.holdMs);
    const okHoldMs = results.filter((r) => r.holdStatus === 201).map((r) => r.holdMs);
    const confirmMs = results.flatMap((r) => (r.confirmMs === undefined ? [] : [r.confirmMs]));
    const bookings = results.filter((r) => r.confirmCode === 'ok');
    console.log(`Гонка: ${CLIENTS} клиентов на 3 слота ${day} (${SLOTS.join(', ')}, ${SLOT_MINUTES} мин), за ${wall.toFixed(0)} мс`);
    console.log(`  удержание: исходы ${JSON.stringify(tally(results.map((r) => `${r.holdStatus} ${r.holdCode}`)))}`);
    console.log(`  удержание, все ответы: ${fmt(holdMs)}; успешные: ${fmt(okHoldMs)}`);
    console.log(`  подтверждение: исходы ${JSON.stringify(tally(results.flatMap((r) => (r.confirmStatus ? [`${r.confirmStatus} ${r.confirmCode}`] : []))))}; ${fmt(confirmMs)}`);
    console.log(`  брони: ${bookings.length} – ${JSON.stringify(tally(bookings.map((r) => `слот ${r.slot + 1}: ${r.target}`)))}`);
    for (const s of perSlot) console.log(`  база, слот ${s.start.toISOString()}: вся комната ${s.whole}, места ${s.seats}, строк занятости ${occ.get(s.start.toISOString()) ?? 0}`);
    console.log(`  база: пересечений занятости ${overlaps}, двойных броней ресурса ${doubleBooked}, «вся комната» вместе с местом ${wholeWithSeat}`);
    const p95 = pct(holdMs, 95);
    const errors500 = results.filter((r) => r.holdStatus >= 500 || (r.confirmStatus ?? 0) >= 500).length;
    if (overlaps || doubleBooked || wholeWithSeat || errors500 || p95 > HOLD_P95_LIMIT_MS || bookings.length === 0) {
      failed = true;
      console.error(`ПРОВАЛ: пересечения=${overlaps}, двойные=${doubleBooked}, комната+место=${wholeWithSeat}, 5xx=${errors500}, p95 удержания=${p95.toFixed(0)} мс (порог ${HOLD_P95_LIMIT_MS})`);
    } else {
      console.log(`ОК: ноль пересечений и двойных броней, p95 удержания ${p95.toFixed(0)} мс ≤ ${HOLD_P95_LIMIT_MS} мс`);
    }
  } finally {
    await app?.close();
    await pool?.end();
    await pgServer.stop();
    await rm(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
