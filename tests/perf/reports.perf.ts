// Производительность отчётов (17 §4.1, K24 §9): засев на объём сети – 3 филиала × 92 дня броней, прямым SQL.
// Каждый отчёт по HTTP за весь период ≤ 5 с, поиск ≤ 2 с, сумма детализации = итог для каждого отчёта на том же объёме.
// Запуск – npm run test:perf, отдельно от общего набора (vitest.perf.config.ts). Полная нагрузка Q-93 (20 филиалов × 12 месяцев) – S4-131.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { createReportsPool } from '../../apps/api/src/modules/reports/framework.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const BASE = '/api/crm/v1';
const QS = 'from=2026-08-01&to=2026-10-31'; // 92 дня
const PASSWORD = 'Пароль-нагрузки-проверка-1';
const SYS = '00000000-0000-4000-8000-000000000000';
const LIMIT_MS = 5_000;
const SEARCH_LIMIT_MS = 2_000;
const clock = fixedClock('2026-11-05T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let reports: pg.Pool;
let app: FastifyInstance;
let cookie: string;
let directorCookie: string;
let ownerId: string;
const branches: string[] = [];
const volume: Record<string, number> = {};
const q = (sql: string, params: unknown[] = []) => db.client.query(sql, params);

async function seedBranch(tz: string, index: number): Promise<string> {
  const id = (await createTestBranch(db.client, { timezone: tz })).id;
  await q(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, wd, '10:00', '22:00', '2020-01-01', $2 FROM generate_series(1, 7) wd`, [id, SYS]);
  await q(
    `WITH u AS (INSERT INTO app.occupancy_units (branch_id, code, name) SELECT $1, 'pc' || n, 'ПК ' || n FROM generate_series(1, 20) n RETURNING id, code),
          r AS (INSERT INTO app.resources (branch_id, resource_type, name) SELECT $1, 'pc', 'ПК ' || n FROM generate_series(1, 20) n RETURNING id, name)
     INSERT INTO app.resource_units (resource_id, unit_id, valid_from)
     SELECT r.id, u.id, '2020-01-01' FROM r JOIN u ON replace(u.code, 'pc', '') = replace(r.name, 'ПК ', '')`,
    [id],
  );
  const room = (await q(`INSERT INTO app.rooms (branch_id, slug, name, whole_rent_allowed) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [id])).rows[0].id as string;
  const unit = async (code: string) => (await q(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [id, room, code])).rows[0].id as string;
  const [vr1, vr2, ps4] = [await unit('vr1'), await unit('vr2'), await unit('ps4')];
  const res = async (type: string, name: string, units: string[]) => {
    const r = (await q(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [id, room, type, name])).rows[0].id as string;
    for (const x of units) await q(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2020-01-01')`, [r, x]);
    return r;
  };
  const r1 = await res('vr_seat', 'VR1', [vr1]);
  const r2 = await res('vr_seat', 'VR2', [vr2]);
  const whole = await res('room_whole', 'Комната', [vr1, vr2, ps4]);

  // слоты: ПК – 2/3 часов 10–21; VR-места – до 16 часов; комната целиком – вечером, четверть слотов: занятости не пересекаются
  await q('BEGIN');
  await q(
    `CREATE TEMP TABLE seed_bookings ON COMMIT DROP AS
     WITH slots AS (
       SELECT r.id AS resource_id, array_agg(ru.unit_id) AS units, day, hour,
              ((day + make_interval(hours => hour)) AT TIME ZONE $2) AS s
       FROM app.resources r JOIN app.resource_units ru ON ru.resource_id = r.id,
            generate_series('2026-08-01'::timestamp, '2026-10-31'::timestamp, '1 day') AS day, generate_series(10, 21) AS hour
       WHERE r.branch_id = $1
         AND ((r.resource_type = 'pc' AND abs(hashtext(r.id::text || day::text || hour)) % 3 <> 0)
           OR (r.id = ANY($3::uuid[]) AND hour < 16 AND abs(hashtext(r.id::text || day::text || hour)) % 3 <> 0)
           OR (r.id = $4 AND hour >= 16 AND abs(hashtext(r.id::text || day::text || hour)) % 4 = 0))
       GROUP BY r.id, day, hour
     )
     SELECT gen_random_uuid() AS id, resource_id, units, s,
            abs(hashtext(resource_id::text || s::text)) AS h
     FROM slots`,
    [id, tz, [r1, r2], whole],
  );
  await q(
    `INSERT INTO app.bookings (id, checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status, created_at, cancelled_at, cancel_comment)
     SELECT id, gen_random_uuid(), $1, ($2::uuid[])[1 + (h % array_length($2::uuid[], 1))], resource_id, tstzrange(s, s + interval '1 hour', '[)'), 30000 + h % 50000, 'crm', 'staff',
            CASE WHEN h % 100 < 70 THEN 'completed' WHEN h % 100 < 80 THEN 'no_show' WHEN h % 100 < 90 THEN 'cancelled_by_client' WHEN h % 100 < 95 THEN 'cancelled_by_club' ELSE 'confirmed' END,
            s - interval '2 days',
            CASE WHEN h % 100 BETWEEN 80 AND 94 THEN s - interval '1 hour' END,
            CASE WHEN h % 100 BETWEEN 80 AND 94 THEN 'отмена' END
     FROM seed_bookings`,
    [id, clients],
  );
  await q(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     SELECT id, 1, resource_id, tstzrange(s, s + interval '1 hour', '[)'), $1, units, '{}', 30000, '{}', 'staff' FROM seed_bookings`,
    [tz],
  );
  await q(
    `INSERT INTO app.occupancy (unit_id, branch_id, period, source_type, source_id, booking_version)
     SELECT u, $1, tstzrange(s, s + interval '1 hour', '[)'), 'booking', id, 1 FROM seed_bookings, unnest(units) AS u WHERE h % 100 NOT BETWEEN 80 AND 94`,
    [id],
  );
  await q(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) SELECT b.id, b.branch_id, b.client_id, lower(b.period), $2 FROM app.bookings b WHERE b.branch_id = $1 AND b.status = 'completed'`, [id, SYS]);
  await q(`INSERT INTO app.no_shows (booking_id, branch_id, client_id, marked_at, marked_by) SELECT b.id, b.branch_id, b.client_id, upper(b.period), $2 FROM app.bookings b WHERE b.branch_id = $1 AND b.status = 'no_show'`, [id, SYS]);
  // платёж и приход кассы на каждое посещение, расходы – по разу в день, блокировки – 30 штук
  await q(
    `INSERT INTO app.payment_sessions (booking_id, branch_id, client_id, amount_due_kop, booking_version, status)
     SELECT b.id, b.branch_id, b.client_id, b.price_kop, 1, 'paid' FROM app.bookings b WHERE b.branch_id = $1 AND b.status = 'completed'`,
    [id],
  );
  await q(
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
    [id, SYS],
  );
  await q(
    `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, category_id, comment, occurred_at, author_type, posting_id)
     SELECT $1, 'expense', 'cash', 'cash', 'out', 5000, $2, 'расход ' || day::date, day + interval '12 hours', 'system', gen_random_uuid()
     FROM generate_series('2026-08-01'::timestamp, '2026-10-31'::timestamp, '1 day') AS day`,
    [id, category],
  );
  const reason = (await q(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`)).rows[0].id as string;
  for (let i = 0; i < 30; i++) {
    const start = new Date(Date.UTC(2026, 7, 1 + i * 3, 6 + index));
    const end = new Date(start.getTime() + 6 * 3_600_000);
    const block = (await q(`INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, created_by) VALUES ($1, 'unit', ARRAY[$2]::uuid[], tstzrange($3, $4, '[)'), $5, $6) RETURNING id`, [id, vr1, start, end, reason, SYS])).rows[0].id as string;
    await q(`INSERT INTO app.resource_block_units (block_id, unit_id, period) VALUES ($1, $2, tstzrange($3, $4, '[)'))`, [block, vr1, start, end]);
  }
  await q('COMMIT');
  await q('ANALYZE app.bookings, app.occupancy, app.visits, app.no_shows, app.payments, app.payment_lines, journal.finance_operations, journal.booking_versions');
  return id;
}

let clients: string[] = [];
let category: string;

async function login(key: string, role: string, branch?: string): Promise<string> {
  const r = await q(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Н', 'Н', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  if (branch) await q(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0].id, branch]);
  if (role === 'owner') ownerId = r.rows[0].id as string;
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  return String(res.headers['set-cookie']).split(';')[0]!;
}

const timed = async (url: string, who = cookie) => {
  const started = performance.now();
  const r = await app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: who } });
  return { r, ms: Math.round(performance.now() - started) };
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  reports = createReportsPool(db.reportsUrl);
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('p'.repeat(40)), clock }, reports: { pool: reports } });
  category = (await q(`SELECT id FROM app.finance_categories WHERE name = 'Прочее'`)).rows[0].id as string;
  clients = (
    await q(
      `INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type, registered_at, created_at)
       SELECT '+7913' || (2000000 + n)::text, 'Имя' || n, 'Фамилия' || n, CASE WHEN n % 20 = 0 THEN 'guest' ELSE 'active' END, 'system',
              CASE WHEN n % 20 = 0 THEN NULL ELSE '2026-08-01'::timestamptz + (n % 92) * interval '1 day' END, '2026-08-01'::timestamptz + (n % 92) * interval '1 day'
       FROM generate_series(1, 4000) n RETURNING id`,
    )
  ).rows.map((x) => x.id as string);
  branches.push(await seedBranch('Europe/Moscow', 0), await seedBranch('Asia/Novosibirsk', 1), await seedBranch('Europe/Kaliningrad', 2));
  // баллы: начисление на посещение (первые 30 000 посещений), журнал K3 с балансом через триггер
  await q(`INSERT INTO app.ledger_accounts (kind, unit, owner_type, owner_id, min_balance) SELECT 'loyalty_client', 'POINT_CENTI', 'client', id, -5000 FROM app.clients`);
  await q(
    `INSERT INTO journal.ledger_entries (posting_id, account_id, amount, balance_after, entry_type, branch_id, occurred_at, author_type)
     SELECT gen_random_uuid(), a.id, 1000, 0, 'loyalty.accrual', v.branch_id, v.arrived_at, 'system'
     FROM (SELECT * FROM app.visits ORDER BY arrived_at LIMIT 30000) v JOIN app.ledger_accounts a ON a.owner_id = v.client_id AND a.kind = 'loyalty_client'`,
  );
  await q('ANALYZE journal.ledger_entries, app.ledger_accounts, app.clients');
  cookie = await login('owner', 'owner');
  directorCookie = await login('director', 'director', branches[1]);
  // сертификаты – командой: продажа и остатки настоящие
  const owner: AccessContext = { actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  for (let i = 0; i < 30; i++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await sellCertificate(c, owner, { branchId: branches[i % 3]!, nominalKop: 100_000 + i, method: 'card' }, { actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() }, { pepper: 'x'.repeat(40), clock: fixedClock(new Date(Date.UTC(2026, 8, 1 + i, 8))) });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
  for (const [name, sql] of Object.entries({ bookings: 'SELECT count(*) FROM app.bookings', visits: 'SELECT count(*) FROM app.visits', occupancy: 'SELECT count(*) FROM app.occupancy', finance: 'SELECT count(*) FROM journal.finance_operations', ledger: 'SELECT count(*) FROM journal.ledger_entries' })) {
    volume[name] = Number((await q(sql)).rows[0].count);
  }
  console.info('объём:', JSON.stringify(volume));
}, 300_000);
afterAll(async () => {
  await app.close();
  await reports.end();
  await pool.end();
  await db.drop();
});

describe('производительность на объёме сети: 3 филиала × 92 дня', () => {
  it('объём соответствует заданию', () => {
    expect(volume.bookings).toBeGreaterThan(40_000);
    expect(volume.visits).toBeGreaterThan(25_000);
  });

  for (const report of ['dashboard', 'bookings', 'utilization', 'finance', 'clients', 'loyalty', 'certificates']) {
    it(`${report}: вся сеть за 92 дня ≤ 5 с`, async () => {
      const { r, ms } = await timed(`/reports/${report}?${QS}`);
      console.info(`отчёт ${report}: ${ms} мс`);
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
      expect(ms).toBeLessThanOrEqual(LIMIT_MS);
    });
  }

  it('Директор зоны: дашборд своего филиала ≤ 5 с и меньше сети; утилизация по часам ≤ 5 с', async () => {
    const dash = await timed(`/reports/dashboard?${QS}`, directorCookie);
    const net = await timed(`/reports/bookings?${QS}`);
    const own = await timed(`/reports/bookings?${QS}`, directorCookie);
    console.info(`директор: дашборд ${dash.ms} мс`);
    expect(dash.ms).toBeLessThanOrEqual(LIMIT_MS);
    expect(own.r.json().metrics.visited.value).toBeLessThan(net.r.json().metrics.visited.value);
    expect(own.r.json().metrics.visited.value).toBeGreaterThan(0);
    const hours = await timed(`/reports/utilization?${QS}&branchIds=${branches[0]}&series=hour`);
    console.info(`график по часам, один филиал: ${hours.ms} мс`);
    expect(hours.r.statusCode).toBe(200);
    expect(hours.ms).toBeLessThanOrEqual(LIMIT_MS);
  });

  it('поиск ≤ 2 с: имя, телефон, номер брони, дата; по HTTP', async () => {
    const expected: Record<string, string> = { 'Фамилия12': 'client', '+79132000500': 'client', '0500': 'client', '150': 'booking', '2026-09-10': 'booking', 'расход 2026-09': 'finance_operation' };
    for (const text of Object.keys(expected)) {
      const { r, ms } = await timed(`/search?q=${encodeURIComponent(text)}`);
      console.info(`поиск «${text}»: ${ms} мс`);
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
      expect(r.json().groups.length).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(SEARCH_LIMIT_MS);
      const items = (r.json().groups as Array<{ type: string; items: unknown[] }>).find((g) => g.type === expected[text])!.items;
      expect(items.length, text).toBeGreaterThan(0); // быстро и пусто – не считается
    }
  });
});

describe('сумма детализации = итог на объёме: каждый отчёт', () => {
  const cases: Array<[string, string, 'count' | 'value']> = [
    ['bookings', 'visited', 'count'],
    ['bookings', 'cancelledByClient', 'count'],
    ['finance', 'income', 'value'],
    ['finance', 'expenses', 'value'],
    ['clients', 'firstTime', 'value'],
    ['loyalty', 'accrued', 'value'],
    ['certificates', 'salesAmount', 'value'],
    ['utilization', 'used', 'value'],
    ['utilization', 'free', 'value'],
  ];
  for (const [report, metric, mode] of cases) {
    it(`${report}.${metric}`, async () => {
      const total = (await timed(`/reports/${report}?${QS}`)).r.json().metrics[metric];
      expect(total.state).toBe('ok');
      let cursor: string | null = null;
      let sum = 0;
      let rows = 0;
      let last: { value: number } | undefined;
      do {
        const res = await timed(`/reports/${report}/detail?${QS}&metric=${metric}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(res.r.statusCode, res.r.body.slice(0, 300)).toBe(200);
        const body = res.r.json() as { rows: Array<{ value?: number }>; nextCursor: string | null; total: { value: number } };
        rows += body.rows.length;
        sum += body.rows.reduce((s, x) => s + Number(x.value ?? 0), 0);
        last = body.total;
        cursor = body.nextCursor;
      } while (cursor);
      expect(last!.value).toBe(total.value);
      expect(mode === 'count' ? rows : sum).toBe(total.value);
      expect(total.value).toBeGreaterThan(0);
    }, 120_000);
  }
});
