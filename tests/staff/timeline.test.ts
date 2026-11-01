import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { writeAudit, type AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-хронологии-1';
const BR_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BR_B = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const CITY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const URL = '/api/crm/v1/audit/timeline';

let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const clock = fixedClock('2026-11-25T07:00:00Z');
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

async function addStaff(key: string, role: string, assign?: { city?: string; branch?: string }) {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ($1, 'Тестов', $2, $3, $4) RETURNING id`,
    [key, `${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  ids[key] = r.rows[0]!.id;
  if (assign) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, created_by)
       VALUES ($1, $2, $3, $4, '2026-01-01', $1)`,
      [ids[key], assign.city ? 'city' : 'branch', assign.city ?? null, assign.branch ?? null],
    );
  }
  const res = await app.inject({ method: 'POST', url: '/api/crm/v1/auth/login', payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

const meta = (key: string, role: 'owner' | 'director' | 'admin'): AuditRequestMeta => ({
  actor: { kind: 'staff', staffId: ids[key]!, sessionId: '00000000-0000-4000-8000-000000000000' },
  access: { role, network: role === 'owner', cityIds: new Set(), branchIds: new Set() },
  source: 'crm',
  requestId: `r-${key}`,
  ip: '10.1.2.3',
});

const get = (who: string, q: string) => app.inject({ method: 'GET', url: `${URL}?${q}`, headers: { cookie: cookies[who]! } });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  await addStaff('owner', 'owner');
  await addStaff('director', 'director', { city: CITY_A });
  await addStaff('admin', 'admin', { branch: BR_A });
  await addStaff('admin2', 'admin', { branch: BR_A });

  // Филиал A: 3 события Владельца, 1 – Администратора; ПДн и секрет в after.
  for (let i = 1; i <= 3; i += 1) {
    await writeAudit(pool, meta('owner', 'owner'), {
      action: 'branch.updated', object: { type: 'branch', id: BR_A }, branchId: BR_A, after: { name: `Имя ${i}` },
    }, clock);
  }
  await writeAudit(pool, meta('admin', 'admin'), {
    action: 'branch.updated', object: { type: 'branch', id: BR_A }, branchId: BR_A,
    before: { phoneE164: '+79991234567' }, after: { phoneE164: '+79990000001', password: 'утечка-123' },
  }, clock);
  await writeAudit(pool, meta('owner', 'owner'), { action: 'branch.updated', object: { type: 'branch', id: BR_B }, branchId: BR_B }, clock);
  await writeAudit(pool, meta('owner', 'owner'), { action: 'dictionary.changed', object: { type: 'dictionary', id: 'app.dict_reasons:x' } }, clock);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('GET /audit/timeline', () => {
  it('Владелец: все события, новые сверху, порциями по курсору; формат мока CRM', async () => {
    const p1 = await get('owner', `objectType=branch&objectId=${BR_A}&limit=3`);
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json();
    expect(b1.items).toHaveLength(3);
    expect(b1.items[0]).toEqual({
      id: expect.any(String),
      at: '2026-11-25T07:00:00.000Z',
      objectType: 'branch',
      objectId: BR_A,
      action: 'branch.updated',
      result: 'success',
      actor: { type: 'staff', id: ids.admin, name: 'admin Тестов', role: 'admin' },
      before: { phoneE164: '+7******4567' },
      after: { phoneE164: '+7******0001', password: '***' },
      reason: null,
    });
    expect(p1.body).not.toContain('утечка');
    expect(p1.body).not.toContain('10.1.2.3');
    expect(b1.nextCursor).toEqual(expect.any(String));
    const p2 = (await get('owner', `objectType=branch&objectId=${BR_A}&limit=3&cursor=${b1.nextCursor}`)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0].after).toEqual({ name: 'Имя 1' });
    expect(p2.nextCursor).toBeNull();
  });

  it('Администратор: свой филиал – только свои действия; чужой – 404 как несуществующий', async () => {
    const own = (await get('admin', `objectType=branch&objectId=${BR_A}`)).json();
    expect(own.items.map((e: { actor: { id: string } }) => e.actor.id)).toEqual([ids.admin]);
    expect((await get('admin2', `objectType=branch&objectId=${BR_A}`)).json().items).toEqual([]);
    const foreign = await get('admin', `objectType=branch&objectId=${BR_B}`);
    const missing = await get('admin', 'objectType=branch&objectId=ffffffff-0000-4000-8000-000000000000');
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(missing.json().error.code);
  });

  it('сотрудник как объект: Директор – свой в зоне, Администратор – только себя; сеть у не-Владельца – 403', async () => {
    expect((await get('director', `objectType=staff&objectId=${ids.admin}`)).statusCode).toBe(404); // филиал A не в городе A без network
    expect((await get('director', `objectType=staff&objectId=${ids.director}`)).statusCode).toBe(200);
    expect((await get('admin', `objectType=staff&objectId=${ids.admin2}`)).statusCode).toBe(404);
    expect((await get('admin', `objectType=staff&objectId=${ids.admin}`)).statusCode).toBe(200);
    expect((await get('director', 'objectType=dictionary&objectId=app.dict_reasons:x')).statusCode).toBe(403);
    expect((await get('owner', 'objectType=dictionary&objectId=app.dict_reasons:x')).json().items).toHaveLength(1);
  });

  it('кривые параметры – 400, без входа – 401', async () => {
    expect((await get('owner', 'objectType=nope&objectId=1')).statusCode).toBe(400);
    expect((await get('owner', `objectType=branch&objectId=${BR_A}&cursor=abc`)).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${URL}?objectType=branch&objectId=${BR_A}` })).statusCode).toBe(401);
  });
});
