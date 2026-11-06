// S4-73 по HTTP: K11 №243–247 на живом сервере. Чужая задача → 404; без export.pd телефоны в файле маской, у Владельца – полностью; attachment, no-store;
// TC-16: Директор зоны A по филиалу B → 404; Администратор без reports.export → 403 и строка отказа в аудите; срок вышел → 410; повтор ключа – тот же ответ.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createFileStore, type FileStore } from '../../apps/api/src/core/files.ts';
import { noNetwork } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { runExportGc, startExportRunner } from '../../apps/api/src/modules/reports/export.ts';
import { createReportsPool } from '../../apps/api/src/modules/reports/framework.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-экспорта-проверка-1';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-20T05:00:00Z');
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };
const PHONE = '+79130001234';
let db: TestDatabase;
let pool: pg.Pool;
let reports: pg.Pool;
let app: FastifyInstance;
let dir: string;
let store: FileStore;
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
const post = (who: string, url: string, payload?: object, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `${BASE}${url}`, headers: { cookie: cookies[who]!, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
const run = async () => {
  const runner = startExportRunner({ pool, reports, clock, store, network: noNetwork }, { start: false });
  for (let i = 0; i < 3; i++) await runner.tick();
  await runner.stop();
};
const DETAIL = { report: 'bookings', format: 'csv', detail: true, params: { ...PERIOD, metric: 'visited' } };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  reports = createReportsPool(db.reportsUrl);
  dir = await mkdtemp(join(tmpdir(), 'yu-export-routes-'));
  store = createFileStore({ root: dir });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, reports: { pool: reports, exportStore: store } });
  ids.a = (await createTestBranch(db.client, { timezone: 'Asia/Novosibirsk' })).id;
  ids.b = (await createTestBranch(db.client, { timezone: 'Europe/Moscow' })).id;
  const res = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.a])).rows[0]!.id;
  const client = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type, registered_at) VALUES ($1, 'Иван', 'Петров', 'active', 'system', now()) RETURNING id`, [PHONE])).rows[0]!.id;
  const b = (await db.client.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-10-10T05:00:00Z', '2026-10-10T06:00:00Z', '[)'), 50000, 'crm', 'staff', 'completed', '2026-10-09T05:00:00Z') RETURNING id`,
    [ids.a, client, res],
  )).rows[0]!.id;
  await db.client.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     VALUES ($1, 1, $2, tstzrange('2026-10-10T05:00:00Z', '2026-10-10T06:00:00Z', '[)'), 'Asia/Novosibirsk', ARRAY[gen_random_uuid()], '{"name":"ПК-1"}', 50000, '{}', 'staff')`,
    [b, res],
  );
  await db.client.query(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, '2026-10-10T05:01:00Z', gen_random_uuid())`, [b, ids.a, client]);
  await staff('owner', 'owner');
  await staff('director', 'director', ids.a);
  await staff('director2', 'director', ids.a);
  await staff('admin', 'admin', ids.a);
}, 60_000);
afterAll(async () => {
  await app.close();
  await reports.end();
  await pool.end();
  await rm(dir, { recursive: true, force: true });
  await db.drop();
});

