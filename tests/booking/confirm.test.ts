// S1-07: подтверждение брони (K5 №12, K6 convertHoldItem): 8 повторных проверок, идемпотентность, запрет
// пересечений клиента по сети, версии брони со снимком, цена через quote. TC-01…TC-04; 50 параллельных подтверждений.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold, type HoldDto } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { clientAuthConfig, clientTokenHash, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const PEPPER = 'k'.repeat(40);
let t = new Date('2026-11-14T05:00:00Z').getTime();
const clock: Clock = { now: () => new Date(t) };
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const units: Record<string, string> = {};

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function unit(branchId: string, roomId: string | null, code: string): Promise<string> {
  return (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [branchId, roomId, code])).id;
}
async function resource(branchId: string, roomId: string | null, type: string, name: string, unitIds: string[]): Promise<string> {
  const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [branchId, roomId, type, name]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, unitIds]);
  return r.id;
}
async function client(phone: string): Promise<{ id: string; cookie: string }> {
  const c = await one(`INSERT INTO app.clients (phone_e164, status, created_by_type, registered_at) VALUES ($1, 'active', 'system', now()) RETURNING id`, [phone]);
  const token = randomBytes(24).toString('base64url');
  await db.client.query(`INSERT INTO app.client_sessions (client_id, token_hash, expires_at) VALUES ($1, $2, '2027-01-01')`, [c.id, clientTokenHash(PEPPER, token)]);
  return { id: c.id, cookie: `yu_client=${token}` };
}
const span = (resourceId: string, iso: string, minutes: number) => ({ resourceId, start: new Date(iso), end: new Date(Date.parse(iso) + minutes * 60_000) });
const hold = (clientId: string, branchId: string, items: ReturnType<typeof span>[]): Promise<HoldDto> =>
  runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId, items }, clock));
