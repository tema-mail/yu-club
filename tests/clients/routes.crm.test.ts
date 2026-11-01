import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-для-клиентов-1';
const BR_1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const URL = '/api/crm/v1/clients';

let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const clock = fixedClock('2026-11-20T07:00:00Z');
const cookies: Record<string, string> = {};
let clientId = '';

async function addStaff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Имя', 'Фамилия', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  if (branch) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`,
      [r.rows[0]!.id, branch],
    );
  }
  const res = await app.inject({ method: 'POST', url: '/api/crm/v1/auth/login', payload: { email: `${key}@yu.test`, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

const get = (key: string | null, url: string) => app.inject({ method: 'GET', url, headers: key ? { cookie: cookies[key]! } : {} });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock } });
  await addStaff('owner', 'owner');
  await addStaff('admin', 'admin', BR_1);
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, first_name, last_name, email, status, registered_at, created_by_type)
     VALUES ('+79131234567', 'Ольга', 'Смирнова', 'olga@yu.test', 'active', now(), 'system') RETURNING id`,
  );
  clientId = r.rows[0]!.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('GET /clients', () => {
  it('без входа – 401 AUTH_REQUIRED', async () => {
    const res = await get(null, `${URL}?q=Смирнова`);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('Владелец находит по ФИО и по 4 цифрам; телефон маскирован', async () => {
    for (const q of ['Смирнова', '4567']) {
      const res = await get('owner', `${URL}?q=${encodeURIComponent(q)}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        items: [{ id: clientId, status: 'active', firstName: 'Ольга', lastName: 'Смирнова', phoneMasked: '+7 ••• ••• ••-67', lastVisitAt: null, lastBranchId: null }],
        nextCursor: null,
      });
      expect(res.body).not.toContain('1234567');
    }
  });

  it('Администратор: по ФИО чужого клиента нет, по точному телефону – есть', async () => {
    expect((await get('admin', `${URL}?q=Смирнова`)).json().items).toEqual([]);
    const res = await get('admin', `${URL}?q=${encodeURIComponent('8 913 123-45-67')}`);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([clientId]);
  });

  it('фильтр статуса и кривые параметры', async () => {
    expect((await get('owner', `${URL}?status=guest,blocked`)).json().items).toEqual([]);
    expect((await get('owner', `${URL}?status=nope`)).statusCode).toBe(400);
    expect((await get('owner', `${URL}?limit=500`)).statusCode).toBe(400);
  });
});

describe('GET /clients/{id}', () => {
  it('Владелец – полная карточка', async () => {
    const res = await get('owner', `${URL}/${clientId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: clientId, phoneMasked: '+7 ••• ••• ••-67', full: { phoneE164: '+79131234567', email: 'olga@yu.test' } });
  });

  it('Администратору клиент вне зоны – 404 с телом как у несуществующего', async () => {
    const foreign = await get('admin', `${URL}/${clientId}`);
    const missing = await get('admin', `${URL}/00000000-0000-4000-8000-000000000000`);
    expect(foreign.statusCode).toBe(404);
    const strip = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });
    expect(strip(foreign.json())).toEqual(strip(missing.json()));
    expect(foreign.body).not.toContain('Смирнова');
  });
});
