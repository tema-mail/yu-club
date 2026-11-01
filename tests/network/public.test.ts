// K5 №1–4 по HTTP: публичная сеть для сайта. Поля – ровно как BranchDto/CityDto/ResourceDto в apps/site/src/lib/api.ts.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const P = '/api/public/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};

const CITY_KEYS = ['id', 'slug', 'name', 'timezone'];
const BRANCH_KEYS = ['id', 'cityId', 'slug', 'name', 'address', 'timezone', 'status', 'phone', 'publicContacts', 'bookingWindow', 'holdMinutes'];
const RESOURCE_KEYS = ['id', 'branchId', 'roomId', 'roomName', 'type', 'zone', 'name', 'stepMinutes', 'selfBookable'];
const sorted = (o: object) => Object.keys(o).sort();

async function one<T = { id: string }>(sql: string, values: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, values)).rows[0] as T;
}

async function branch(key: string, city: string, slug: string, status: string, extra = ''): Promise<void> {
  const tc = status === 'temporarily_closed' ? `, temp_closed_from = '2026-11-01T00:00Z', temp_close_reason = 'ремонт'` : '';
  const ar = status === 'archived' ? `, archived_at = now()` : '';
  ids[key] = (
    await one(
      `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, phone_public, public_contacts, internal_comment, description)
       VALUES ($1, $2, $3, $3, 'адрес', 'Asia/Novosibirsk', '+73830000000', '{"vk":"https://vk.com/yu","n":5}', 'секрет', 'описание') RETURNING id`,
      [ids[city], key, slug],
    )
  ).id;
  await db.client.query(`UPDATE app.branches SET status = $2${tc}${ar}${extra} WHERE id = $1`, [ids[key], status]);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool, clock: fixedClock('2026-11-14T05:00:00Z') } });
  for (const [k, slug] of [['nsk', 'novosibirsk'], ['tsk', 'tomsk'], ['omsk', 'omsk']] as const) {
    ids[k] = (await one(`INSERT INTO app.cities (code, slug, name, timezone, comment) VALUES ($1, $2, $1, 'Asia/Novosibirsk', 'внутр.') RETURNING id`, [k, slug])).id;
  }
  await branch('krasny', 'nsk', 'krasny', 'active');
  await branch('akadem', 'nsk', 'akadem', 'temporarily_closed');
  await branch('gorsky', 'nsk', 'gorsky', 'preparing');
  await branch('old', 'nsk', 'old', 'archived');
  await branch('lenina', 'tsk', 'lenina', 'active');
  await branch('mira', 'omsk', 'mira', 'preparing'); // город только с готовящимся – не виден
  for (const k of ['krasny', 'akadem', 'lenina']) {
    await db.client.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by)
       SELECT $1, wd, '10:00', '22:00', '2026-01-01', $1 FROM generate_series(1, 7) wd`,
      [ids[k]],
    );
  }
  await db.client.query(
    `INSERT INTO app.calendar_exceptions (branch_id, scope_type, local_date, kind, open_time, close_time, reason, created_by)
     VALUES ($1, 'branch', '2026-11-14', 'short_day', '10:00', '18:00', 'санитарный день', $1)`,
    [ids.lenina],
  );
  await db.client.query(
    `INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('booking.window_default_days', 'branch', $1, '14', '2026-01-01', $1)`,
    [ids.krasny],
  );
  // ресурсы Красного: ПК в опубликованном зале, VR в неопубликованной комнате, несамостоятельный, архивный
  const hall = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published, internal_description) VALUES ($1, 'hall', 'Зал ПК', true, 'секрет') RETURNING id`, [ids.krasny])).id;
  const hidden = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR', false) RETURNING id`, [ids.krasny])).id;
  ids.pc1 = (await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name, internal_comment) VALUES ($1, $2, 'pc', 'ПК 1', 'секрет') RETURNING id`, [ids.krasny, hall])).id;
  await db.client.query(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, 'vr_seat', 'VR 1')`, [ids.krasny, hidden]);
  await db.client.query(`INSERT INTO app.resources (branch_id, room_id, resource_type, name, self_bookable) VALUES ($1, $2, 'pc', 'PS4', false)`, [ids.krasny, hall]);
  await db.client.query(`INSERT INTO app.resources (branch_id, room_id, resource_type, name, status, archived_at) VALUES ($1, $2, 'pc', 'ПК old', 'archived', now())`, [ids.krasny, hall]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('K5 №1–2: города и филиалы', () => {
  it('города – только с работающим или временно закрытым филиалом; без входа; короткий публичный кэш', async () => {
    const r = await app.inject({ method: 'GET', url: `${P}/cities` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60');
    const items = r.json().items;
    expect(items.map((c: { slug: string }) => c.slug)).toEqual(['nsk', 'tsk'].map((k) => (k === 'nsk' ? 'novosibirsk' : 'tomsk')));
    for (const c of items) expect(sorted(c)).toEqual([...CITY_KEYS].sort());
  });

  it('филиалы: архивный и готовящийся не видны; поля – ровно BranchDto, без внутренних', async () => {
    const items = (await app.inject({ method: 'GET', url: `${P}/branches` })).json().items;
    expect(items.map((b: { slug: string }) => b.slug).sort()).toEqual(['akadem', 'krasny', 'lenina']);
    for (const b of items) expect(sorted(b)).toEqual([...BRANCH_KEYS].sort());
    const k = items.find((b: { slug: string }) => b.slug === 'krasny');
    expect(k).toEqual({
      id: ids.krasny, cityId: ids.nsk, slug: 'krasny', name: 'krasny', address: 'адрес', timezone: 'Asia/Novosibirsk', status: 'active',
      phone: '+73830000000', publicContacts: { vk: 'https://vk.com/yu' }, bookingWindow: { defaultDays: 14, maxDays: 30 }, holdMinutes: 15,
    });
    expect(JSON.stringify(items)).not.toMatch(/секрет|описание|internal|rowVersion|tempClosed/);
    expect(items.find((b: { slug: string }) => b.slug === 'akadem').status).toBe('temporarily_closed');
  });

  it('?city= по slug; неизвестный город – пустой список', async () => {
    const nsk = (await app.inject({ method: 'GET', url: `${P}/branches?city=novosibirsk` })).json().items;
    expect(nsk.map((b: { slug: string }) => b.slug).sort()).toEqual(['akadem', 'krasny']);
    expect((await app.inject({ method: 'GET', url: `${P}/branches?city=nope` })).json().items).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `${P}/branches?city=omsk` })).json().items).toEqual([]);
  });
});

