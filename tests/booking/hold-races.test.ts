// Ревизия S1-05..07 (пп. 3–8): гонки удержаний и подтверждения на настоящей Postgres.
// Одно активное удержание на филиал при параллельных POST /holds (клиент и посетитель), потолок анонимных под
// замком, «мой» слот у следующего гостя на общем компьютере, attach после истёкшего удержания клиента,
// подтверждение против истечения, два посетителя на одну единицу.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { attachHold, createHold, expireDueHolds, ownHoldItems, type HoldOwner } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let t = new Date('2026-11-14T05:00:00Z').getTime();
const clock: Clock = { now: () => new Date(t) };
const at = (ms: number): Clock => ({ now: () => new Date(ms) });
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const pcs: string[] = [];

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function resource(branchId: string, code: string): Promise<string> {
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, $2, $2) RETURNING id`, [branchId, code]);
  const r = await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', $2) RETURNING id`, [branchId, code]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [r.id, u.id]);
  return r.id;
}
let phones = 1_000_000;
const newClient = async () =>
  (await one(`INSERT INTO app.clients (phone_e164, status, created_by_type, registered_at) VALUES ($1, 'active', 'system', now()) RETURNING id`, [`+7913${phones++}`])).id;
const span = (resourceId: string, iso: string, minutes = 30) => ({ resourceId, start: new Date(iso), end: new Date(Date.parse(iso) + minutes * 60_000) });
const hold = (owner: HoldOwner, branchId: string, items: ReturnType<typeof span>[], c: Clock = clock) =>
  runOccupancyCommand(pool, (tx) => createHold(tx, owner, { branchId, items }, c));
const codeOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => {
      if (e instanceof AppError) return e.code;
      throw e;
    },
  );
const countOf = (codes: string[], code: string) => codes.filter((c) => c === code).length;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 24 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients: { pool, auth: clientAuthConfig('r'.repeat(40)), sms: createDevSmsSender('dev', () => {}), clock } });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
    await db.client.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
      [ids[code], SYS],
    );
    await db.client.query(
      `INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'pc', 30, 20000, '2026-01-01', 'active', $2)`,
      [ids[code], SYS],
    );
  }
  for (let k = 0; k < 6; k++) pcs.push(await resource(ids.b1!, `PC${k}`));
  for (let k = 0; k < 6; k++) ids[`b2pc${k}`] = await resource(ids.b2!, `PC${k}`);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('одно активное удержание на филиал (п.3)', () => {
  it('два параллельных createHold одного клиента на разные ПК – одно удержание, второй HOLD_ALREADY_ACTIVE (10 раз)', async () => {
    for (let k = 0; k < 10; k++) {
      const c = await newClient();
      const iso = new Date(Date.parse('2026-11-15T04:00:00Z') + k * 30 * 60_000).toISOString();
      const codes = await Promise.all([codeOf(hold({ clientId: c, visitorId: null }, ids.b1!, [span(pcs[0]!, iso)])), codeOf(hold({ clientId: c, visitorId: null }, ids.b1!, [span(pcs[1]!, iso)]))]);
      expect(codes.sort()).toEqual(['HOLD_ALREADY_ACTIVE', 'ok']);
      expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.holds WHERE client_id = $1 AND status = 'active'`, [c])).n).toBe(1);
      await db.client.query(`UPDATE app.holds SET status = 'released', closed_at = now() WHERE client_id = $1`, [c]);
      await db.client.query(`UPDATE app.occupancy SET active = false, released_at = now(), release_reason = 'released' WHERE active AND source_type = 'hold_item'`);
      await db.client.query(`UPDATE app.client_time SET active = false, released_at = now(), release_reason = 'released' WHERE active`);
    }
  });

  it('то же для посетителя: два параллельных POST /holds с одной кукой – одно удержание', async () => {
    const v = randomUUID();
    const send = (resourceId: string) =>
      app.inject({ method: 'POST', url: '/api/public/v1/holds', headers: { cookie: `yu_visitor=${v}`, 'idempotency-key': randomUUID() }, payload: { branchId: ids.b1, items: [{ resourceId, start: '2026-11-16T07:00:00Z', end: '2026-11-16T07:30:00Z' }] } });
    const [a, b] = await Promise.all([send(pcs[2]!), send(pcs[3]!)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json().error.code).toBe('HOLD_ALREADY_ACTIVE');
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.holds WHERE visitor_id = $1 AND status = 'active'`, [v])).n).toBe(1);
  });
});