const confirm = (clientId: string, holdId: string) => runOccupancyCommand(pool, (c) => confirmHold(c, clientId, holdId, clock));
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const bookingsCount = async () => (await one<{ n: number }>('SELECT count(*)::int n FROM app.bookings')).n;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 52 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients: { pool, auth: clientAuthConfig(PEPPER), sms: createDevSmsSender('dev', () => {}), clock } });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'Красный, 1', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
    await db.client.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
      [ids[code], SYS],
    );
    for (const type of ['pc', 'vr_seat', 'room_whole']) {
      await db.client.query(
        `INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, 30, 20000, '2026-01-01', 'active', $3)`,
        [ids[code], type, SYS],
      );
    }
  }
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR-комната', true) RETURNING id`, [ids.b1])).id;
  for (const c of ['VR1', 'VR2', 'PS4']) units[c] = await unit(ids.b1!, ids.room, c);
  ids.vr1 = await resource(ids.b1!, ids.room, 'vr_seat', 'VR-место 1', [units.VR1!]);
  ids.vr2 = await resource(ids.b1!, ids.room, 'vr_seat', 'VR-место 2', [units.VR2!]);
  ids.whole = await resource(ids.b1!, ids.room, 'room_whole', 'VR-комната целиком', [units.VR1!, units.VR2!, units.PS4!]);
  ids.pc1 = await resource(ids.b1!, null, 'pc', 'ПК-1', [await unit(ids.b1!, null, 'PC1')]);
  ids.b2pc = await resource(ids.b2!, null, 'pc', 'ПК-1', [await unit(ids.b2!, null, 'PC1')]);
  ids.ps = await resource(ids.b1!, null, 'ps_room', 'PS5', [await unit(ids.b1!, null, 'PS5')]); // тарифа нет
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('подтверждение по HTTP (K5 №12)', () => {
  it('201 ConfirmResultDto; тот же ключ – тот же ответ; новый ключ после перевода – та же бронь; без входа – AUTH_REQUIRED', async () => {
    const a = await client('+79130000001');
    ids.a = a.id;
    const h = await hold(a.id, ids.b1!, [span(ids.pc1!, '2026-11-15T07:00:00Z', 60)]);
    const key = randomUUID();
    const send = (k: string, cookie: string | null = a.cookie) =>
      app.inject({ method: 'POST', url: `/api/public/v1/holds/${h.id}/confirm`, headers: { 'idempotency-key': k, ...(cookie ? { cookie } : {}) }, payload: {} });
    expect((await send(randomUUID(), null)).json().error.code).toBe('VISITOR_REQUIRED');
    expect((await send(randomUUID(), `yu_visitor=${randomUUID()}`)).json().error.code).toBe('AUTH_REQUIRED');
    const r = await send(key);
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0]).toMatchObject({
      branchId: ids.b1, branchName: 'b1', branchAddress: 'Красный, 1', timezone: 'Asia/Novosibirsk', resourceId: ids.pc1, resourceName: 'ПК-1',
      start: '2026-11-15T07:00:00.000Z', end: '2026-11-15T08:00:00.000Z', durationMinutes: 60, priceKop: 40000, paymentNote: 'pay_at_club', status: 'confirmed', canCancel: true,
    });
    const replay = await send(key);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual(body);
    const again = await send(randomUUID());
    expect(again.json().bookings[0].id).toBe(body.bookings[0].id);
    expect(await bookingsCount()).toBe(1);
    // снимок, аудит, событие
    const v = await one<{ unit_ids: string[]; branch_timezone: string; price_snapshot: object; resource_snapshot: object }>(
      'SELECT unit_ids, branch_timezone, price_snapshot, resource_snapshot FROM journal.booking_versions WHERE booking_id = $1 AND version = 1',
      [body.bookings[0].id],
    );
    expect(v).toMatchObject({ branch_timezone: 'Asia/Novosibirsk', price_snapshot: { units: 2, unitMinutes: 30, pricePerUnitKop: 20000 }, resource_snapshot: { name: 'ПК-1', branchName: 'b1' } });
    expect(v.unit_ids).toHaveLength(1);
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.outbox_events WHERE event_type = 'booking.confirmed' AND aggregate_id = $1`, [body.bookings[0].id])).n).toBe(1);
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'booking.created' AND object_id = $1`, [body.bookings[0].id])).n).toBe(1);
    const occ = await db.client.query(`SELECT source_type, hold_expires_at FROM app.occupancy WHERE active AND source_id = $1`, [body.bookings[0].id]);
    expect(occ.rows).toEqual([{ source_type: 'booking', hold_expires_at: null }]);
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
  });
});

describe('TC-01…TC-04 (tz/20 §10)', () => {
  it('TC-01: один VR на один интервал – второй клиент получает конфликт и до, и после подтверждения', async () => {
    const b = await client('+79130000002');
    ids.b = b.id;
    const h = await hold(ids.a!, ids.b1!, [span(ids.vr1!, '2026-11-16T07:00:00Z', 30)]);
    expect(await codeOf(hold(b.id, ids.b1!, [span(ids.vr1!, '2026-11-16T07:00:00Z', 30)]))).toBe('SLOT_HELD');
    await confirm(ids.a!, h.id);
    expect(await codeOf(hold(b.id, ids.b1!, [span(ids.vr1!, '2026-11-16T07:15:00Z', 15)]))).toBe('SLOT_TAKEN');
  });

  it('TC-02: два разных VR одновременно – обе брони; TC-03: комната на это время – конфликт', async () => {
    const c = await client('+79130000003');
    const h1 = await hold(ids.b!, ids.b1!, [span(ids.vr1!, '2026-11-16T09:00:00Z', 30)]);
    const h2 = await hold(c.id, ids.b1!, [span(ids.vr2!, '2026-11-16T09:00:00Z', 30)]);
    const [r1, r2] = await Promise.all([confirm(ids.b!, h1.id), confirm(c.id, h2.id)]);
    expect([r1.bookings.length, r2.bookings.length]).toEqual([1, 1]);
    const d = await client('+79130000004');
    expect(await codeOf(hold(d.id, ids.b1!, [span(ids.whole!, '2026-11-16T09:00:00Z', 15)]))).toBe('SLOT_TAKEN');
    const room = await hold(d.id, ids.b1!, [span(ids.whole!, '2026-11-16T11:00:00Z', 60)]);
    await confirm(d.id, room.id);
    const e = await client('+79130000005');
    expect(await codeOf(hold(e.id, ids.b1!, [span(ids.vr2!, '2026-11-16T11:30:00Z', 15)]))).toBe('SLOT_TAKEN');
  });

  it('TC-04: ПК 14:00–15:00 и VR 14:30–15:00 одного клиента (другой филиал) – CLIENT_OVERLAP; VR 15:00–15:30 – можно', async () => {
    const f = await client('+79130000006');
    const pc = await hold(f.id, ids.b2!, [span(ids.b2pc!, '2026-11-17T07:00:00Z', 60)]);
    await confirm(f.id, pc.id);
    expect(await codeOf(hold(f.id, ids.b1!, [span(ids.vr1!, '2026-11-17T07:30:00Z', 30)]))).toBe('CLIENT_OVERLAP');
    const ok = await hold(f.id, ids.b1!, [span(ids.vr1!, '2026-11-17T08:00:00Z', 30)]);
    expect((await confirm(f.id, ok.id)).bookings).toHaveLength(1);
    const ct = await db.client.query(`SELECT source_type, count(*)::int n FROM app.client_time WHERE active AND client_id = $1 GROUP BY 1`, [f.id]);
    expect(ct.rows).toEqual([{ source_type: 'booking', n: 2 }]);
  });
});

