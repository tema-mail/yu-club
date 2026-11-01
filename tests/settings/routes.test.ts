// K7 по HTTP (modules/settings/routes.crm.ts): действующие значения с источником, изменение с даты по зоне,
// Idempotency-Key, rowVersion, «max ≥ default», возврат к наследованию с историей, права K1 и IDOR (чужое – 404).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-настроек-проверка-1';
const BASE = '/api/crm/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
// 14.11 05:00Z = 08:00 Москва, 12:00 Новосибирск. Каждый тест сдвигает часы: две записи в один миг – пересечение.
let nowMs = Date.parse('2026-11-14T05:00:00Z');
const clock: Clock = { now: () => new Date(nowMs) };

async function staff(key: string, role: string, scope?: { branch?: string; city?: string }): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  ids[key] = r.rows[0]!.id;
  if (scope?.branch || scope?.city) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, city_id, valid_from, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', $1)`,
      [r.rows[0]!.id, scope.branch ? 'branch' : 'city', scope.branch ?? null, scope.city ?? null],
    );
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

function req(who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}

interface Item {
  key: string; value: unknown; editable: boolean; levelAllowed: boolean; rowVersion: string; constraints: Record<string, unknown>;
  source: { level: string; own: boolean; cityName: string | null; validFrom: string | null };
  upcoming: Array<{ level: string; value: unknown; validFrom: string }>;
}
const q = (scope: string, id?: string) => `?scope=${scope}${id ? `&id=${id}` : ''}`;
async function item(who: string, scope: string, id: string | undefined, key: string): Promise<Item> {
  const r = await req(who, 'GET', `/settings${q(scope, id)}`);
  expect(r.statusCode).toBe(200);
  return (r.json().items as Item[]).find((i) => i.key === key)!;
}
const bodyWithoutRequestId = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  await staff('owner', 'owner');
  const msk = await req('owner', 'POST', '/cities', { slug: 'msk', name: 'Москва', timezone: 'Europe/Moscow' });
  const nsk = await req('owner', 'POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
  ids.msk = msk.json().id;
  ids.nsk = nsk.json().id;
  for (const [slug, city] of [['arbat', ids.msk], ['tverskaya', ids.msk], ['akadem', ids.nsk]] as const) {
    const b = await req('owner', 'POST', '/branches', { cityId: city, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
  }
  await staff('director', 'director', { branch: ids.arbat });
  await staff('admin', 'admin', { branch: ids.arbat });
});
beforeEach(() => {
  nowMs += 60_000;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('GET /settings', () => {
  it('Владелец, филиал: все ключи, системный источник, пределы из схемы, где можно менять', async () => {
    const r = await req('owner', 'GET', `/settings${q('branch', ids.arbat)}`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.scope).toMatchObject({ level: 'branch', id: ids.arbat, name: 'arbat', timezone: 'Europe/Moscow', today: '2026-11-14', city: { id: ids.msk, name: 'Москва' } });
    const w = (body.items as Item[]).find((i) => i.key === 'booking.window_default_days')!;
    expect(w).toMatchObject({ value: 7, editable: true, levelAllowed: true, rowVersion: 'none', source: { level: 'system', own: false } });
    expect(w.constraints).toEqual({ kind: 'integer', min: 1, max: 30, nullable: false });
    const hold = (body.items as Item[]).find((i) => i.key === 'booking.hold_minutes')!;
    expect(hold).toMatchObject({ levelAllowed: false, editable: false });
    expect((body.items as Item[]).find((i) => i.key === 'certificate.sale_methods')!.constraints).toMatchObject({ kind: 'multi', minItems: 1 });
  });

  it('уровень и id обязательны; чужой и несуществующий филиал – одинаковый 404; Администратор – 403', async () => {
    expect((await req('owner', 'GET', '/settings')).statusCode).toBe(400);
    expect((await req('owner', 'GET', '/settings?scope=branch')).statusCode).toBe(400);
    const foreign = await req('director', 'GET', `/settings${q('branch', ids.tverskaya)}`);
    const missing = await req('director', 'GET', `/settings${q('branch', randomUUID())}`);
    expect(foreign.statusCode).toBe(404);
    expect(bodyWithoutRequestId(foreign.json())).toEqual(bodyWithoutRequestId(missing.json()));
    expect((await req('owner', 'GET', `/settings${q('city', randomUUID())}`)).statusCode).toBe(404);
    expect((await req('director', 'GET', `/settings${q('network')}`)).statusCode).toBe(403);
    expect((await req('admin', 'GET', `/settings${q('branch', ids.arbat)}`)).json().error.code).toBe('FORBIDDEN');
  });
});

describe('PUT /settings/{key}', () => {
  it('Владелец меняет окно филиала с сегодня: свой уровень сразу; повтор ключа – тот же ответ, одна строка', async () => {
    const before = await item('owner', 'branch', ids.arbat, 'booking.window_default_days');
    const key = randomUUID();
    const payload = { value: 10, validFrom: '2026-11-14', rowVersion: before.rowVersion, reason: 'праздники' };
    const a = await req('owner', 'PUT', `/settings/booking.window_default_days${q('branch', ids.arbat)}`, payload, key);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ key: 'booking.window_default_days', value: 10, source: { level: 'branch', own: true, validFrom: new Date(nowMs).toISOString() } });
    const b = await req('owner', 'PUT', `/settings/booking.window_default_days${q('branch', ids.arbat)}`, payload, key);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const n = await db.client.query(`SELECT count(*)::int n FROM app.settings_values WHERE key = 'booking.window_default_days'`);
    expect(n.rows[0].n).toBe(1);
    const audit = await db.client.query(`SELECT action, branch_id, reason FROM journal.audit_events WHERE action = 'setting.changed'`);
    expect(audit.rows).toEqual([{ action: 'setting.changed', branch_id: ids.arbat, reason: 'праздники' }]);
    expect((await req('owner', 'PUT', `/settings/booking.window_default_days${q('branch', ids.arbat)}`, payload, null)).statusCode).toBe(400);
  });

  it('устаревший rowVersion – 409 VERSION_CONFLICT с текущим видом; прошлая дата – 400; будущая – в «будущих изменениях»', async () => {
    const stale = await req('owner', 'PUT', `/settings/booking.window_default_days${q('branch', ids.arbat)}`, { value: 12, validFrom: '2026-11-14', rowVersion: 'none' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'VERSION_CONFLICT', details: { current: { value: 10 } } });
    const cur = await item('owner', 'branch', ids.arbat, 'booking.window_default_days');
    const past = await req('owner', 'PUT', `/settings/booking.window_default_days${q('branch', ids.arbat)}`, { value: 12, validFrom: '2026-11-13', rowVersion: cur.rowVersion });
    expect(past.statusCode).toBe(400);
    expect(past.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'validFrom', today: '2026-11-14' } });
    const future = await req('owner', 'PUT', `/settings/booking.window_default_days${q('branch', ids.arbat)}`, { value: 12, validFrom: '2026-11-20', rowVersion: cur.rowVersion });
    expect(future.statusCode).toBe(200);
    expect(future.json().value).toBe(10);
    expect(future.json().upcoming).toEqual([{ valueId: expect.any(String), level: 'branch', value: 12, validFrom: '2026-11-19T21:00:00.000Z' }]);
  });

  it('окно max меньше default – 422 SETTING_INVALID, ничего не сохранено; вне пределов и уровень не тот – 422', async () => {
    const max = await item('owner', 'branch', ids.akadem, 'booking.window_max_days');
    const bad = await req('owner', 'PUT', `/settings/booking.window_max_days${q('branch', ids.akadem)}`, { value: 5, validFrom: '2026-11-14', rowVersion: max.rowVersion });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('SETTING_INVALID');
    expect((await item('owner', 'branch', ids.akadem, 'booking.window_max_days')).source.level).toBe('system');
    const range = await req('owner', 'PUT', `/settings/booking.window_max_days${q('branch', ids.akadem)}`, { value: 91, validFrom: '2026-11-14', rowVersion: 'none' });
    expect(range.json().error.code).toBe('SETTING_INVALID');
    const level = await req('owner', 'PUT', `/settings/booking.hold_minutes${q('branch', ids.akadem)}`, { value: 20, validFrom: '2026-11-14', rowVersion: 'none' });
    expect(level.json().error.code).toBe('SETTING_LEVEL_NOT_ALLOWED');
    expect((await req('owner', 'PUT', `/settings/nope.key${q('network')}`, { value: 1, validFrom: '2026-11-14', rowVersion: 'none' })).statusCode).toBe(404);
  });

  it('сеть: дата – полночь самого западного города; город: филиал видит «унаследовано от города»', async () => {
    const net = await req('owner', 'PUT', `/settings/booking.hold_minutes${q('network')}`, { value: 20, validFrom: '2026-11-16', rowVersion: 'none' });
    expect(net.statusCode).toBe(200);
    expect(net.json().upcoming[0].validFrom).toBe('2026-11-15T21:00:00.000Z'); // 00:00 Москвы, в Новосибирске уже 04:00
    const city = await req('owner', 'PUT', `/settings/visit.arrive_early_min${q('city', ids.nsk)}`, { value: 60, validFrom: '2026-11-14', rowVersion: 'none' });
    expect(city.statusCode).toBe(200);
    expect(await item('owner', 'branch', ids.akadem, 'visit.arrive_early_min')).toMatchObject({ value: 60, source: { level: 'city', own: false, cityName: 'Новосибирск' } });
  });
});

