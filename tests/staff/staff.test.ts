import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { createTestBranch } from '../helpers/network.ts';

const PASSWORD = 'Пароль-сотрудников-1';
const CITY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CITY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BR_A1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BR_A2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const BR_B1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const NOBODY = 'ffffffff-0000-4000-8000-000000000000';
const P = '/api/crm/v1';

let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const clock = fixedClock('2026-11-26T07:00:00Z');
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

async function login(email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `${P}/auth/login`, payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

async function addStaff(key: string, role: string, last: string, assign: { cities?: string[]; branches?: string[] } = {}) {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [key, last, `${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  ids[key] = r.rows[0]!.id;
  for (const [kind, list] of [['city', assign.cities ?? []], ['branch', assign.branches ?? []]] as const) {
    for (const id of list) {
      await db.client.query(
        `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, created_by)
         VALUES ($1, $2, $3, $4, '2026-01-01', $1)`,
        [ids[key], kind, kind === 'city' ? id : null, kind === 'branch' ? id : null],
      );
    }
  }
  cookies[key] = await login(`${key}@yu.test`);
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url: `${P}${url}`, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

async function rowVersion(key: string): Promise<number> {
  return (await db.client.query('SELECT row_version FROM app.staff WHERE id = $1', [ids[key]])).rows[0].row_version;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  for (const [id, cityId] of [[BR_A1, CITY_A], [BR_A2, CITY_A], [BR_B1, CITY_B]] as const) await createTestBranch(db.client, { id, cityId });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('s'.repeat(40)), clock } });
  await addStaff('owner', 'owner', 'Аов');
  // Сеть ещё не раскрывает город в филиалы (S0-11) – Директору даём и город, и филиалы города.
  await addStaff('director', 'director', 'Бов', { cities: [CITY_A], branches: [BR_A1, BR_A2] });
  await addStaff('admina', 'admin', 'Вов', { branches: [BR_A1] });
  await addStaff('adminb', 'admin', 'Гов', { branches: [BR_B1] });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('доступ к экрану', () => {
  it('Администратор не видит экран: список и карточка – 403', async () => {
    expect((await call('admina', 'GET', '/staff')).statusCode).toBe(403);
    expect((await call('admina', 'GET', `/staff/${ids.admina}`)).statusCode).toBe(403);
    expect((await call('admina', 'POST', '/staff', { firstName: 'a', lastName: 'b', email: 'x@yu.test', role: 'admin', branchIds: [BR_A1] })).statusCode).toBe(403);
  });

  it('Директор видит себя и сотрудников своей зоны; фильтры и курсор', async () => {
    const all = (await call('director', 'GET', '/staff')).json();
    expect(all.items.map((s: { id: string }) => s.id)).toEqual([ids.director, ids.admina]);
    expect(all.items[1]).toMatchObject({ role: 'admin', status: 'active', rowVersion: 1, assignments: [{ scopeType: 'branch', branchId: BR_A1 }] });
    const admins = (await call('director', 'GET', '/staff?role=admin')).json();
    expect(admins.items).toHaveLength(1);
    const p1 = (await call('director', 'GET', '/staff?limit=1')).json();
    expect(p1.items).toHaveLength(1);
    const p2 = (await call('director', 'GET', `/staff?limit=1&cursor=${p1.nextCursor}`)).json();
    expect(p2.items[0].id).toBe(ids.admina);
    expect(p2.nextCursor).toBeNull();
    expect((await call('owner', 'GET', '/staff')).json().items).toHaveLength(4);
    expect((await call('owner', 'GET', '/staff?q=гов')).json().items.map((s: { id: string }) => s.id)).toEqual([ids.adminb]);
    expect((await call('owner', 'GET', '/staff?cursor=мусор')).statusCode).toBe(400);
  });

  it('IDOR: сотрудник чужой зоны – 404, как несуществующий', async () => {
    for (const [method, url, body] of [
      ['GET', '', undefined],
      ['PATCH', '', { rowVersion: 1, firstName: 'X' }],
      ['POST', '/block', { rowVersion: 1, reason: 'r' }],
    ] as const) {
      const foreign = await call('director', method, `/staff/${ids.adminb}${url}`, body);
      const missing = await call('director', method, `/staff/${NOBODY}${url}`, body);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error.code).toBe(missing.json().error.code);
    }
    expect((await call('director', 'GET', `/staff/${ids.owner}`)).statusCode).toBe(404);
  });
});

describe('создание', () => {
  it('Директор не создаёт директора (403, отказ в аудите) и администратора вне зоны (404)', async () => {
    const d = await call('director', 'POST', '/staff', { firstName: 'Д', lastName: 'Д', email: 'd2@yu.test', role: 'director', cityIds: [CITY_A] });
    expect(d.statusCode).toBe(403);
    const out = await call('director', 'POST', '/staff', { firstName: 'А', lastName: 'А', email: 'a9@yu.test', role: 'admin', branchIds: [BR_B1] });
    expect(out.statusCode).toBe(404);
    const denied = await db.client.query(
      "SELECT count(*)::int AS n FROM journal.audit_events WHERE action = 'staff.created' AND result = 'denied' AND actor_id = $1",
      [ids.director],
    );
    expect(denied.rows[0].n).toBe(2);
    expect((await call('director', 'POST', '/staff', { firstName: 'А', lastName: 'А', email: 'a8@yu.test', role: 'admin' })).statusCode).toBe(400);
    expect((await call('owner', 'POST', '/staff', { firstName: 'В', lastName: 'В', email: 'o2@yu.test', role: 'owner', cityIds: [CITY_A] })).statusCode).toBe(400);
  });

  it('Директор создаёт администратора своей зоны: временный пароль один раз, вход с обязательной сменой', async () => {
    const res = await call('director', 'POST', '/staff', {
      firstName: 'Новый', lastName: 'Админ', email: 'New.Admin@YU.test', phone: '+79991234567', role: 'admin', branchIds: [BR_A2],
    });
    expect(res.statusCode).toBe(201);
    const { staff, temporaryPassword } = res.json();
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(staff).toMatchObject({ email: 'new.admin@yu.test', role: 'admin', mustChangePassword: true, assignments: [{ branchId: BR_A2 }] });
    expect(res.headers['cache-control']).toBe('no-store');

    const again = await call('director', 'GET', `/staff/${staff.id}`);
    expect(again.body).not.toContain(temporaryPassword);
    const cookie = await login('new.admin@yu.test', temporaryPassword);
    const me = await app.inject({ method: 'GET', url: `${P}/me`, headers: { cookie } });
    expect(me.json().staff.mustChangePassword).toBe(true);

    const audit = await db.client.query(
      "SELECT after::text AS after FROM journal.audit_events WHERE action = 'staff.created' AND object_id = $1",
      [staff.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after).not.toContain(temporaryPassword);
    expect(audit.rows[0].after).toContain('n***@yu.test');
    expect((await call('director', 'POST', '/staff', { firstName: 'Н', lastName: 'А', email: 'new.admin@yu.test', role: 'admin', branchIds: [BR_A2] })).statusCode).toBe(400);
  });

  it('Владелец создаёт директора в любом городе', async () => {
    const res = await call('owner', 'POST', '/staff', { firstName: 'Дир', lastName: 'Б', email: 'dirb@yu.test', role: 'director', cityIds: [CITY_B] });
    expect(res.statusCode).toBe(201);
  });
});

describe('карточка и блокировка', () => {
  it('PATCH: имя с rowVersion и аудитом; устаревшая версия – 409; перенос вне зоны – 404; внутри – да', async () => {
    const v = await rowVersion('admina');
    const ok = await call('director', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v, firstName: 'Анна' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ firstName: 'Анна', rowVersion: v + 1 });
    expect((await call('director', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v, lastName: 'Иванова' })).statusCode).toBe(409);
    expect((await call('director', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v + 1, branchIds: [BR_B1] })).statusCode).toBe(404);
    const moved = await call('director', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v + 1, branchIds: [BR_A1, BR_A2] });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().assignments.map((a: { branchId: string }) => a.branchId).sort()).toEqual([BR_A1, BR_A2]);
    const back = await call('director', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v + 2, branchIds: [BR_A2] });
    expect(back.json().assignments.map((a: { branchId: string }) => a.branchId)).toEqual([BR_A2]);
    const a = await db.client.query(
      "SELECT action, before, after FROM journal.audit_events WHERE object_id = $1 AND result = 'success' AND action LIKE 'staff.%' ORDER BY id",
      [ids.admina],
    );
    expect(a.rows.map((r) => r.action)).toEqual(['staff.contacts_changed', 'staff.scope_changed', 'staff.scope_changed']);
    expect(a.rows[0].after).toEqual({ firstName: 'А***' });
  });

  it('роль: Директор не повышает до директора (403), Владелец – да; никто не меняет себе роль', async () => {
    const v = await rowVersion('admina');
    expect((await call('director', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v, role: 'director' })).statusCode).toBe(403);
    expect((await call('owner', 'PATCH', `/staff/${ids.owner}`, { rowVersion: 1, role: 'director' })).statusCode).toBe(403);
    const up = await call('owner', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v, role: 'director' });
    expect(up.statusCode).toBe(200);
    expect(up.json().role).toBe('director');
    // Теперь это директор – Директор его больше не трогает.
    expect((await call('director', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v + 1, firstName: 'X' })).statusCode).toBe(403);
    expect((await call('owner', 'PATCH', `/staff/${ids.admina}`, { rowVersion: v + 1, role: 'admin' })).statusCode).toBe(200);
  });

  it('блокировка завершает сессии сразу; разблокировка возвращает доступ', async () => {
    await addStaff('adminc', 'admin', 'Дов', { branches: [BR_A1] });
    const victim = cookies.adminc!;
    expect((await app.inject({ method: 'GET', url: `${P}/me`, headers: { cookie: victim } })).statusCode).toBe(200);
    const b = await call('director', 'POST', `/staff/${ids.adminc}/block`, { rowVersion: 1, reason: 'проверка' });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ status: 'blocked', rowVersion: 2 });
    const after = await app.inject({ method: 'GET', url: `${P}/me`, headers: { cookie: victim } });
    expect(after.statusCode).toBe(401);
    const sessions = await db.client.query("SELECT count(*)::int AS n FROM app.staff_sessions WHERE staff_id = $1 AND revoked_at IS NULL", [ids.adminc]);
    expect(sessions.rows[0].n).toBe(0);
    expect((await call('director', 'POST', `/staff/${ids.adminc}/unblock`, { rowVersion: 2, reason: 'вернули' })).json().status).toBe('active');
    expect((await call('director', 'POST', `/staff/${ids.director}/block`, { rowVersion: 1, reason: 'r' })).statusCode).toBe(403);
  });
});
