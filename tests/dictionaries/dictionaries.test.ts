import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import type { StaffDeps } from '../../apps/api/src/modules/staff/routes.crm.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-справочников-1';
const BASE = '/api/crm/v1/dictionaries';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};

async function asApp<T>(fn: () => Promise<T>): Promise<T> {
  await db.client.query('SET ROLE yu_app');
  try {
    return await fn();
  } finally {
    await db.client.query('RESET ROLE');
  }
}

async function staff(key: string, role: string, scope?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  if (scope) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`,
      [r.rows[0]!.id, scope],
    );
  }
  const res = await app.inject({ method: 'POST', url: '/api/crm/v1/auth/login', payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

const req = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

async function reasonId(domain: string, code: string): Promise<string> {
  const r = await db.client.query<{ id: string }>('SELECT id FROM app.dict_reasons WHERE domain = $1 AND code = $2', [domain, code]);
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const clock = fixedClock('2026-11-22T07:00:00Z');
  const staffDeps: StaffDeps = { pool, auth: staffAuthConfig('d'.repeat(40)), clock };
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: staffDeps }); // справочники подключает server.ts
  await staff('owner', 'owner');
  await staff('director', 'director', 'cccccccc-0000-4000-8000-000000000001');
  await staff('admin', 'admin', 'cccccccc-0000-4000-8000-000000000001');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('0010: защита в базе', () => {
  it('сид: системные типы ресурсов с шагами 01 §4, причины «Другое» во всех доменах', async () => {
    const t = await db.client.query('SELECT code, step_minutes, is_system FROM app.dict_resource_types ORDER BY sort_order');
    expect(t.rows.map((r) => [r.code, r.step_minutes])).toEqual([
      ['pc', 30], ['vr_seat', 15], ['room_whole', 15], ['ps_room', 30], ['composite', 15],
    ]);
    expect(t.rows.every((r) => r.is_system)).toBe(true);
    const o = await db.client.query("SELECT count(*)::int AS n FROM app.dict_reasons WHERE code = 'other' AND is_system");
    expect(o.rows[0].n).toBe(6);
  });

  it('yu_app: DELETE, смена кода и is_system, вставка системного – 42501', async () => {
    await expect(asApp(() => db.client.query("DELETE FROM app.dict_resource_types WHERE code = 'pc'"))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(() => db.client.query("UPDATE app.dict_resource_types SET code = 'pc2' WHERE code = 'pc'"))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(() => db.client.query("UPDATE app.dict_reasons SET is_system = false"))).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(() => db.client.query("INSERT INTO app.dict_reasons (domain, code, name, is_system) VALUES ('no_show', 'x', 'x', true)")),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(() => db.client.query("DELETE FROM app.dict_status_transitions"))).rejects.toMatchObject({ code: '42501' });
  });

  it('триггер держит и владельца объектов: код, удаление, архив системного', async () => {
    await expect(db.client.query("UPDATE app.dict_resource_types SET code = 'pc2' WHERE code = 'pc'")).rejects.toThrow(/dict_code_immutable/);
    await expect(db.client.query("DELETE FROM app.dict_space_types WHERE code = 'hall'")).rejects.toThrow(/dict_no_delete/);
    await expect(
      db.client.query("UPDATE app.dict_reasons SET archived_at = now() WHERE code = 'other' AND domain = 'no_show'"),
    ).rejects.toThrow(/dict_system_immutable/);
    await expect(db.client.query("UPDATE app.dict_reasons SET is_system = false WHERE code = 'other'")).rejects.toThrow(/dict_system_immutable/);
  });
});

describe('маршруты: права только Владельцу', () => {
  it('чтение – любой сотрудник; статусы отдаются с переходами', async () => {
    const r = await req('admin', 'GET', '/resource-types');
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toHaveLength(5);
    const s = await req('admin', 'GET', '/statuses?domain=booking');
    expect(s.json().items).toHaveLength(6);
    expect(s.json().transitions).toContainEqual({ domain: 'booking', from: 'confirmed', to: 'arrived' });
    expect((await app.inject({ method: 'GET', url: `${BASE}/reasons` })).statusCode).toBe(401);
  });

  it('Директор и Администратор не меняют справочники – 403 и отказ в аудите', async () => {
    for (const who of ['director', 'admin']) {
      const r = await req(who, 'PATCH', '/resource-types/pc', { name: 'Компьютер' });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('FORBIDDEN');
      expect((await req(who, 'POST', '/reasons', { domain: 'no_show', code: 'late', name: 'Опоздал' })).statusCode).toBe(403);
    }
    const a = await db.client.query("SELECT count(*)::int AS n FROM journal.audit_events WHERE action = 'dictionary.changed' AND result = 'denied'");
    expect(a.rows[0].n).toBe(4);
  });
});

describe('маршруты: системные коды и архив', () => {
  it('Владелец меняет подпись системного типа – с аудитом; код – 409, удалить – 409', async () => {
    const r = await req('owner', 'PATCH', '/resource-types/pc', { name: 'Игровой ПК' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ code: 'pc', name: 'Игровой ПК', stepMinutes: 30 });
    const a = await db.client.query(
      "SELECT before, after, actor_role FROM journal.audit_events WHERE action = 'dictionary.changed' AND result = 'success' AND object_id = 'app.dict_resource_types:pc'",
    );
    expect(a.rows).toEqual([{ before: { name: 'ПК' }, after: { name: 'Игровой ПК' }, actor_role: 'owner' }]);

    const rename = await req('owner', 'PATCH', '/resource-types/pc', { code: 'computer' });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error.code).toBe('DICTIONARY_SYSTEM_IMMUTABLE');
    const del = await req('owner', 'DELETE', '/resource-types/pc');
    expect(del.json().error.code).toBe('DICTIONARY_SYSTEM_IMMUTABLE');
    expect((await req('owner', 'DELETE', '/statuses/booking/confirmed')).json().error.code).toBe('DICTIONARY_SYSTEM_IMMUTABLE');
    const other = await reasonId('no_show', 'other');
    expect((await req('owner', 'POST', `/reasons/${other}/archive`)).json().error.code).toBe('DICTIONARY_SYSTEM_IMMUTABLE');
    expect((await req('owner', 'DELETE', `/reasons/${other}`)).json().error.code).toBe('DICTIONARY_SYSTEM_IMMUTABLE');
  });

  it('пользовательская причина: создать → удалить нельзя → архив → скрыта из списка → восстановить', async () => {
    const c = await req('owner', 'POST', '/reasons', { domain: 'no_show', code: 'late', name: 'Опоздал больше 15 минут' });
    expect(c.statusCode).toBe(201);
    const id = c.json().id as string;
    expect(c.json()).toMatchObject({ isSystem: false, archivedAt: null });

    const del = await req('owner', 'DELETE', `/reasons/${id}`);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('DICTIONARY_ARCHIVE_ONLY');

    const arch = await req('owner', 'POST', `/reasons/${id}/archive`);
    expect(arch.json().archivedAt).toBe('2026-11-22T07:00:00.000Z');
    const list = (await req('admin', 'GET', '/reasons?domain=no_show')).json().items.map((x: { code: string }) => x.code);
    expect(list).toEqual(['other']);
    const all = (await req('admin', 'GET', '/reasons?domain=no_show&includeArchived=true')).json().items;
    expect(all).toHaveLength(2);

    expect((await req('owner', 'POST', `/reasons/${id}/restore`)).json().archivedAt).toBeNull();
    const renameUser = await req('owner', 'PATCH', `/reasons/${id}`, { code: 'late2' });
    expect(renameUser.statusCode).toBe(400);
    expect((await req('owner', 'PATCH', `/reasons/${id}`, { name: 'Опоздал', requiresComment: true })).json()).toMatchObject({
      name: 'Опоздал',
      requiresComment: true,
    });
  });

  it('повтор кода – 409 DICTIONARY_CODE_TAKEN; кривой код – 400; неизвестное – 404', async () => {
    const dup = await req('owner', 'POST', '/space-types', { code: 'hall', name: 'Ещё зал' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('DICTIONARY_CODE_TAKEN');
    expect((await req('owner', 'POST', '/space-types', { code: 'Плохой', name: 'x' })).statusCode).toBe(400);
    expect((await req('owner', 'PATCH', '/space-types/nope', { name: 'x' })).statusCode).toBe(404);
    const ok = await req('owner', 'POST', '/space-types', { code: 'lounge', name: 'Лаунж' });
    expect(ok.statusCode).toBe(201);
    expect((await req('owner', 'POST', '/space-types/lounge/archive')).statusCode).toBe(200);
    expect((await req('owner', 'PATCH', '/resource-types/vr_seat', { stepMinutes: 7 })).statusCode).toBe(400);
  });
});