describe('гонка: 50 параллельных подтверждений одного слота (пул 52)', () => {
  it('ровно одна бронь, все 50 получили её же', async () => {
    const g = await client('+79130000007');
    const h = await hold(g.id, ids.b1!, [span(ids.vr2!, '2026-11-18T07:00:00Z', 30)]);
    const before = await bookingsCount();
    const results = await Promise.all(Array.from({ length: 50 }, () => confirm(g.id, h.id).then((r) => r.bookings[0]!.id, (e: AppError) => e.code)));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect((await bookingsCount()) - before).toBe(1);
    const rows = await db.client.query(`SELECT count(*)::int n FROM app.occupancy WHERE active AND source_id = $1`, [results[0]]);
    expect(rows.rows[0].n).toBe(1);
  }, 60_000);
});

describe('повторные проверки и отказы (01 §8.2)', () => {
  it('удержание истекло к моменту подтверждения – HOLD_EXPIRED, слот свободен для следующего', async () => {
    const h = await hold(ids.a!, ids.b1!, [span(ids.pc1!, '2026-11-19T07:00:00Z', 30)]);
    t += 16 * 60_000;
    expect(await codeOf(confirm(ids.a!, h.id))).toBe('HOLD_EXPIRED');
    const next = await hold(ids.b!, ids.b1!, [span(ids.pc1!, '2026-11-19T07:00:00Z', 30)]);
    expect((await confirm(ids.b!, next.id)).bookings).toHaveLength(1);
  });

  it('строка позиции уже погашена истечением, удержание ещё «живое» – HOLD_EXPIRED и полный откат', async () => {
    const h = await hold(ids.a!, ids.b1!, [span(ids.pc1!, '2026-11-19T09:00:00Z', 30), span(ids.vr1!, '2026-11-19T09:30:00Z', 30)]);
    await db.client.query(`UPDATE app.occupancy SET hold_expires_at = $2 WHERE source_id = $1`, [h.items[1]!.id, new Date(t - 1000)]);
    const before = await bookingsCount();
    expect(await codeOf(confirm(ids.a!, h.id))).toBe('HOLD_EXPIRED');
    expect(await bookingsCount()).toBe(before);
    const live = await one<{ n: number }>(`SELECT count(*)::int n FROM app.occupancy WHERE active AND source_type = 'hold_item' AND source_id = $1`, [h.items[0]!.id]);
    expect(live.n).toBe(1);
    await db.client.query(`UPDATE app.holds SET status = 'released', closed_at = now() WHERE id = $1`, [h.id]);
    await db.client.query(`UPDATE app.occupancy SET active = false, released_at = now(), release_reason = 'released' WHERE source_id = ANY($1::uuid[])`, [h.items.map((i) => i.id)]);
    await db.client.query(`UPDATE app.client_time SET active = false, released_at = now(), release_reason = 'released' WHERE source_id = ANY($1::uuid[])`, [h.items.map((i) => i.id)]);
  });

  it('нет тарифа – TARIFF_NOT_CONFIGURED, удержание не тронуто; блокировка, ограничение клиента, смена состава – отказ', async () => {
    const h = await hold(ids.a!, ids.b1!, [span(ids.ps!, '2026-11-20T07:00:00Z', 30)]);
    expect(await codeOf(confirm(ids.a!, h.id))).toBe('TARIFF_NOT_CONFIGURED');
    expect((await one<{ status: string }>('SELECT status FROM app.holds WHERE id = $1', [h.id])).status).toBe('active');
    await db.client.query(`UPDATE app.holds SET status = 'released', closed_at = now() WHERE id = $1`, [h.id]);
    await db.client.query(`UPDATE app.client_time SET active = false, released_at = now() WHERE source_id = $1`, [h.items[0]!.id]);

    const blk = await hold(ids.b!, ids.b1!, [span(ids.vr2!, '2026-11-20T09:00:00Z', 30)]);
    const reason = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`)).id;
    const block = await one(`INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, created_by) VALUES ($1, 'unit', $2, '[2026-11-20 08:00:00+00,2026-11-20 10:00:00+00)', $3, $4) RETURNING id`, [ids.b1, [units.VR2], reason, SYS]);
    await db.client.query(`INSERT INTO app.resource_block_units (block_id, unit_id, period) VALUES ($1, $2, '[2026-11-20 08:00:00+00,2026-11-20 10:00:00+00)')`, [block.id, units.VR2]);
    expect(await codeOf(confirm(ids.b!, blk.id))).toBe('RESOURCE_BLOCKED');

    const g = await client('+79130000008');
    const rh = await hold(g.id, ids.b1!, [span(ids.pc1!, '2026-11-20T11:00:00Z', 30)]);
    await db.client.query(`UPDATE app.clients SET status = 'blocked' WHERE id = $1`, [g.id]);
    expect(await codeOf(confirm(g.id, rh.id))).toBe('CLIENT_RESTRICTED');

    const k = await client('+79130000009');
    const ch = await hold(k.id, ids.b1!, [span(ids.whole!, '2026-11-21T07:00:00Z', 30)]);
    await db.client.query(`UPDATE app.resource_units SET valid_to = '2026-11-21T00:00:00Z' WHERE resource_id = $1 AND valid_to IS NULL`, [ids.whole]);
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-11-21T00:00:00Z' FROM unnest($2::uuid[]) u`, [ids.whole, [units.VR1, units.VR2]]);
    expect(await codeOf(confirm(k.id, ch.id))).toBe('COMPOSITE_CHANGED');
  });

  it('позиции одного ресурса встык – одна бронь, другие – отдельные с общим checkoutId; смена тарифа не меняет цену', async () => {
    const m = await client('+79130000010');
    const h = await hold(m.id, ids.b1!, [span(ids.pc1!, '2026-11-22T07:00:00Z', 30), span(ids.pc1!, '2026-11-22T07:30:00Z', 30), span(ids.vr1!, '2026-11-22T09:00:00Z', 30)]);
    const r = await confirm(m.id, h.id);
    expect(r.bookings.map((b) => [b.resourceId, b.durationMinutes, b.priceKop])).toEqual([
      [ids.pc1, 60, 40000],
      [ids.vr1, 30, 20000],
    ]);
    const co = await db.client.query('SELECT DISTINCT checkout_id FROM app.bookings WHERE hold_id = $1', [h.id]);
    expect(co.rows).toEqual([{ checkout_id: r.checkoutId }]);
    await db.client.query(`UPDATE app.tariffs SET price_per_unit_kop = 99900 WHERE branch_id = $1 AND resource_type = 'pc'`, [ids.b1]);
    const after = (await one<{ price_kop: string }>('SELECT price_kop FROM app.bookings WHERE id = $1', [r.bookings[0]!.id])).price_kop;
    expect(Number(after)).toBe(40000);
  });
});
