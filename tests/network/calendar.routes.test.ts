// S1-03 по HTTP (K11 №18 «график, исключения», право network.hours.manage): предпросмотр → применение с confirmedAffected,
// идемпотентность, IDOR (чужой филиал – 404 как несуществующий), отказ Администратору с записью в аудит.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-календаря-проверка-1';
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

function req(who: string, method: 'GET' | 'POST', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}

const bodyWithoutRequestId = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const clock = fixedClock('2026-11-14T05:00:00Z');
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock } });
  await staff('owner', 'owner');
  const c = await req('owner', 'POST', '/cities', { slug: 'msk', name: 'Москва', timezone: 'Europe/Moscow' });
  for (const slug of ['arbat', 'tverskaya']) {
    const b = await req('owner', 'POST', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
  }
  await staff('admin', 'admin', ids.arbat);
  await staff('director', 'director', ids.tverskaya);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

const shortDay = { scope: { type: 'branch' }, date: '2026-11-20', exceptionKind: 'short_day', open: '10:00', close: '18:00', reason: 'санитарный день' };

describe('исключения календаря', () => {
  it('предпросмотр → создание (201) → повтор с тем же ключом – тот же ответ, одна запись', async () => {
    const p = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions/preview`, shortDay, null);
    expect(p.statusCode).toBe(200);
    expect(p.json()).toEqual({ affectedBookingIds: [] });
    const no = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions`, { ...shortDay, confirmedAffected: [] }, null);
    expect(no.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const a = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions`, { ...shortDay, confirmedAffected: [] }, key);
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ kind: 'exception', affectedBookingIds: [], exception: { kind: 'short_day', date: '2026-11-20', status: 'active' } });
    const b = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions`, { ...shortDay, confirmedAffected: [] }, key);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const n = await db.client.query('SELECT count(*)::int n FROM app.calendar_exceptions WHERE branch_id = $1', [ids.arbat]);
    expect(n.rows[0].n).toBe(1);
    ids.exception = a.json().exception.id;
  });

  it('второе на ту же дату – 409 SCHEDULE_CONFLICT; без confirmedAffected – 400; плохие часы – 422', async () => {
    const dup = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions`, { ...shortDay, confirmedAffected: [] });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('SCHEDULE_CONFLICT');
    const noList = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions`, { ...shortDay, date: '2026-11-21' });
    expect(noList.statusCode).toBe(400);
    const bad = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions/preview`, { ...shortDay, open: '19:00' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('INVALID_HOURS');
  });

  it('исключение комнаты без модуля ресурсов – 404', async () => {
    const r = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions/preview`, { ...shortDay, scope: { type: 'room', id: randomUUID() } });
    expect(r.statusCode).toBe(404);
  });

  it('список за период; отмена с причиной – запись отменена, в аудите created + cancelled', async () => {
    const list = await req('owner', 'GET', `/branches/${ids.arbat}/calendar-exceptions?from=2026-11-01&to=2026-11-30`);
    expect(list.json().items.map((x: { id: string }) => x.id)).toEqual([ids.exception]);
    const pre = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions/${ids.exception}/cancel/preview`, { reason: 'ошибка' });
    expect(pre.json()).toEqual({ affectedBookingIds: [] });
    const c = await req('owner', 'POST', `/branches/${ids.arbat}/calendar-exceptions/${ids.exception}/cancel`, { reason: 'ошибка', confirmedAffected: [] });
    expect(c.statusCode).toBe(200);
    expect(c.json().exception.status).toBe('cancelled');
    const a = await db.client.query('SELECT action, result FROM journal.audit_events WHERE object_id = $1 ORDER BY occurred_at, action DESC', [ids.exception]);
    expect(a.rows.map((x) => x.action)).toEqual(['calendar.exception_created', 'calendar.exception_cancelled']);
    // исключение другого филиала через чужой путь – 404
    const wrong = await req('owner', 'POST', `/branches/${ids.tverskaya}/calendar-exceptions/${ids.exception}/cancel`, { reason: 'x', confirmedAffected: [] });
    expect(wrong.statusCode).toBe(404);
  });
});

describe('недельный график', () => {
  const change = { validFrom: '2026-11-16', days: [{ weekday: 1, open: '12:00', close: '20:00' }] };

  it('GET /hours – 7 строк с зоной; предпросмотр и применение с завтрашней даты', async () => {
    const h = await req('owner', 'GET', `/branches/${ids.arbat}/hours`);
    expect(h.json().timezone).toBe('Europe/Moscow');
    expect(h.json().items).toHaveLength(7);
    expect((await req('owner', 'POST', `/branches/${ids.arbat}/hours/preview`, change)).json()).toEqual({ affectedBookingIds: [] });
    const r = await req('owner', 'POST', `/branches/${ids.arbat}/hours`, { ...change, confirmedAffected: [] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'weekly', validFrom: '2026-11-16' });
    const after = (await req('owner', 'GET', `/branches/${ids.arbat}/hours`)).json().items.filter((x: { weekday: number }) => x.weekday === 1);
    expect(after.map((x: { validFrom: string; open: string }) => [x.validFrom, x.open])).toEqual([
      ['2026-11-14', '10:00'],
      ['2026-11-16', '12:00'],
    ]);
    const today = await req('owner', 'POST', `/branches/${ids.arbat}/hours/preview`, { ...change, validFrom: '2026-11-14' });
    expect(today.statusCode).toBe(400);
  });
});

describe('права (network.hours.manage: Владелец и Директор своей зоны)', () => {
  it('Администратор своего филиала видит график, но менять не может – 403 и отказ в аудите', async () => {
    expect((await req('admin', 'GET', `/branches/${ids.arbat}/hours`)).statusCode).toBe(200);
    const r = await req('admin', 'POST', `/branches/${ids.arbat}/calendar-exceptions`, { ...shortDay, date: '2026-11-25', confirmedAffected: [] });
    expect(r.statusCode).toBe(403);
    const p = await req('admin', 'POST', `/branches/${ids.arbat}/hours/preview`, { validFrom: '2026-11-20', days: [{ weekday: 5, open: null, close: null }] });
    expect(p.statusCode).toBe(403);
    const a = await db.client.query(`SELECT action, result FROM journal.audit_events WHERE actor_id = $1 AND result = 'denied' ORDER BY action`, [ids.admin]);
    expect(a.rows).toEqual([
      { action: 'branch.hours_changed', result: 'denied' },
      { action: 'calendar.exception_created', result: 'denied' },
    ]);
  });

  it('Директор чужого филиала – 404 с телом несуществующего; своего – может', async () => {
    const foreign = await req('director', 'POST', `/branches/${ids.arbat}/calendar-exceptions/preview`, shortDay);
    const missing = await req('director', 'POST', `/branches/${randomUUID()}/calendar-exceptions/preview`, shortDay);
    expect(foreign.statusCode).toBe(404);
    expect(bodyWithoutRequestId(foreign.json())).toEqual(bodyWithoutRequestId(missing.json()));
    expect((await req('director', 'GET', `/branches/${ids.arbat}/calendar-exceptions?from=2026-11-01&to=2026-11-30`)).statusCode).toBe(404);
    const own = await req('director', 'POST', `/branches/${ids.tverskaya}/calendar-exceptions`, { ...shortDay, confirmedAffected: [] });
    expect(own.statusCode).toBe(201);
  });
});
