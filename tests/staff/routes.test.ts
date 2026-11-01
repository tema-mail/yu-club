import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-для-маршрутов-1';
const CITY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const BR_B1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const BASE = '/api/crm/v1/auth';

let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const clock = fixedClock('2026-11-20T07:00:00Z');
const ids: Record<string, string> = {};

async function addStaff(key: string, role: string, assign?: { city?: string; branch?: string }) {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Имя', 'Фамилия', $1, $2, $3) RETURNING id`,
    [`${key.toLowerCase()}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  ids[key] = r.rows[0]!.id;
  if (assign) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, created_by)
       VALUES ($1, $2, $3, $4, '2026-01-01', $1)`,
      [ids[key], assign.city ? 'city' : 'branch', assign.city ?? null, assign.branch ?? null],
    );
  }
}

async function loginAs(key: string, ip = '10.9.0.1'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `${BASE}/login`, payload: { email: `${key}@yu.test`, password: PASSWORD }, remoteAddress: ip });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']);
  return cookie.split(';')[0]!;
}

const session = (cookie: string) => app.inject({ method: 'GET', url: `${BASE}/session`, headers: { cookie } });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  // Город A ещё не раскрывается в филиалы (модуль network – S0-11): Директору даём город и филиал отдельно.
  await addStaff('owner', 'owner');
  await addStaff('director', 'director', { city: CITY_A });
  await addStaff('director2', 'director', { city: CITY_A });
  await addStaff('adminA', 'admin', { city: CITY_A });
  await addStaff('adminB', 'admin', { branch: BR_B1 });
  await addStaff('loner', 'admin');
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock },
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('POST /login', () => {
  it('200, кука HttpOnly; Secure; SameSite=Strict; Path=/, токена в теле нет', async () => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/login`, payload: { email: 'OWNER@yu.test', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      staff: { id: ids.owner, firstName: 'Имя', lastName: 'Фамилия', role: 'owner', mustChangePassword: false },
      totpRequired: false,
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^yu_staff=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=259200$/);
    expect(res.body).not.toContain(cookie.split(';')[0]!.slice('yu_staff='.length));
  });

  it('неверный пароль – 401 INVALID_CREDENTIALS в теле ADR 0002', async () => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/login`, payload: { email: 'owner@yu.test', password: 'нет' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Неверная почта или пароль', requestId: expect.any(String) } });
  });

  it('кривое тело – 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/login`, payload: { email: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('10 неверных → 429 LOGIN_LOCKED с Retry-After', async () => {
    for (let i = 0; i < 10; i += 1) {
      await app.inject({ method: 'POST', url: `${BASE}/login`, payload: { email: 'loner@yu.test', password: `bad-${i}` }, remoteAddress: '10.9.9.9' });
    }
    const res = await app.inject({ method: 'POST', url: `${BASE}/login`, payload: { email: 'loner@yu.test', password: PASSWORD }, remoteAddress: '10.9.9.9' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('LOGIN_LOCKED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('сессия и выход', () => {
  it('без куки – AUTH_REQUIRED; с кукой – 200; после выхода – SESSION_REVOKED', async () => {
    expect((await app.inject({ method: 'GET', url: `${BASE}/session` })).json().error.code).toBe('AUTH_REQUIRED');
    const cookie = await loginAs('director');
    const ok = await session(cookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ staff: { id: ids.director, role: 'director' }, expiresAt: '2026-11-23T07:00:00.000Z' });

    const out = await app.inject({ method: 'POST', url: `${BASE}/logout`, headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    const after = await session(cookie);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('SESSION_REVOKED');
  });

  it('смена пароля: слабый – 422, верный – 204', async () => {
    const cookie = await loginAs('director2');
    const weak = await app.inject({
      method: 'POST', url: `${BASE}/password`, headers: { cookie }, payload: { currentPassword: PASSWORD, newPassword: 'short' },
    });
    expect(weak.statusCode).toBe(422);
    const res = await app.inject({
      method: 'POST', url: `${BASE}/password`, headers: { cookie }, payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('блокировка и права (K1)', () => {
  it('Владелец блокирует Администратора – его сессия умирает на следующем запросе', async () => {
    const adminCookie = await loginAs('adminB');
    expect((await session(adminCookie)).statusCode).toBe(200);
    const ownerCookie = await loginAs('owner');
    const res = await app.inject({
      method: 'POST', url: `${BASE}/staff/${ids.adminB}/block`, headers: { cookie: ownerCookie }, payload: { rowVersion: 1, reason: 'проверка' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'blocked', rowVersion: 2 });
    expect((await session(adminCookie)).json().error.code).toBe('SESSION_REVOKED');

    const stale = await app.inject({
      method: 'POST', url: `${BASE}/staff/${ids.adminB}/unblock`, headers: { cookie: ownerCookie }, payload: { rowVersion: 1, reason: 'x' },
    });
    expect(stale.statusCode).toBe(409);
    const un = await app.inject({
      method: 'POST', url: `${BASE}/staff/${ids.adminB}/unblock`, headers: { cookie: ownerCookie }, payload: { rowVersion: 2, reason: 'вернули' },
    });
    expect(un.json()).toEqual({ status: 'active', rowVersion: 3 });
  });

  it('Директор: директора – 403, администратора чужой зоны и сотрудника без зоны – 404, своей зоны – 200', async () => {
    const cookie = await loginAs('director');
    const post = (id: string, op = 'block') =>
      app.inject({ method: 'POST', url: `${BASE}/staff/${id}/${op}`, headers: { cookie }, payload: { rowVersion: 1, reason: 'r' } });
    expect((await post(ids.director2!)).statusCode).toBe(403);
    expect((await post(ids.owner!)).statusCode).toBe(403);
    const foreign = await post(ids.adminB!);
    const missing = await post('ffffffff-0000-4000-8000-000000000000');
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(missing.json().error.code);
    expect((await post(ids.loner!)).statusCode).toBe(404);
    expect((await post(ids.director!)).statusCode).toBe(403); // себя тоже нельзя
    const endS = await app.inject({
      method: 'POST', url: `${BASE}/staff/${ids.adminA}/end-sessions`, headers: { cookie }, payload: { reason: 'смена смены' },
    });
    expect(endS.statusCode).toBe(204);
    expect((await post(ids.adminA!)).statusCode).toBe(200);

    const denied = await db.client.query(
      "SELECT count(*)::int AS n FROM journal.audit_events WHERE result = 'denied' AND actor_id = $1",
      [ids.director],
    );
    expect(denied.rows[0].n).toBe(6);
  });

  it('Администратор сотрудниками не управляет – 403', async () => {
    await addStaff('adminC', 'admin', { city: CITY_A });
    const cookie = await loginAs('adminC');
    const res = await app.inject({
      method: 'POST', url: `${BASE}/staff/${ids.loner}/end-sessions`, headers: { cookie }, payload: { reason: 'r' },
    });
    expect(res.statusCode).toBe(404);
    const res2 = await app.inject({
      method: 'POST', url: `${BASE}/staff/${ids.director2}/end-sessions`, headers: { cookie }, payload: { reason: 'r' },
    });
    expect(res2.statusCode).toBe(403);
  });
});