describe('потолок анонимных удержаний под замком филиала (п.4)', () => {
  it('потолок 2, шесть параллельных посетителей на разные ПК – ровно 2 удержания, остальные RATE_LIMITED', async () => {
    await db.client.query(
      `INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('booking.max_anonymous_holds_per_branch', 'branch', $1, '2', '2026-01-01', $2)`,
      [ids.b2, SYS],
    );
    const codes = await Promise.all(
      Array.from({ length: 6 }, (_, k) => codeOf(hold({ clientId: null, visitorId: randomUUID() }, ids.b2!, [span(ids[`b2pc${k}`]!, '2026-11-15T07:00:00Z')]))),
    );
    expect(countOf(codes, 'ok')).toBe(2);
    expect(countOf(codes, 'RATE_LIMITED')).toBe(4);
  });
});

describe('ownHoldItems и attach (пп. 6–7)', () => {
  it('следующий гость на общем компьютере: удержание перешло к клиенту – у посетителя с той же кукой слот не «мой»', async () => {
    const v = randomUUID();
    const c = await newClient();
    const h = await hold({ clientId: null, visitorId: v }, ids.b1!, [span(pcs[4]!, '2026-11-17T07:00:00Z')]);
    expect((await ownHoldItems(pool, ids.b1!, { visitorId: v }, clock.now())).has(h.items[0]!.id)).toBe(true);
    await runOccupancyCommand(pool, (tx) => attachHold(tx, c, v, h.id, clock));
    expect((await ownHoldItems(pool, ids.b1!, { visitorId: v }, clock.now())).size).toBe(0);
    expect((await ownHoldItems(pool, ids.b1!, { visitorId: v, clientId: c }, clock.now())).has(h.items[0]!.id)).toBe(true);
  });

  it('attach после истёкшего (не погашенного) удержания клиента на то же время – проходит, старое гасится', async () => {
    const c = await newClient();
    const old = await hold({ clientId: c, visitorId: null }, ids.b2!, [span(ids.b2pc5!, '2026-11-18T07:00:00Z')]);
    t += 16 * 60_000; // старое истекло, задача истечения не проходила
    const v = randomUUID();
    const h = await hold({ clientId: null, visitorId: v }, ids.b1!, [span(pcs[5]!, '2026-11-18T07:00:00Z')]);
    expect((await runOccupancyCommand(pool, (tx) => attachHold(tx, c, v, h.id, clock))).owner).toBe('client');
    expect((await one<{ status: string }>('SELECT status FROM app.holds WHERE id = $1', [old.id])).status).toBe('expired');
  });
});

describe('гонки (п.8)', () => {
  it('подтверждение против истечения параллельно: либо бронь со строками занятости, либо истечение без брони (10 раз)', async () => {
    for (let k = 0; k < 10; k++) {
      const c = await newClient();
      const iso = new Date(Date.parse('2026-11-19T04:00:00Z') + k * 30 * 60_000).toISOString();
      const h = await hold({ clientId: c, visitorId: null }, ids.b1!, [span(pcs[0]!, iso)]);
      const exp = Date.parse(h.expiresAt);
      const [confirmed, expired] = await Promise.all([
        codeOf(runOccupancyCommand(pool, (tx) => confirmHold(tx, c, h.id, at(exp - 1000)))),
        expireDueHolds(pool, at(exp + 1000)),
      ]);
      const bookings = await one<{ n: number }>('SELECT count(*)::int n FROM app.bookings WHERE hold_id = $1', [h.id]);
      const status = (await one<{ status: string }>('SELECT status FROM app.holds WHERE id = $1', [h.id])).status;
      if (confirmed === 'ok') {
        expect([bookings.n, status]).toEqual([1, 'converted']);
        const occ = await one<{ n: number }>(`SELECT count(*)::int n FROM app.occupancy o JOIN app.bookings b ON b.id = o.source_id WHERE b.hold_id = $1 AND o.active`, [h.id]);
        expect(occ.n).toBe(1);
      } else {
        expect(confirmed).toBe('HOLD_EXPIRED');
        expect([bookings.n, status, expired >= 1]).toEqual([0, 'expired', true]);
      }
    }
  });

  it('два посетителя одновременно на одну единицу – один 201, второй 409 SLOT_HELD (10 раз)', async () => {
    for (let k = 0; k < 10; k++) {
      const start = new Date(Date.parse('2026-11-20T04:00:00Z') + k * 30 * 60_000).toISOString();
      const end = new Date(Date.parse(start) + 30 * 60_000).toISOString();
      const send = () =>
        app.inject({ method: 'POST', url: '/api/public/v1/holds', headers: { cookie: `yu_visitor=${randomUUID()}`, 'idempotency-key': randomUUID() }, payload: { branchId: ids.b1, items: [{ resourceId: pcs[1], start, end }] } });
      const [a, b] = await Promise.all([send(), send()]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.statusCode === 409)!.json().error.code).toBe('SLOT_HELD');
    }
  });
});
