// S4-70 по HTTP: K11 №239–242, №248. TC-16: Директор зоны A по филиалу B → 404 в агрегате и детализации; маска телефона без
// client.view.full; период > 92 дней → REPORT_PERIOD_TOO_LONG с useExport; без пула отчётов маршрутов нет; реальные данные живого сервера.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { runReconcile } from '../../apps/api/src/modules/reports/reconcile.ts';
import { createReportsPool } from '../../apps/api/src/modules/reports/framework.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-отчётов-проверка-1';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-20T05:00:00Z');
const QS = 'from=2026-10-01&to=2026-10-31';
let db: TestDatabase;
let pool: pg.Pool;
let reports: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[key] = r.rows[0]!.id;
  if (branch) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (who: string, url: string) => app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: cookies[who]! } });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  reports = createReportsPool(db.reportsUrl);
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, reports: { pool: reports } });
  ids.a = (await createTestBranch(db.client, { timezone: 'Asia/Novosibirsk' })).id;
  ids.b = (await createTestBranch(db.client, { timezone: 'Europe/Moscow' })).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, wd, '10:00', '22:00', '2020-01-01', gen_random_uuid() FROM generate_series(1, 7) wd`, [ids.a]);
  ids.unit = (await db.client.query<{ id: string }>(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'pc1', 'pc1') RETURNING id`, [ids.a])).rows[0]!.id;
  ids.res = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.a])).rows[0]!.id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2020-01-01')`, [ids.res, ids.unit]);
  const resB = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-Б') RETURNING id`, [ids.b])).rows[0]!.id;
  ids.client = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type, registered_at) VALUES ('+79130001234', 'Иван', 'Петров', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
  for (const [branch, res] of [[ids.a, ids.res], [ids.b, resB]] as const) {
    const b = (await db.client.query<{ id: string }>(
      `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-10-10T05:00:00Z', '2026-10-10T06:00:00Z', '[)'), 50000, 'crm', 'staff', 'completed', '2026-10-09T05:00:00Z') RETURNING id`,
      [branch, ids.client, res],
    )).rows[0]!.id;
    await db.client.query(`INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type) VALUES ($1, 1, $2, tstzrange('2026-10-10T05:00:00Z', '2026-10-10T06:00:00Z', '[)'), 'UTC', ARRAY[$3]::uuid[], '{}', 50000, '{}', 'staff')`, [b, res, ids.unit]);
    await db.client.query(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, '2026-10-10T05:01:00Z', gen_random_uuid())`, [b, branch, ids.client]);
    if (branch === ids.a) await db.client.query(`INSERT INTO app.occupancy (unit_id, branch_id, period, source_type, source_id, booking_version) VALUES ($1, $2, tstzrange('2026-10-10T05:00:00Z', '2026-10-10T06:00:00Z', '[)'), 'booking', $3, 1)`, [ids.unit, branch, b]);
  }
  await staff('owner', 'owner');
  await staff('director', 'director', ids.a);
  await staff('admin', 'admin', ids.a);
  await runReconcile(pool, { trigger: 'manual', clock, logger: { error: () => {}, info: () => {} } });
}, 60_000);
afterAll(async () => {
  await app.close();
  await reports.end();
  await pool.end();
  await db.drop();
});

describe('отчёты по HTTP (S4-70)', () => {
  it('№240, №241: «Уведомления и публикации» подключён – цифры и детализация, показ по праву; Администратор – 403 (S4-74)', async () => {
    await db.client.query(
      `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, status, dedupe_key, created_at, sent_at) VALUES ($1, $2, 'service', 'booking_confirmed', 'system', 'т', 'т', '2026-10-10T05:00:00Z', 'sent_to_provider', 'comms-http', '2026-10-10T05:00:00Z', '2026-10-10T05:00:00Z')`,
      [ids.client, ids.a],
    );
    const r = await get('owner', `/reports/comms?${QS}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().metrics.serviceSentToProvider).toMatchObject({ state: 'ok', value: 1 });
    expect(r.json().metrics.siteViews).toEqual({ state: 'unavailable', reason: 'source_not_ready' });
    const detail = await get('director', `/reports/comms/detail?${QS}&metric=serviceSentToProvider&segment=branch:${ids.a}`);
    expect(detail.json().total).toMatchObject({ value: 1 });
    expect(detail.json().rows[0]).toMatchObject({ status: 'sent_to_provider', category: 'service' });
    expect((await get('director', `/reports/comms?${QS}&branchIds=${ids.b}`)).statusCode).toBe(404);
    expect((await get('admin', `/reports/comms?${QS}`)).statusCode).toBe(403);
  });

  it('№240: отчёт с реальными числами, computedAt, dayRule; неизвестный – REPORT_UNKNOWN; Э3 – source_not_ready', async () => {
    const r = await get('owner', `/reports/bookings?${QS}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().metrics.visited).toMatchObject({ state: 'ok', value: 2, unit: 'count' });
    expect(r.json().dayRule).toContain('филиала');
    expect(r.json().computedAt).toBe('2026-11-20T05:00:00.000Z');
    expect((await get('owner', `/reports/нет-такого?${QS}`)).json().error.code).toBe('REPORT_UNKNOWN');
    const e3 = await get('owner', `/reports/events?${QS}`);
    expect(e3.statusCode).toBe(200);
    expect(e3.json().metrics.report).toEqual({ state: 'unavailable', reason: 'source_not_ready' });
    expect((await get('admin', `/reports/events?${QS}`)).statusCode).toBe(403);
  });

  it('TC-16: Директор зоны A по филиалу B → 404 в агрегате, детализации, дашборде; вся сеть сужается до зоны', async () => {
    for (const url of [`/reports/bookings?${QS}&branchIds=${ids.b}`, `/reports/bookings/detail?${QS}&branchIds=${ids.b}&metric=visited`, `/reports/dashboard?${QS}&branchIds=${ids.b}`, `/reports/utilization?${QS}&branchIds=${ids.b}`, `/reports/finance?${QS}&branchIds=${ids.b}`]) {
      const r = await get('director', url);
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code).toBe('NOT_FOUND');
    }
    const own = await get('director', `/reports/bookings?${QS}`);
    expect(own.json().metrics.visited).toMatchObject({ value: 1 });
    const detail = await get('director', `/reports/bookings/detail?${QS}&metric=visited`);
    expect(detail.json().rows).toHaveLength(1);
    expect(detail.json().rows[0].branchId).toBe(ids.a);
    expect(detail.json().total).toMatchObject({ value: 1 });
  });

  it('маска телефона без client.view.full: Администратор – маска и «Иван П.», Директор – полный; итог = строки', async () => {
    const adm = await get('admin', `/reports/bookings/detail?${QS}&metric=visited`);
    expect(adm.statusCode).toBe(200);
    const row = adm.json().rows[0];
    expect(row.client).toMatchObject({ name: 'Иван П.', phone: '+7 ••• ••• ••-34' });
    expect(adm.body).not.toContain('+79130001234');
    expect(adm.json().columns).toContain('client');
    const dir = await get('director', `/reports/bookings/detail?${QS}&metric=visited`);
    expect(dir.json().rows[0].client).toMatchObject({ name: 'Иван Петров', phone: '+79130001234' });
    expect((await get('admin', `/reports/finance?${QS}`)).statusCode).toBe(403);
  });

  it('период > 92 дней → REPORT_PERIOD_TOO_LONG с useExport; неверный период и фильтр – 422', async () => {
    const long = await get('owner', '/reports/bookings?from=2026-01-01&to=2026-06-01');
    expect(long.statusCode).toBe(422);
    expect(long.json().error).toMatchObject({ code: 'REPORT_PERIOD_TOO_LONG', details: { useExport: true, maxDays: 92 } });
    expect((await get('owner', '/reports/bookings?from=2026-11-02&to=2026-11-01')).json().error.code).toBe('REPORT_PERIOD_INVALID');
    expect((await get('owner', '/reports/bookings')).json().error.code).toBe('REPORT_PERIOD_INVALID');
    expect((await get('owner', `/reports/bookings?${QS}&clientId=не-uuid`)).json().error.code).toBe('REPORT_FILTER_INVALID');
    expect((await get('owner', `/reports/bookings/detail?${QS}&metric=нет`)).json().error.code).toBe('REPORT_FILTER_INVALID');
  });

  it('№239 дашборд: набор по роли; №242 календарь единицы и график по часам; без входа – 401', async () => {
    const owner = await get('owner', `/reports/dashboard?${QS}`);
    expect(owner.statusCode).toBe(200);
    expect(owner.json().cards.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['visited', 'netMovement', 'eventsCount']));
    expect(owner.json().prevPeriod).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    const admin = await get('admin', `/reports/dashboard?${QS}`);
    expect(admin.json().cards.map((c: { key: string }) => c.key)).not.toContain('netMovement');
    const cal = await get('owner', `/reports/utilization/calendar?unitId=${ids.unit}&date=2026-10-10`);
    expect(cal.statusCode).toBe(200);
    expect(cal.json().booked).toEqual([{ start: '2026-10-10T05:00:00.000Z', end: '2026-10-10T06:00:00.000Z' }]);
    expect((await get('admin', `/reports/utilization/calendar?unitId=${randomUUID()}&date=2026-10-10`)).statusCode).toBe(404);
    const series = await get('owner', `/reports/utilization?${QS}&branchIds=${ids.a}&series=hour`);
    expect(series.json().series.points.find((p: { bucket: string }) => p.bucket === '12')).toMatchObject({ usedMin: 60 });
    expect((await app.inject({ method: 'GET', url: `${BASE}/reports/dashboard?${QS}` })).statusCode).toBe(401);
  });

  it('№248: журнал сверки – Владелец и Директор; Администратору 403', async () => {
    const r = await get('owner', '/reports/reconcile/runs');
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toHaveLength(1);
    expect(r.json().items[0]).toMatchObject({ trigger: 'manual', status: 'ok', discrepancies: [] });
    expect((await get('director', '/reports/reconcile/runs')).statusCode).toBe(200);
    expect((await get('admin', '/reports/reconcile/runs')).statusCode).toBe(403);
  });
});

describe('без пула отчётов', () => {
  it('маршрутов нет – 404 от сервера, а не падение', async () => {
    const bare = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
    const r = await bare.inject({ method: 'GET', url: `${BASE}/reports/dashboard?${QS}`, headers: { cookie: cookies.owner! } });
    expect(r.statusCode).toBe(404);
    await bare.close();
  });
});
