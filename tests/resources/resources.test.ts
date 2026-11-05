// S1-01: помещения, комнаты, ресурсы по HTTP (K11 №18, K13, K1). Число ПК/VR – данные; архив вместо удаления;
// права Директора своей зоны; закрытие комнаты закрывает её ресурсы (02 §7.3).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { assertBookable, getResource, listBookableResources } from '../../apps/api/src/modules/resources/index.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-ресурсов-проверка-1';
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

function req(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const noRequestId = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });

async function city(slug: string, tz: string): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ($1, $1, $1, $2) RETURNING id`, [slug, tz]);
  return r.rows[0]!.id;
}
async function branch(cityId: string, slug: string): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`,
    [cityId, slug],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    staff: { pool, auth: staffAuthConfig('r'.repeat(40)), clock: fixedClock('2026-11-14T05:00:00Z') },
  });
  ids.nsk = await city('nsk', 'Asia/Novosibirsk');
  ids.tsk = await city('tsk', 'Asia/Tomsk');
  ids.krasny = await branch(ids.nsk, 'krasny');
  ids.akadem = await branch(ids.nsk, 'akadem');
  ids.lenina = await branch(ids.tsk, 'lenina');
  await staff('owner', 'owner');
  await staff('director', 'director', { city: ids.nsk });
  await staff('director_tsk', 'director', { city: ids.tsk });
  await staff('admin', 'admin', { branch: ids.krasny });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('Директор своей зоны заводит зал, VR-комнату и ресурсы', () => {
  it('помещение, комната, 5 ПК, 2 VR-места и «комната целиком» – данными; аудит created', async () => {
    const s = await req('director', 'POST', `/branches/${ids.krasny}/spaces`, { spaceType: 'hall', name: 'Общий зал' });
    expect(s.statusCode).toBe(201);
    ids.hall = s.json().id;
    const room = await req('director', 'POST', `/branches/${ids.krasny}/rooms`, {
      slug: 'vr', name: 'VR-комната', spaceId: ids.hall, capacity: 4, isPublished: true, wholeRentAllowed: true,
    });
    expect(room.statusCode).toBe(201);
    expect(room.json()).toMatchObject({ status: 'active', isPublished: true, rowVersion: 1 });
    ids.vrRoom = room.json().id;
    for (let i = 1; i <= 5; i++) {
      const pc = await req('director', 'POST', `/branches/${ids.krasny}/resources`, { type: 'pc', name: `ПК-${i}`, sortOrder: i });
      expect(pc.statusCode).toBe(201);
      ids[`pc${i}`] = pc.json().id;
    }
    for (const [k, name, type] of [
      ['vr1', 'VR-место 1', 'vr_seat'],
      ['vr2', 'VR-место 2', 'vr_seat'],
      ['whole', 'VR-комната целиком', 'room_whole'],
    ] as const) {
      const r = await req('director', 'POST', `/branches/${ids.krasny}/resources`, { type, name, roomId: ids.vrRoom });
      expect(r.statusCode).toBe(201);
      ids[k] = r.json().id;
    }
    const a = await db.client.query(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'resource.created' AND branch_id = $1`, [ids.krasny]);
    expect(a.rows[0].n).toBe(9); // 5 ПК, 2 VR-места, комната целиком и подарочный ресурс (K20 §8.2, S3-62)
    // второе VR-место сделало комнату VR-комнатой: подарочный ресурс и тариф 0 ₽ – в той же команде, права Директора на тарифы не нужны
    const gift = await db.client.query(`SELECT r.self_bookable, r.step_minutes_override, r.room_id, (SELECT count(*)::int FROM app.tariffs t WHERE t.branch_id = r.branch_id AND t.resource_type = 'gift_vr' AND t.price_per_unit_kop = 0) AS tariffs FROM app.resources r WHERE r.branch_id = $1 AND r.resource_type = 'gift_vr'`, [ids.krasny]);
    expect(gift.rows).toEqual([{ self_bookable: false, step_minutes_override: 5, room_id: ids.vrRoom, tariffs: 1 }]);
  });

  it('шестой ПК – тоже только строка данных: список и сетка видят 6', async () => {
    const r = await req('director', 'POST', `/branches/${ids.krasny}/resources`, { type: 'pc', name: 'ПК-6', sortOrder: 6 });
    ids.pc6 = r.json().id;
    const pcs = await listBookableResources(pool, ids.krasny!, 'pc');
    expect(pcs.map((x) => x.name)).toEqual(['ПК-1', 'ПК-2', 'ПК-3', 'ПК-4', 'ПК-5', 'ПК-6']);
  });

  it('K13: шаг – из типа (VR 15, ПК 30) или локальный; зона VR у мест и «комнаты целиком»', async () => {
    expect(await getResource(pool, ids.vr1!)).toMatchObject({ type: 'vr_seat', stepMinutes: 15, zone: 'vr', roomName: 'VR-комната' });
    expect(await getResource(pool, ids.whole!)).toMatchObject({ type: 'room_whole', stepMinutes: 15, zone: 'vr' });
    expect(await getResource(pool, ids.pc1!)).toMatchObject({ stepMinutes: 30, zone: 'pc', roomId: null });
    const p = await req('director', 'PATCH', `/resources/${ids.pc1}`, { rowVersion: 1, stepMinutesOverride: 60 });
    expect(p.json()).toMatchObject({ stepMinutesOverride: 60, rowVersion: 2 });
    expect((await getResource(pool, ids.pc1!))!.stepMinutes).toBe(60);
    expect((await req('director', 'PATCH', `/resources/${ids.pc1}`, { rowVersion: 2, stepMinutesOverride: 7 })).statusCode).toBe(400);
    expect((await req('director', 'PATCH', `/resources/${ids.pc1}`, { rowVersion: 2, type: 'vr_seat' })).statusCode).toBe(400);
    const card = (await req('admin', 'GET', `/resources/${ids.vr2}`)).json();
    expect(card).toMatchObject({ type: 'vr_seat', stepMinutes: 15, zone: 'vr', roomStatus: 'active' });
  });

  it('устаревший rowVersion – 409 VERSION_CONFLICT с current', async () => {
    const r = await req('director', 'PATCH', `/resources/${ids.pc1}`, { rowVersion: 1, name: 'X' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'VERSION_CONFLICT', details: { current: 2 } });
  });

  it('комната другого филиала – 422 RESOURCE_LINK_INVALID; slug комнаты занят – 409', async () => {
    const other = await req('owner', 'POST', `/branches/${ids.akadem}/rooms`, { slug: 'ps5', name: 'PS5' });
    ids.akademRoom = other.json().id;
    const r = await req('director', 'POST', `/branches/${ids.krasny}/resources`, { type: 'pc', name: 'X', roomId: ids.akademRoom });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('RESOURCE_LINK_INVALID');
    const dup = await req('director', 'POST', `/branches/${ids.krasny}/rooms`, { slug: 'vr', name: 'Ещё VR' });
    expect(dup.json().error.code).toBe('RESOURCE_SLUG_TAKEN');
    const badType = await req('director', 'POST', `/branches/${ids.krasny}/resources`, { type: 'xbox', name: 'X' });
    expect(badType.json().error.code).toBe('RESOURCE_LINK_INVALID');
  });
});

describe('закрытие комнаты закрывает её ресурсы (02 §7.3, 7.4)', () => {
  it('комната «ремонт» → места и «комната целиком» недоступны, ПК в зале работают', async () => {
    expect((await listBookableResources(pool, ids.krasny!, 'vr')).map((x) => x.id).sort()).toEqual([ids.vr1, ids.vr2, ids.whole].sort());
    const room = (await req('director', 'GET', `/rooms/${ids.vrRoom}`)).json();
    const p = await req('director', 'PATCH', `/rooms/${ids.vrRoom}`, { rowVersion: room.rowVersion, status: 'repair' });
    expect(p.json().status).toBe('repair');
    expect(await listBookableResources(pool, ids.krasny!, 'vr')).toEqual([]);
    const seat = (await getResource(pool, ids.vr1!))!;
    expect(seat.status).toBe('active'); // строка ресурса не тронута – закрывает комната
    expect(() => assertBookable(seat)).toThrow(AppError);
    try {
      assertBookable(seat);
    } catch (e) {
      expect((e as AppError).code).toBe('RESOURCE_UNAVAILABLE');
    }
    expect((await listBookableResources(pool, ids.krasny!, 'pc')).length).toBe(6);
    await req('director', 'PATCH', `/rooms/${ids.vrRoom}`, { rowVersion: room.rowVersion + 1, status: 'active' });
    assertBookable((await getResource(pool, ids.vr1!))!);
  });

  it('ревизия: служебный gift_vr не становится самостоятельным – ни при создании, ни правкой', async () => {
    const bad = await req('director', 'POST', `/branches/${ids.krasny}/resources`, { type: 'gift_vr', name: 'Подарок', roomId: ids.vrRoom, selfBookable: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details).toMatchObject({ field: 'selfBookable' });
    const made = await req('director', 'POST', `/branches/${ids.krasny}/resources`, { type: 'gift_vr', name: 'Подарок без флага', roomId: ids.vrRoom });
    expect(made.statusCode).toBe(201);
    expect(made.json().selfBookable).toBe(false);
    const flip = await req('director', 'PATCH', `/resources/${made.json().id}`, { rowVersion: made.json().rowVersion, selfBookable: true });
    expect(flip.statusCode).toBe(400);
    const row = await db.client.query('SELECT self_bookable FROM app.resources WHERE id = $1', [made.json().id]);
    expect(row.rows[0].self_bookable).toBe(false);
    const name = await req('director', 'PATCH', `/resources/${made.json().id}`, { rowVersion: made.json().rowVersion, name: 'Подарок', selfBookable: false });
    expect(name.statusCode).toBe(200);
  });
  it('неопубликованная комната не попадает на сайт, «несамостоятельный» ресурс – недоступен', async () => {
    const room = (await req('director', 'GET', `/rooms/${ids.vrRoom}`)).json();
    await req('director', 'PATCH', `/rooms/${ids.vrRoom}`, { rowVersion: room.rowVersion, isPublished: false });
    expect(await listBookableResources(pool, ids.krasny!, 'vr')).toEqual([]);
    await req('director', 'PATCH', `/rooms/${ids.vrRoom}`, { rowVersion: room.rowVersion + 1, isPublished: true });
    const r = await req('director', 'POST', `/branches/${ids.krasny}/resources`, { type: 'composite', name: 'Служебная', roomId: ids.vrRoom, selfBookable: false });
    const info = (await getResource(pool, r.json().id))!;
    expect(() => assertBookable(info)).toThrow('Это место недоступно для записи');
    expect((await listBookableResources(pool, ids.krasny!)).some((x) => x.id === info.id)).toBe(false);
  });
});

describe('архив вместо удаления (02 §12)', () => {
  it('комнату с живыми ресурсами – нельзя; после архива ресурсов – можно; архив не правится', async () => {
    const room = (await req('director', 'GET', `/rooms/${ids.vrRoom}`)).json();
    const busy = await req('director', 'POST', `/rooms/${ids.vrRoom}/archive`, { rowVersion: room.rowVersion });
    expect(busy.json().error.code).toBe('OBJECT_IN_USE');
    const pc6 = (await req('director', 'GET', `/resources/${ids.pc6}`)).json();
    const a = await req('director', 'POST', `/resources/${ids.pc6}/archive`, { rowVersion: pc6.rowVersion });
    expect(a.json()).toMatchObject({ status: 'archived', archivedAt: '2026-11-14T05:00:00.000Z' });
    expect((await req('director', 'PATCH', `/resources/${ids.pc6}`, { rowVersion: pc6.rowVersion + 1, name: 'Y' })).json().error.code).toBe('RESOURCE_ARCHIVED');
    const list = (await req('director', 'GET', `/branches/${ids.krasny}/resources?limit=100`)).json();
    expect(list.items.some((x: { id: string }) => x.id === ids.pc6)).toBe(false);
    const withArchived = (await req('director', 'GET', `/branches/${ids.krasny}/resources?includeArchived=true&limit=100`)).json();
    expect(withArchived.items.some((x: { id: string }) => x.id === ids.pc6)).toBe(true);
    const audit = await db.client.query(`SELECT before, after FROM journal.audit_events WHERE action = 'resource.archived' AND object_id = $1`, [ids.pc6]);
    expect(audit.rows[0].after).toMatchObject({ status: 'archived' });
    expect(audit.rows[0].before).toMatchObject({ status: 'active' });
  });

  it('у yu_app нет DELETE на помещения, комнаты, ресурсы', async () => {
    for (const t of ['spaces', 'rooms', 'resources']) {
      await expect(pool.query(`DELETE FROM app.${t} WHERE false`)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('список – порциями по курсору (sort_order, name, id)', async () => {
    const p1 = (await req('admin', 'GET', `/branches/${ids.krasny}/resources?limit=4`)).json();
    expect(p1.items).toHaveLength(4);
    const p2 = (await req('admin', 'GET', `/branches/${ids.krasny}/resources?limit=100&cursor=${p1.nextCursor}`)).json();
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x: { id: string }) => x.id)).size).toBe(p1.items.length + p2.items.length);
    expect((await req('admin', 'GET', `/branches/${ids.krasny}/resources?cursor=bad`)).statusCode).toBe(400);
  });
});

describe('права (K1 resources.view / resources.manage)', () => {
  it('Директор чужого города: чужой филиал – 404 как несуществующий, отказ в аудите', async () => {
    const r = await req('director_tsk', 'POST', `/branches/${ids.krasny}/resources`, { type: 'pc', name: 'Взлом' });
    const missing = await req('director_tsk', 'POST', `/branches/${randomUUID()}/resources`, { type: 'pc', name: 'X' });
    expect(r.statusCode).toBe(404);
    expect(noRequestId(r.json())).toEqual(noRequestId(missing.json()));
    const a = await db.client.query(`SELECT action, result, reason FROM journal.audit_events WHERE branch_id = $1 AND result = 'denied'`, [ids.krasny]);
    expect(a.rows).toContainEqual({ action: 'resource.created', result: 'denied', reason: 'NOT_FOUND: resources.manage' });
    expect((await req('director_tsk', 'GET', `/resources/${ids.vr1}`)).statusCode).toBe(404);
    expect((await req('director_tsk', 'PATCH', `/resources/${ids.vr1}`, { rowVersion: 1, name: 'X' })).statusCode).toBe(404);
  });

  it('Администратор филиала видит, но не меняет (403, в аудите); чужой филиал – 404', async () => {
    expect((await req('admin', 'GET', `/branches/${ids.krasny}/rooms`)).statusCode).toBe(200);
    const f = await req('admin', 'PATCH', `/resources/${ids.vr1}`, { rowVersion: 1, name: 'X' });
    expect(f.statusCode).toBe(403);
    const a = await db.client.query(`SELECT reason FROM journal.audit_events WHERE object_id = $1 AND result = 'denied'`, [ids.vr1]);
    expect(a.rows.map((x) => x.reason)).toContain('FORBIDDEN: resources.manage');
    expect((await req('admin', 'GET', `/branches/${ids.akadem}/resources`)).statusCode).toBe(404);
    expect((await req('admin', 'GET', `/rooms/${ids.akademRoom}`)).statusCode).toBe(404);
    expect((await req('admin', 'GET', `/rooms/not-a-uuid`)).statusCode).toBe(404);
  });

  it('Директор города работает во всех филиалах города; ресурсы чужого города ему не видны', async () => {
    expect((await req('director', 'POST', `/branches/${ids.akadem}/resources`, { type: 'pc', name: 'ПК-1' })).statusCode).toBe(201);
    expect((await req('director', 'GET', `/branches/${ids.lenina}/resources`)).statusCode).toBe(404);
  });
});
