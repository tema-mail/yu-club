// S1-14 по HTTP (K11 №18 «тарифы», право tariff.manage – только Владелец): создание с Idempotency-Key, конфликт приоритета,
// изменение и архив, список для сотрудников зоны, IDOR (чужой филиал – 404 как несуществующий), отказ в аудит.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-тарифа-проверка-1';
const BASE = '/api/crm/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  ids[key] = r.rows[0]!.id;
  if (branch) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`,
      [r.rows[0]!.id, branch],
    );
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

function req(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}

const bodyWithoutRequestId = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });
const pc = { resourceType: 'pc', name: 'ПК базовый', unitMinutes: 30, pricePerUnitKop: 15_000, validFrom: '2026-01-01T00:00:00Z' };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const clock = fixedClock('2026-11-14T05:00:00Z');
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  await staff('owner', 'owner');
  const c = await req('owner', 'POST', '/cities', { slug: 'msk', name: 'Москва', timezone: 'Europe/Moscow' });
  for (const slug of ['arbat', 'tverskaya']) {
    const b = await req('owner', 'POST', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
  }
  await staff('director', 'director', ids.arbat);
  await staff('admin', 'admin', ids.arbat);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('тарифы в CRM', () => {
  it('создание – 201; повтор с тем же ключом – тот же ответ, одна запись; без ключа – 400', async () => {
    expect((await req('owner', 'POST', `/branches/${ids.arbat}/tariffs`, pc, null)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const a = await req('owner', 'POST', `/branches/${ids.arbat}/tariffs`, pc, key);
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ branchId: ids.arbat, resourceType: 'pc', pricePerUnitKop: 15_000, status: 'active', priority: 0 });
    const b = await req('owner', 'POST', `/branches/${ids.arbat}/tariffs`, pc, key);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const n = await db.client.query('SELECT count(*)::int n FROM app.tariffs');
    expect(n.rows[0].n).toBe(1);
    ids.pc = a.json().id;
  });

  it('второй тариф того же приоритета – 409 TARIFF_PRIORITY_CONFLICT; с другим приоритетом – 201', async () => {
    const dup = await req('owner', 'POST', `/branches/${ids.arbat}/tariffs`, { ...pc, name: 'дубль' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ code: 'TARIFF_PRIORITY_CONFLICT', details: { tariffId: ids.pc } });
    const promo = await req('owner', 'POST', `/branches/${ids.arbat}/tariffs`, { ...pc, name: 'акция', priority: 5 });
    expect(promo.statusCode).toBe(201);
    const bad = await req('owner', 'POST', `/branches/${ids.arbat}/tariffs`, { ...pc, unitMinutes: 0 });
    expect(bad.statusCode).toBe(400);
  });

  it('изменение конца действия и архив; архивный – 409', async () => {
    const u = await req('owner', 'PATCH', `/tariffs/${ids.pc}`, { validTo: '2026-12-01T00:00:00Z' });
    expect(u.statusCode).toBe(200);
    expect(u.json().validTo).toBe('2026-12-01T00:00:00.000Z');
    const a = await req('owner', 'POST', `/tariffs/${ids.pc}/archive`);
    expect(a.json().status).toBe('archived');
    const again = await req('owner', 'POST', `/tariffs/${ids.pc}/archive`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('TARIFF_ARCHIVED');
  });

  it('список: Администратор своего филиала видит; чужой филиал – 404 с телом несуществующего', async () => {
    const list = await req('admin', 'GET', `/branches/${ids.arbat}/tariffs?status=active`);
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((t: { name: string }) => t.name)).toEqual(['акция']);
    const foreign = await req('admin', 'GET', `/branches/${ids.tverskaya}/tariffs`);
    const missing = await req('admin', 'GET', `/branches/${randomUUID()}/tariffs`);
    expect(foreign.statusCode).toBe(404);
    expect(bodyWithoutRequestId(foreign.json())).toEqual(bodyWithoutRequestId(missing.json()));
  });

  it('Директор – 403 (tariff.manage только Владелец), отказ записан в аудит', async () => {
    const r = await req('director', 'POST', `/branches/${ids.arbat}/tariffs`, { ...pc, resourceType: 'vr_seat', unitMinutes: 15 });
    expect(r.statusCode).toBe(403);
    const a = await db.client.query(`SELECT action, result, branch_id FROM journal.audit_events WHERE actor_id = $1 AND result = 'denied'`, [ids.director]);
    expect(a.rows).toEqual([{ action: 'tariff.created', result: 'denied', branch_id: ids.arbat }]);
    expect((await req('director', 'POST', `/branches/${ids.tverskaya}/tariffs`, pc)).statusCode).toBe(404);
  });
});