describe('экспорт по HTTP', () => {
  it('№243, №245, №246: Директор – 202, файл с настоящими данными и маской; заголовки скачивания; №244 – в списке', async () => {
    const r = await post('director', '/reports/exports', DETAIL);
    expect(r.statusCode).toBe(202);
    const job = r.json();
    expect(job).toMatchObject({ status: 'queued', report: 'bookings', format: 'csv', detail: true, masked: true });
    expect(job.params.branchIds).toEqual([ids.a]);
    expect((await get('director', `/reports/exports/${job.id}/file`)).json().error.code).toBe('EXPORT_NOT_READY');
    await run();
    const ready = await get('director', `/reports/exports/${job.id}`);
    expect(ready.json()).toMatchObject({ status: 'ready', rows: 1, errorCode: null });
    const file = await get('director', `/reports/exports/${job.id}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toBe('attachment; filename="yu-club-bookings-2026-10-01-2026-10-31.csv"');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.body).toContain('Иван Петров');
    expect(file.body).toContain('500,00');
    expect(file.body).toMatch(/\+7 ••• ••• ••-34/);
    expect(file.body).not.toContain(PHONE);
    const list = await get('director', '/reports/exports');
    expect(list.json().items.map((i: { id: string }) => i.id)).toContain(job.id);
    expect((await get('director2', '/reports/exports')).json().items).toEqual([]);
    const audit = await db.client.query(`SELECT action FROM journal.audit_events WHERE object_id = $1 ORDER BY id`, [job.id]);
    expect(audit.rows.map((x) => x.action)).toEqual(['export.requested', 'export.downloaded']);
  });

  it('Владелец с export.pd – телефон полностью; повтор того же запроса с другим ключом – та же задача', async () => {
    const r = await post('owner', '/reports/exports', DETAIL);
    expect(r.json().masked).toBe(false);
    const same = await post('owner', '/reports/exports', DETAIL);
    expect(same.statusCode).toBe(202);
    expect(same.json().id).toBe(r.json().id);
    await run();
    const file = await get('owner', `/reports/exports/${r.json().id}/file`);
    expect(file.body).toContain(PHONE);
  });

  it('повтор ключа – сохранённый ответ; ключ обязателен', async () => {
    const key = randomUUID();
    const payload = { report: 'loyalty', format: 'xlsx', params: PERIOD };
    const a = await post('owner', '/reports/exports', payload, key);
    const b = await post('owner', '/reports/exports', payload, key);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    const none = await app.inject({ method: 'POST', url: `${BASE}/reports/exports`, headers: { cookie: cookies.owner! }, payload });
    expect(none.statusCode).toBe(400);
  });

  it('чужая задача → 404 во всех маршрутах; не UUID → 404', async () => {
    const id = (await post('director', '/reports/exports', { report: 'bookings', format: 'xlsx', params: PERIOD })).json().id;
    for (const url of [`/reports/exports/${id}`, `/reports/exports/${id}/file`]) expect((await get('director2', url)).statusCode).toBe(404);
    expect((await post('director2', `/reports/exports/${id}/cancel`)).statusCode).toBe(404);
    expect((await get('director', '/reports/exports/нет')).statusCode).toBe(404);
  });

  it('TC-16: Директор зоны A по филиалу B → 404; Администратор → 403 с записью отказа', async () => {
    const out = await post('director', '/reports/exports', { report: 'bookings', format: 'csv', params: { ...PERIOD, branchIds: [ids.b] } });
    expect(out.statusCode).toBe(404);
    const denied = await post('admin', '/reports/exports', { report: 'bookings', format: 'csv', params: PERIOD });
    expect(denied.statusCode).toBe(403);
    const audit = await db.client.query(`SELECT result FROM journal.audit_events WHERE action = 'export.requested' AND actor_id = $1`, [ids.admin]);
    expect(audit.rows.map((r) => r.result)).toEqual(['denied']);
    expect((await get('admin', '/reports/exports')).statusCode).toBe(403);
  });

  it('право отозвано до скачивания → EXPORT_FORBIDDEN 403; зона отозвана → тоже', async () => {
    const id = (await post('director2', '/reports/exports', { report: 'finance', format: 'csv', params: PERIOD })).json().id;
    await run();
    expect((await get('director2', `/reports/exports/${id}`)).json().status).toBe('ready');
    await db.client.query(`UPDATE app.staff_assignments SET revoked_at = now(), revoked_by = staff_id WHERE staff_id = $1`, [ids.director2]);
    const r = await get('director2', `/reports/exports/${id}/file`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('EXPORT_FORBIDDEN');
    await db.client.query(`UPDATE app.staff_assignments SET revoked_at = NULL, revoked_by = NULL WHERE staff_id = $1`, [ids.director2]);
  });

  it('№247: отмена в очереди; уборка после срока → 410', async () => {
    const id = (await post('director', '/reports/exports', { report: 'clients', format: 'csv', params: PERIOD })).json().id;
    const c = await post('director', `/reports/exports/${id}/cancel`);
    expect(c.statusCode).toBe(200);
    expect(c.json().status).toBe('cancelled');
    await run();
    expect((await get('director', `/reports/exports/${id}`)).json().status).toBe('cancelled');
    const done = (await post('director', '/reports/exports', { report: 'certificates', format: 'csv', params: PERIOD })).json().id;
    await run();
    await runExportGc({ pool, store, clock: fixedClock('2026-11-22T05:00:00Z') });
    const gone = await get('director', `/reports/exports/${done}/file`);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.code).toBe('EXPORT_EXPIRED');
  });

  it('без хранилища экспорта маршрутов нет', async () => {
    const bare = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, reports: { pool: reports } });
    const r = await bare.inject({ method: 'POST', url: `${BASE}/reports/exports`, headers: { cookie: cookies.owner!, 'idempotency-key': randomUUID() }, payload: DETAIL });
    expect(r.statusCode).toBe(404);
    await bare.close();
  });
});
