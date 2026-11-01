// S0-11 по HTTP (K11 №18): Владелец создаёт город и филиал; IDOR по прямому ID; архив; смена зоны; аудит;
// ответ GET /branches совпадает по полям с моком CRM (apps/crm/tests/mock-api.ts).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-сети-проверка-1';
const BASE = '/api/crm/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

async function staff(key: string, role: string, scope?: { city?: string; branch?: string }): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  if (scope) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', $1)`,
      [r.rows[0]!.id, scope.city ? 'city' : 'branch', scope.city ?? null, scope.branch ?? null],
    );
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

function req(who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}

const bodyWithoutRequestId = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const clock = fixedClock('2026-11-14T05:00:00Z');
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('n'.repeat(40)), clock } });
  await staff('owner', 'owner');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('Владелец создаёт город и филиал', () => {
  it('POST /cities и /branches → 201; филиал в зоне города, «готовится», с графиком', async () => {
    const c = await req('owner', 'POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
    expect(c.statusCode).toBe(201);
    ids.nsk = c.json().id;
    const t = await req('owner', 'POST', '/cities', { slug: 'tsk', name: 'Томск', timezone: 'Asia/Tomsk' });
    ids.tsk = t.json().id;
    for (const [k, city, slug, name] of [
      ['krasny', ids.nsk, 'krasny', 'Ю Клуб на Красном'],
      ['akadem', ids.nsk, 'akadem', 'Ю Клуб Академгородок'],
      ['lenina', ids.tsk, 'lenina', 'Ю Клуб на Ленина'],
    ] as const) {
      const b = await req('owner', 'POST', '/branches', { cityId: city, slug, name, address: 'адрес' });
      expect(b.statusCode).toBe(201);
      ids[k] = b.json().id;
    }
    const k = await req('owner', 'GET', `/branches/${ids.krasny}`);
    expect(k.json()).toMatchObject({ status: 'preparing', timezone: 'Asia/Novosibirsk', cityName: 'Новосибирск', rowVersion: 1 });
    const h = await db.client.query('SELECT count(*)::int n FROM app.branch_weekly_hours WHERE branch_id = $1', [ids.krasny]);
    expect(h.rows[0].n).toBe(7);
  });

  it('без Idempotency-Key – 400; повтор с тем же ключом – тот же ответ и одна запись', async () => {
    const no = await req('owner', 'POST', '/cities', { slug: 'omsk', name: 'Омск', timezone: 'Asia/Omsk' }, null);
    expect(no.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const a = await req('owner', 'POST', '/cities', { slug: 'omsk', name: 'Омск', timezone: 'Asia/Omsk' }, key);
    const b = await req('owner', 'POST', '/cities', { slug: 'omsk', name: 'Омск', timezone: 'Asia/Omsk' }, key);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const n = await db.client.query(`SELECT count(*)::int n FROM app.cities WHERE slug = 'omsk'`);
    expect(n.rows[0].n).toBe(1);
  });

  it('GET /branches – поля мока CRM, порциями по nextCursor до конца', async () => {
    const p1 = await req('owner', 'GET', '/branches?limit=2');
    expect(p1.statusCode).toBe(200);
    const page1 = p1.json() as { items: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const p2 = (await req('owner', 'GET', `/branches?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`)).json();
    expect(p2.nextCursor).toBeNull();
    const all = [...page1.items, ...p2.items];
    expect(all.map((b) => b.slug)).toEqual(['akadem', 'krasny', 'lenina']);
    const mockKeys = ['id', 'cityId', 'cityName', 'slug', 'name', 'address', 'timezone', 'status'];
    for (const b of all) for (const k of mockKeys) expect(b).toHaveProperty(k);
    expect(all[2]).toMatchObject({ cityName: 'Томск', timezone: 'Asia/Tomsk', status: 'preparing' });
    expect((await req('owner', 'GET', '/branches?limit=101')).statusCode).toBe(400);
  });
});

describe('права: Администратор чужого филиала', () => {
  beforeAll(async () => {
    await staff('admin', 'admin', { branch: ids.krasny! });
    await staff('director', 'director', { city: ids.nsk! });
  });

  it('список – только свой филиал; чужой по прямому ID – 404 с телом несуществующего', async () => {
    const list = (await req('admin', 'GET', '/branches')).json();
    expect(list.items.map((b: { id: string }) => b.id)).toEqual([ids.krasny]);
    const foreign = await req('admin', 'GET', `/branches/${ids.lenina}`);
    const missing = await req('admin', 'GET', `/branches/${randomUUID()}`);
    const garbage = await req('admin', 'GET', '/branches/b-nsk-krasny');
    expect(foreign.statusCode).toBe(404);
    expect(bodyWithoutRequestId(foreign.json())).toEqual(bodyWithoutRequestId(missing.json()));
    expect(bodyWithoutRequestId(garbage.json())).toEqual(bodyWithoutRequestId(missing.json()));
  });

  it('изменение чужого по прямому ID – 404 и отказ в аудите; своего – 403', async () => {
    const r = await req('admin', 'PATCH', `/branches/${ids.lenina}`, { rowVersion: 1, name: 'Взлом' });
    expect(r.statusCode).toBe(404);
    const a = await db.client.query(`SELECT action, result, reason FROM journal.audit_events WHERE object_id = $1 AND result = 'denied'`, [ids.lenina]);
    expect(a.rows).toEqual([{ action: 'branch.updated', result: 'denied', reason: 'NOT_FOUND: network.branch.update' }]);
    expect((await req('admin', 'PATCH', `/branches/${ids.krasny}`, { rowVersion: 1, name: 'X' })).statusCode).toBe(403);
    expect((await req('admin', 'POST', '/cities', { slug: 'x', name: 'X', timezone: 'Asia/Omsk' })).statusCode).toBe(403);
    expect((await req('owner', 'GET', `/branches/${ids.lenina}`)).json().name).toBe('Ю Клуб на Ленина');
  });

  it('Директор города меняет карточку, аудит хранит было/стало; чужой город – 404', async () => {
    const r = await req('director', 'PATCH', `/branches/${ids.akadem}`, { rowVersion: 1, address: 'Морской проспект, 2' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ address: 'Морской проспект, 2', rowVersion: 2 });
    const a = await db.client.query(`SELECT before, after FROM journal.audit_events WHERE action = 'branch.updated' AND object_id = $1 AND result = 'success'`, [ids.akadem]);
    expect(a.rows).toEqual([{ before: { address: 'адрес' }, after: { address: 'Морской проспект, 2' } }]);
    expect((await req('director', 'PATCH', `/branches/${ids.akadem}`, { rowVersion: 1, address: 'x' })).json().error.code).toBe('VERSION_CONFLICT');
    expect((await req('director', 'GET', `/branches/${ids.lenina}`)).statusCode).toBe(404);
  });

  it('несуществующий id = чужой id (код и тело) для Администратора и Директора на всех командах филиала', async () => {
    const cases: Array<[string, (id: string) => [string, object]]> = [
      ['PATCH', (id) => [`/branches/${id}`, { rowVersion: 1, name: 'Взлом' }]],
      ['POST', (id) => [`/branches/${id}/status`, { rowVersion: 1, status: 'active' }]],
      ['POST', (id) => [`/branches/${id}/archive`, { rowVersion: 1 }]],
      ['POST', (id) => [`/branches/${id}/timezone`, { rowVersion: 1, timezone: 'Asia/Omsk' }]],
    ];
    for (const who of ['admin', 'director']) {
      for (const [method, mk] of cases) {
        const [fu, fb] = mk(ids.lenina!);
        const [mu, mb] = mk(randomUUID());
        const foreign = await req(who, method as 'PATCH' | 'POST', fu, fb);
        const missing = await req(who, method as 'PATCH' | 'POST', mu, mb);
        expect([who, fu, foreign.statusCode]).toEqual([who, fu, 404]);
        expect(missing.statusCode).toBe(404);
        expect(bodyWithoutRequestId(foreign.json())).toEqual(bodyWithoutRequestId(missing.json()));
      }
      const foreignCity = await req(who, 'POST', '/branches', { cityId: ids.tsk, slug: 'hack', name: 'H', address: 'a' });
      const missingCity = await req(who, 'POST', '/branches', { cityId: randomUUID(), slug: 'hack', name: 'H', address: 'a' });
      expect(foreignCity.statusCode).toBe(404);
      expect(bodyWithoutRequestId(foreignCity.json())).toEqual(bodyWithoutRequestId(missingCity.json()));
    }
    // своя зона без права – 403 (существование не секрет): Администратор и создание в своём городе
    expect((await req('admin', 'POST', '/branches', { cityId: ids.nsk, slug: 'hack', name: 'H', address: 'a' })).statusCode).toBe(403);
    expect((await req('owner', 'GET', `/branches/${ids.lenina}`)).json()).toMatchObject({ name: 'Ю Клуб на Ленина', status: 'preparing', rowVersion: 1 });
  });

  it('мусорный курсор (не base64, не JSON, неверные типы) – 400, не 500', async () => {
    const bad = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const c of ['мусор', bad({ a: 1 }), bad(['x', 'не число', 'y', 'не uuid']), bad(['x', 1, 'y', 'zzz']), bad(['x', 1.5, 'y', randomUUID()])]) {
      const r = await req('owner', 'GET', `/branches?cursor=${encodeURIComponent(c)}`);
      expect([c, r.statusCode, r.json().error.code]).toEqual([c, 400, 'VALIDATION_FAILED']);
    }
    expect((await req('owner', 'GET', `/cities?cursor=${bad(['x', 'не uuid'])}`)).statusCode).toBe(400);
  });

  it('архив города – с rowVersion: без версии 400, устаревшая – VERSION_CONFLICT', async () => {
    expect((await req('owner', 'POST', `/cities/${ids.tsk}/archive`, {})).json().error.code).toBe('VALIDATION_FAILED');
    expect((await req('owner', 'POST', `/cities/${ids.tsk}/archive`, { rowVersion: 7 })).json().error.code).toBe('VERSION_CONFLICT');
  });
});

describe('архив и зона', () => {
  it('DELETE нет; архив филиала – запись остаётся, видна с includeArchived; город с филиалами – 409', async () => {
    expect((await req('owner', 'DELETE', `/branches/${ids.lenina}`)).statusCode).toBe(404);
    expect((await req('owner', 'POST', `/cities/${ids.tsk}/archive`, { rowVersion: 1 })).json().error.code).toBe('CITY_HAS_ACTIVE_BRANCHES');
    const r = await req('owner', 'POST', `/branches/${ids.lenina}/archive`, { rowVersion: 1 });
    expect(r.json()).toMatchObject({ status: 'archived' });
    const visible = (await req('owner', 'GET', '/branches')).json().items.map((b: { id: string }) => b.id);
    expect(visible).not.toContain(ids.lenina);
    const withArchived = (await req('owner', 'GET', '/branches?includeArchived=true')).json().items.map((b: { id: string }) => b.id);
    expect(withArchived).toContain(ids.lenina);
    expect((await req('owner', 'POST', `/cities/${ids.tsk}/archive`, { rowVersion: 1 })).json()).toMatchObject({ status: 'archived' });
  });

  it('смена зоны: прошлые моменты на месте, в аудите было/стало зоны', async () => {
    const before = await db.client.query('SELECT created_at FROM app.branches WHERE id = $1', [ids.krasny]);
    const audits = await db.client.query('SELECT occurred_at FROM journal.audit_events WHERE object_id = $1 ORDER BY occurred_at', [ids.krasny]);
    const r = await req('owner', 'POST', `/branches/${ids.krasny}/timezone`, { rowVersion: 1, timezone: 'Asia/Omsk' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ branch: { timezone: 'Asia/Omsk' }, affectedBookingIds: [] });
    expect((await db.client.query('SELECT created_at FROM app.branches WHERE id = $1', [ids.krasny])).rows).toEqual(before.rows);
    const after = await db.client.query('SELECT occurred_at FROM journal.audit_events WHERE object_id = $1 ORDER BY occurred_at', [ids.krasny]);
    expect(after.rows.slice(0, audits.rows.length)).toEqual(audits.rows);
    const a = await db.client.query(`SELECT before, after FROM journal.audit_events WHERE action = 'branch.updated' AND object_id = $1 AND result = 'success'`, [ids.krasny]);
    expect(a.rows).toEqual([{ before: { timezone: 'Asia/Novosibirsk' }, after: { timezone: 'Asia/Omsk' } }]);
    expect((await req('owner', 'POST', `/branches/${ids.krasny}/timezone`, { rowVersion: 2, timezone: 'Nowhere/City' })).json().error.code).toBe('INVALID_TIMEZONE');
  });

  it('без входа – 401', async () => {
    expect((await app.inject({ method: 'GET', url: `${BASE}/branches` })).statusCode).toBe(401);
  });
});