describe('K5 №3–4: филиал и его ресурсы', () => {
  it('hoursToday – местное время филиала по графику и исключениям; временно закрыт – пусто; в списке поля нет', async () => {
    const get = async (k: string) => (await app.inject({ method: 'GET', url: `${P}/branches/${ids[k]}` })).json();
    const k = await get('krasny');
    expect(k.hoursToday).toEqual([{ start: '10:00', end: '22:00' }]);
    expect(sorted(k)).toEqual([...BRANCH_KEYS, 'hoursToday'].sort());
    expect((await get('lenina')).hoursToday).toEqual([{ start: '10:00', end: '18:00' }]); // сокращённый день 14.11
    expect((await get('akadem')).hoursToday).toEqual([]);
    const list = (await app.inject({ method: 'GET', url: `${P}/branches` })).json().items;
    expect(list.every((b: object) => !('hoursToday' in b))).toBe(true);
  });


  it('филиал по id; готовящийся, архивный, несуществующий и мусорный id – одинаковый 404', async () => {
    const r = await app.inject({ method: 'GET', url: `${P}/branches/${ids.akadem}` });
    expect(r.json()).toMatchObject({ slug: 'akadem', status: 'temporarily_closed' });
    const bodies = [];
    for (const id of [ids.gorsky, ids.old, randomUUID(), 'krasny']) {
      const x = await app.inject({ method: 'GET', url: `${P}/branches/${id}` });
      expect(x.statusCode).toBe(404);
      bodies.push({ ...x.json().error, requestId: undefined });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect((await app.inject({ method: 'GET', url: `${P}/branches/${ids.gorsky}/resources` })).statusCode).toBe(404);
  });

  it('ресурсы: только самостоятельные активные в опубликованных комнатах, поля ResourceDto, фильтр зоны', async () => {
    const r = await app.inject({ method: 'GET', url: `${P}/branches/${ids.krasny}/resources` });
    expect(r.headers['cache-control']).toContain('public');
    const items = r.json().items;
    expect(items).toEqual([
      { id: ids.pc1, branchId: ids.krasny, roomId: expect.any(String), roomName: 'Зал ПК', type: 'pc', zone: 'pc', name: 'ПК 1', stepMinutes: 30, selfBookable: true },
    ]);
    expect(sorted(items[0])).toEqual([...RESOURCE_KEYS].sort());
    expect((await app.inject({ method: 'GET', url: `${P}/branches/${ids.krasny}/resources?zone=vr` })).json().items).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `${P}/branches/${ids.krasny}/resources?zone=xx` })).statusCode).toBe(400);
  });
});