describe('POST /settings/{key}/reset и история', () => {
  it('возврат к наследованию: значение сети/системы, своя строка в истории «завершено»', async () => {
    const put = await req('owner', 'PUT', `/settings/booking.buffer_minutes${q('branch', ids.tverskaya)}`, { value: 15, validFrom: '2026-11-14', rowVersion: 'none' });
    expect(put.statusCode).toBe(200);
    nowMs += 60_000;
    const r = await req('owner', 'POST', `/settings/booking.buffer_minutes/reset${q('branch', ids.tverskaya)}`, { rowVersion: put.json().rowVersion, reason: 'не нужно' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ value: 0, source: { level: 'system', own: false } });
    const h = await req('owner', 'GET', `/settings/booking.buffer_minutes/history${q('branch', ids.tverskaya)}`);
    expect(h.json().items).toEqual([expect.objectContaining({ level: 'branch', value: 15, own: true, status: 'ended' })]);
    const audit = await db.client.query(`SELECT reason FROM journal.audit_events WHERE action = 'setting.reset_to_inherited'`);
    expect(audit.rows).toEqual([{ reason: 'не нужно' }]);
  });
});

describe('права K1', () => {
  it('Директор: окно своего филиала менять может, ключи Э2 – нет (403, отказ в аудите); чужой филиал – 404', async () => {
    const list = (await req('director', 'GET', `/settings${q('branch', ids.arbat)}`)).json().items as Item[];
    expect(list.find((i) => i.key === 'booking.window_max_days')!.editable).toBe(true);
    const cash = list.find((i) => i.key === 'finance.negative_balance_allowed')!;
    expect(cash).toMatchObject({ levelAllowed: true, editable: false });
    const r = await req('director', 'PUT', `/settings/finance.negative_balance_allowed${q('branch', ids.arbat)}`, { value: true, validFrom: '2026-11-14', rowVersion: cash.rowVersion });
    expect(r.statusCode).toBe(403);
    const denied = await db.client.query(`SELECT action, branch_id FROM journal.audit_events WHERE actor_id = $1 AND result = 'denied'`, [ids.director]);
    expect(denied.rows).toEqual([{ action: 'setting.changed', branch_id: ids.arbat }]);
    expect((await req('director', 'PUT', `/settings/booking.window_max_days${q('branch', ids.tverskaya)}`, { value: 40, validFrom: '2026-11-14', rowVersion: 'none' })).statusCode).toBe(404);
    expect((await req('admin', 'POST', `/settings/booking.window_max_days/reset${q('branch', ids.arbat)}`, { rowVersion: 'none' })).statusCode).toBe(403);
  });
});
