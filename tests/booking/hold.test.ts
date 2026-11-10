// S1-06: удержание 15 мин (K5 №5–11, K6 releaseExpiredHolds, 01 §7): создание, общий таймер, истечение
// (в транзакции и задачей), кука yu_visitor, потолок анонимных, лимит по IP, attach к клиенту и client_time.
// Углы TC-05 (истечение), TC-06 (перезапуск таймера), TC-04 (пересечение ресурсов одного клиента) из tz/20 §10 по HTTP и через attach;
// сами сценарии целиком и гонки N соединений – tc-races.test.ts.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { attachHold, attachVisitorHolds, createHold, expireDueHolds } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let t = new Date('2026-11-14T05:00:00Z').getTime(); // 12:00 Новосибирска
const clock: Clock = { now: () => new Date(t) };
const advance = (min: number) => (t += min * 60_000);
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function branch(code: string, cityId: string): Promise<string> {
  const b = await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [cityId, code]);
  await db.client.query(
    `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
    [b.id, SYS],
  );
  return b.id;
}
async function resource(branchId: string, roomId: string | null, type: string, code: string, unitIds?: string[]): Promise<string> {
  const units = unitIds ?? [(await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [branchId, roomId, code])).id];
  const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [branchId, roomId, type, code]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, units]);
  return r.id;
}
const visitor = () => `yu_visitor=${randomUUID()}`;
function post(cookie: string | null, url: string, payload: object, key = randomUUID(), method: 'POST' | 'DELETE' = 'POST') {
  const headers: Record<string, string> = { 'idempotency-key': key };
  if (cookie) headers.cookie = cookie;
  return app.inject({ method, url: `/api/public/v1${url}`, headers, payload });
}
const get = (cookie: string | null, url: string) => app.inject({ method: 'GET', url: `/api/public/v1${url}`, headers: cookie ? { cookie } : {} });
const item = (resourceId: string, start: string, minutes: number) => ({ resourceId, start, end: new Date(new Date(start).getTime() + minutes * 60_000).toISOString() });
const stateOf = async (cookie: string, resourceId: string, start: string) => {
  const a = (await get(cookie, `/branches/${ids.b1}/availability?date=${start.slice(0, 10)}`)).json();
  return a.resources.find((r: { resourceId: string }) => r.resourceId === resourceId).slots.find((s: { start: string }) => s.start === new Date(start).toISOString())?.state;
};
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    clients: { pool, auth: clientAuthConfig('h'.repeat(40)), sms: createDevSmsSender('dev', () => {}), clock },
  });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = await branch('b1', city.id);
  ids.b2 = await branch('b2', city.id);
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [ids.b1])).id;
  ids.vr1 = await resource(ids.b1, ids.room, 'vr_seat', 'VR1');
  ids.vr2 = await resource(ids.b1, ids.room, 'vr_seat', 'VR2');
  ids.pc1 = await resource(ids.b1, null, 'pc', 'PC1');
  ids.pc2 = await resource(ids.b1, null, 'pc', 'PC2');
  ids.b2pc = await resource(ids.b2, null, 'pc', 'PC1');
  await db.client.query(
    `INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 15000, '2026-01-01', 'active', $2)`,
    [ids.b1, SYS],
  );
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, status, created_by_type, registered_at) VALUES ('+79130000001', 'active', 'system', now()) RETURNING id`)).id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('кука посетителя и создание удержания', () => {
  it('GET availability ставит yu_visitor, если её нет; с кукой – не ставит', async () => {
    const a = await get(null, `/branches/${ids.b1}/availability?date=2026-11-15`);
    expect(a.statusCode).toBe(200);
    expect(String(a.headers['set-cookie'])).toMatch(/^yu_visitor=[0-9a-f-]{36}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const v = visitor();
    expect((await get(v, `/branches/${ids.b1}/availability?date=2026-11-15`)).headers['set-cookie']).toBeUndefined();
    expect((await get(v, `/branches/${ids.b1}/availability?date=2026-11-15T00`)).statusCode).toBe(400);
  });

  it('POST /holds без куки – VISITOR_REQUIRED; с кукой – 201, таймер 15 мин, цена по тарифу, «мой» у себя и «удерживается» у другого', async () => {
    expect((await post(null, '/holds', { branchId: ids.b1, items: [item(ids.pc1!, '2026-11-15T07:00:00Z', 60)] })).json().error.code).toBe('VISITOR_REQUIRED');
    const v = visitor();
    ids.v1 = v;
    const key = randomUUID();
    const r = await post(v, '/holds', { branchId: ids.b1, items: [item(ids.pc1!, '2026-11-15T07:00:00Z', 60), item(ids.vr1!, '2026-11-15T09:00:00Z', 30)] }, key);
    expect(r.statusCode).toBe(201);
    const h = r.json();
    expect(h).toMatchObject({ status: 'active', owner: 'visitor', expiresAt: '2026-11-14T05:15:00.000Z', serverNow: '2026-11-14T05:00:00.000Z', totalKop: null });
    expect(h.items.map((i: { priceKop: number | null }) => i.priceKop)).toEqual([30000, null]); // у VR тарифа нет
    ids.hold1 = h.id;
    const replay = await post(v, '/holds', { branchId: ids.b1, items: [item(ids.pc1!, '2026-11-15T07:00:00Z', 60), item(ids.vr1!, '2026-11-15T09:00:00Z', 30)] }, key);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual(h);
    expect(await stateOf(v, ids.pc1!, '2026-11-15T07:00:00Z')).toBe('mine');
    expect(await stateOf(visitor(), ids.pc1!, '2026-11-15T07:00:00Z')).toBe('held');
    const ev = await one<{ n: number }>(`SELECT count(*)::int n FROM app.outbox_events WHERE event_type = 'hold.created' AND aggregate_id = $1`, [h.id]);
    expect(ev.n).toBe(1);
    const again = await post(v, '/holds', { branchId: ids.b1, items: [item(ids.pc2!, '2026-11-15T07:00:00Z', 30)] });
    expect(again.json().error).toMatchObject({ code: 'HOLD_ALREADY_ACTIVE', details: { holdId: h.id } });
    expect((await get(visitor(), `/holds/${h.id}`)).statusCode).toBe(404); // чужое – как несуществующее
  });

  it('проверки позиций: прошлое, вне окна, шаг, часы, лимит позиций, чужой ресурс – с details.items', async () => {
    const v = visitor();
    const bad = async (items: object[]) => (await post(v, '/holds', { branchId: ids.b1, items })).json().error;
    expect((await bad([item(ids.pc2!, '2026-11-14T04:00:00Z', 30)])).code).toBe('OUTSIDE_BOOKING_WINDOW');
    expect((await bad([item(ids.pc2!, '2026-12-20T07:00:00Z', 30)])).code).toBe('OUTSIDE_BOOKING_WINDOW');
    const mis = await bad([item(ids.pc2!, '2026-11-15T07:00:00Z', 30), item(ids.pc2!, '2026-11-15T08:10:00Z', 30)]);
    expect(mis).toMatchObject({ code: 'INVALID_DURATION', details: { items: [{ index: 1, code: 'INVALID_DURATION' }] } });
    expect((await bad([item(ids.pc2!, '2026-11-15T15:00:00Z', 30)])).code).toBe('OUTSIDE_SCHEDULE'); // 22:00 местного
    expect((await bad([item(ids.b2pc!, '2026-11-15T07:00:00Z', 30)])).code).toBe('NOT_FOUND');
    const many = Array.from({ length: 11 }, (_, k) => item(ids.pc2!, new Date(Date.parse('2026-11-16T03:00:00Z') + k * 1_800_000).toISOString(), 30));
    expect((await bad(many)).code).toBe('HOLD_LIMIT_REACHED');
    expect(await one<{ n: number }>(`SELECT count(*)::int n FROM app.holds WHERE visitor_id = $1`, [v.split('=')[1]])).toEqual({ n: 0 });
  });

  it('филиал 10:00–24:00: 23:00–24:00 – можно, 24:00–01:00 – OUTSIDE_SCHEDULE (а не 500)', async () => {
    const c = await pool.connect();
    let clientId = '';
    const hold = async (start: string) => {
      await c.query('SAVEPOINT h'); // каждая попытка – с чистого листа: неудачная могла оставить строку удержания
      const code = await codeOf(createHold(c, { clientId, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc1!, start: new Date(start), end: new Date(Date.parse(start) + 3_600_000) }] }, clock));
      await c.query('ROLLBACK TO SAVEPOINT h');
      return code;
    };
    try {
      await c.query('BEGIN');
      clientId = (await c.query(`INSERT INTO app.clients (phone_e164, status, created_by_type, registered_at) VALUES ('+79130000024', 'active', 'system', now()) RETURNING id`)).rows[0].id;
      await c.query(`INSERT INTO app.calendar_exceptions (branch_id, scope_type, local_date, kind, open_time, close_time, reason, created_by) VALUES ($1, 'branch', '2026-11-20', 'special_hours', '10:00', '24:00', 'до полуночи', $2)`, [ids.b1, SYS]);
      expect(await hold('2026-11-20T17:00:00Z')).toBe('OUTSIDE_SCHEDULE'); // 21.11 00:00–01:00 местного – день 10:00–22:00
      expect(await hold('2026-11-20T16:00:00Z')).toBe('ok'); // 20.11 23:00–24:00 местного
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('общий таймер (TC-06) и истечение (TC-05)', () => {
  it('добавление слота через 10 мин перезапускает таймер всех позиций; неудачное добавление ничего не трогает', async () => {
    advance(10);
    const add = await post(ids.v1!, `/holds/${ids.hold1}/items`, item(ids.pc2!, '2026-11-15T07:00:00Z', 30));
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ expiresAt: '2026-11-14T05:25:00.000Z' });
    expect(add.json().items).toHaveLength(3);
    const rows = await db.client.query(
      `SELECT DISTINCT o.hold_expires_at FROM app.occupancy o JOIN app.hold_items hi ON hi.id = o.source_id WHERE o.active AND hi.hold_id = $1`,
      [ids.hold1],
    );
    expect(rows.rows.map((r) => r.hold_expires_at.toISOString())).toEqual(['2026-11-14T05:25:00.000Z']);
    // занятый слот другим посетителем – отказ с позицией, таймер и позиции прежние
    const other = visitor();
    await post(other, '/holds', { branchId: ids.b1, items: [item(ids.vr2!, '2026-11-15T09:00:00Z', 30)] });
    advance(1);
    const fail = await post(ids.v1!, `/holds/${ids.hold1}/items`, item(ids.vr2!, '2026-11-15T09:00:00Z', 15));
    expect(fail.statusCode).toBe(409);
    expect(fail.json().error).toMatchObject({ code: 'SLOT_HELD', details: { items: [{ index: 0, code: 'SLOT_HELD' }] } });
    const h = (await get(ids.v1!, `/holds/${ids.hold1}`)).json();
    expect(h).toMatchObject({ expiresAt: '2026-11-14T05:25:00.000Z' });
    expect(h.items).toHaveLength(3);
  });

  it('через 15 мин без продления удержание истекает: GET – expired без слотов, слот свободен, его берёт другой – гашение в его транзакции', async () => {
    advance(15); // 05:26 > 05:25
    const h = (await get(ids.v1!, `/holds/${ids.hold1}`)).json();
    expect(h).toMatchObject({ status: 'expired', items: [] });
    expect(await stateOf(visitor(), ids.pc1!, '2026-11-15T07:00:00Z')).toBe('free');
    expect((await post(ids.v1!, `/holds/${ids.hold1}/items`, item(ids.pc1!, '2026-11-15T10:00:00Z', 30))).json().error.code).toBe('HOLD_EXPIRED');
    const v = visitor();
    const r = await post(v, '/holds', { branchId: ids.b1, items: [item(ids.pc1!, '2026-11-15T07:00:00Z', 30)] });
    expect(r.statusCode).toBe(201);
    const db1 = await one<{ status: string }>('SELECT status FROM app.holds WHERE id = $1', [ids.hold1]);
    expect(db1.status).toBe('expired');
    const released = await db.client.query(`SELECT DISTINCT release_reason FROM app.occupancy o JOIN app.hold_items hi ON hi.id = o.source_id WHERE hi.hold_id = $1 AND hi.resource_id = $2`, [ids.hold1, ids.pc1]);
    expect(released.rows).toEqual([{ release_reason: 'expired' }]);
    const audit = await one<{ n: number }>(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'hold.expired' AND object_id = $1 AND actor_type = 'system'`, [ids.hold1]);
    expect(audit.n).toBe(1);
    const ev = await one<{ n: number }>(`SELECT count(*)::int n FROM app.outbox_events WHERE event_type = 'hold.expired' AND aggregate_id = $1`, [ids.hold1]);
    expect(ev.n).toBe(1);
  });

  it('задача истечения гасит остальные; повтор – ничего', async () => {
    advance(20);
    const n = await expireDueHolds(pool, clock);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await expireDueHolds(pool, clock)).toBe(0);
    const live = await one<{ n: number }>(`SELECT count(*)::int n FROM app.occupancy WHERE active AND source_type = 'hold_item' AND hold_expires_at <= $1`, [clock.now()]);
    expect(live.n).toBe(0);
  });
});

describe('позиции, отпуск, потолок анонимных, лимит по IP', () => {
  it('удалить позицию (таймер не меняется), последняя – released; release целиком', async () => {
    const v = visitor();
    const h = (await post(v, '/holds', { branchId: ids.b1, items: [item(ids.pc1!, '2026-11-15T11:00:00Z', 30), item(ids.pc2!, '2026-11-15T11:00:00Z', 30)] })).json();
    const del = await post(v, `/holds/${h.id}/items/${h.items[0].id}`, {}, randomUUID(), 'DELETE');
    expect(del.json()).toMatchObject({ expiresAt: h.expiresAt, status: 'active' });
    expect(del.json().items).toHaveLength(1);
    expect(await stateOf(visitor(), h.items[0].resourceId, '2026-11-15T11:00:00Z')).toBe('free');
    const rel = await post(v, `/holds/${h.id}/release`, {});
    expect(rel.json()).toMatchObject({ status: 'released', items: [] });
    expect(await stateOf(visitor(), ids.pc2!, '2026-11-15T11:00:00Z')).toBe('free');
  });

  it('потолок анонимных удержаний филиала из настроек → RATE_LIMITED; у клиента потолка нет', async () => {
    const active = await one<{ n: number }>(`SELECT count(*)::int n FROM app.holds WHERE branch_id = $1 AND status = 'active' AND expires_at > $2 AND client_id IS NULL`, [ids.b1, clock.now()]);
    await db.client.query(
      `INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('booking.max_anonymous_holds_per_branch', 'branch', $1, $2, '2026-01-01', $3)`,
      [ids.b1, JSON.stringify(active.n), SYS],
    );
    const r = await post(visitor(), '/holds', { branchId: ids.b1, items: [item(ids.pc1!, '2026-11-15T12:00:00Z', 30)] });
    expect(r.statusCode).toBe(429);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await codeOf(createHold(c, { clientId: ids.client!, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc1!, start: new Date('2026-11-15T12:00:00Z'), end: new Date('2026-11-15T12:30:00Z') }] }, clock))).toBe('ok');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    await db.client.query(`UPDATE app.settings_values SET valid_to = '2026-01-02' WHERE key = 'booking.max_anonymous_holds_per_branch'`);
  });

  it('лимит /holds по IP (60/мин) – 429 даже со свежей кукой', async () => {
    const limited = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients: { pool, auth: clientAuthConfig('h'.repeat(40)), sms: createDevSmsSender('dev', () => {}), clock } });
    const codes: number[] = [];
    for (let k = 0; k < 62; k++) {
      const r = await limited.inject({ method: 'GET', url: `/api/public/v1/holds/${randomUUID()}`, headers: { cookie: visitor() } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 60).every((c) => c === 404)).toBe(true);
    expect(codes.slice(60)).toEqual([429, 429]);
    await limited.close();
  });
});

describe('attach к клиенту при входе (K5 №11, client_time)', () => {
  const run = <T>(fn: (c: pg.PoolClient) => Promise<T>) => runOccupancyCommand(pool, fn);
  const at = (iso: string, minutes: number) => ({ start: new Date(iso), end: new Date(Date.parse(iso) + minutes * 60_000) });

  it('хук входа переносит удержание посетителя, пишет client_time; повтор attach – то же удержание', async () => {
    const v = randomUUID();
    const h = await run((c) => createHold(c, { clientId: null, visitorId: v }, { branchId: ids.b1!, items: [{ resourceId: ids.vr1!, ...at('2026-11-17T07:00:00Z', 60) }] }, clock));
    await run((c) => attachVisitorHolds(c, { clientId: ids.client!, visitorId: v, at: clock.now() }));
    const row = await one<{ client_id: string }>('SELECT client_id FROM app.holds WHERE id = $1', [h.id]);
    expect(row.client_id).toBe(ids.client);
    const ct = await one<{ n: number }>(`SELECT count(*)::int n FROM app.client_time WHERE active AND client_id = $1`, [ids.client]);
    expect(ct.n).toBe(1);
    const again = await run((c) => attachHold(c, ids.client!, v, h.id, clock));
    expect(again).toMatchObject({ id: h.id, owner: 'client' });
    ids.clientHold = h.id;
  });

  it('attach: ПК 14:00–15:00 и VR 14:30–15:00 одного клиента – CLIENT_OVERLAP (по сети); VR 15:00–15:30 – можно (угол TC-04)', async () => {
    // у клиента в филиале 1 – удержание VR1 17.11 07:00–08:00Z (14:00–15:00 местного); в филиале 2 – попытки
    const v = randomUUID();
    const overlap = await run((c) => createHold(c, { clientId: null, visitorId: v }, { branchId: ids.b2!, items: [{ resourceId: ids.b2pc!, ...at('2026-11-17T07:30:00Z', 30) }] }, clock));
    expect(await codeOf(run((c) => attachHold(c, ids.client!, v, overlap.id, clock)))).toBe('CLIENT_OVERLAP');
    await run((c) => attachVisitorHolds(c, { clientId: ids.client!, visitorId: v, at: clock.now() })); // вход не падает
    expect((await one<{ client_id: string | null }>('SELECT client_id FROM app.holds WHERE id = $1', [overlap.id])).client_id).toBeNull();
    const direct = await codeOf(
      run((c) => createHold(c, { clientId: ids.client!, visitorId: null }, { branchId: ids.b2!, items: [{ resourceId: ids.b2pc!, ...at('2026-11-17T07:30:00Z', 30) }] }, clock)),
    );
    expect(direct).toBe('SLOT_HELD'); // единица уже под удержанием посетителя – база отвечает раньше
    const seq = await run((c) => createHold(c, { clientId: ids.client!, visitorId: null }, { branchId: ids.b2!, items: [{ resourceId: ids.b2pc!, ...at('2026-11-17T08:00:00Z', 30) }] }, clock));
    expect(seq.owner).toBe('client');
    const own = await codeOf(
      run((c) => createHold(c, { clientId: ids.client!, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc1!, ...at('2026-11-17T07:30:00Z', 30) }] }, clock)),
    );
    expect(own).toBe('HOLD_ALREADY_ACTIVE');
    const ct = await db.client.query(`SELECT count(*)::int n FROM app.client_time a JOIN app.client_time b ON a.client_id = b.client_id AND a.id < b.id AND a.period && b.period WHERE a.active AND b.active`);
    expect(ct.rows[0].n).toBe(0);
  });
});
