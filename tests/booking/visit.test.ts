// S1-10: посещение, завершение, неявка вручную, исправление с причиной (K11 №8–11, 16 §5–6, R-08).
// Повторная отметка прихода не создаёт второе посещение; неявка не создаёт посещение; ошибочная неявка/приход –
// обратная запись и событие; visit.confirmed для Э2. TC-09 (не дублируется), TC-10 (в Э1 штраф не применяется).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { completeVisit, markArrived, markNoShow, revertVisit } from '../../apps/api/src/modules/booking/visit.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let t = new Date('2026-11-14T05:00:00Z').getTime();
const clock: Clock = { now: () => new Date(t) };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
const units: Record<string, string> = {};
let phones = 2_000_000;

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
const newClient = async () =>
  (await one(`INSERT INTO app.clients (phone_e164, status, created_by_type, registered_at) VALUES ($1, 'active', 'system', now()) RETURNING id`, [`+7913${phones++}`])).id;
const span = (resourceId: string, iso: string, minutes = 60) => ({ resourceId, start: new Date(iso), end: new Date(Date.parse(iso) + minutes * 60_000) });
async function book(clientId: string, resourceId: string, iso: string, minutes = 60): Promise<string> {
  const h = await runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.b1!, items: [span(resourceId, iso, minutes)] }, clock));
  return (await runOccupancyCommand(pool, (c) => confirmHold(c, clientId, h.id, clock))).bookings[0]!.id;
}
const ctxOf = (staffId: string, role: 'owner' | 'admin', branchIds: string[] = []): AccessContext => ({
  actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now(),
});
const metaOf = (ctx: AccessContext): AuditRequestMeta => ({ actor: ctx.actor, source: 'crm', requestId: randomUUID() });
const run = <T>(ctx: AccessContext, fn: (tx: pg.PoolClient, meta: AuditRequestMeta) => Promise<T>) => runOccupancyCommand(pool, (tx) => fn(tx, metaOf(ctx)));
const arrive = (id: string, ctx: AccessContext, rowVersion: number) => run(ctx, (tx, m) => markArrived(tx, id, { ctx, rowVersion }, m, clock));
const complete = (id: string, ctx: AccessContext, rowVersion: number) => run(ctx, (tx, m) => completeVisit(tx, id, { ctx, rowVersion }, m, clock));
const noShow = (id: string, ctx: AccessContext, rowVersion: number, reasonId?: string) => run(ctx, (tx, m) => markNoShow(tx, id, { ctx, rowVersion, reasonId }, m, clock));
const revert = (id: string, ctx: AccessContext, rowVersion: number, reason: string) => run(ctx, (tx, m) => revertVisit(tx, id, { ctx, rowVersion, reason }, m, clock));
const visits = async (id: string) => (await db.client.query<{ status: string; completed_at: Date | null; revert_reason: string | null }>(`SELECT status, completed_at, revert_reason FROM app.visits WHERE booking_id = $1 ORDER BY arrived_at, id`, [id])).rows;
const noShows = async (id: string) => (await db.client.query<{ status: string; revert_reason: string | null }>(`SELECT status, revert_reason FROM app.no_shows WHERE booking_id = $1`, [id])).rows;
const codeOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => {
      if (e instanceof AppError) return e.code;
      throw e;
    },
  );
const row = (id: string) =>
  one<{ status: string; row_version: number; current_version: number; resource_id: string; s: Date; e: Date; price_kop: string; cancel_comment: string | null; cancelled_by_type: string | null; cancel_reason_id: string | null }>(
    `SELECT status, row_version, current_version, resource_id, lower(period) s, upper(period) e, price_kop, cancel_comment, cancelled_by_type, cancel_reason_id FROM app.bookings WHERE id = $1`,
    [id],
  );
const liveRows = async (id: string) =>
  (await db.client.query<{ unit_id: string; booking_version: number }>(`SELECT unit_id, booking_version FROM app.occupancy WHERE active AND source_id = $1 ORDER BY unit_id`, [id])).rows;
const events = async (type: string, id: string) =>
  (await db.client.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.outbox_events WHERE event_type = $1 AND aggregate_id = $2`, [type, id])).rows.map((r) => r.payload);

let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;
let foreign: AccessContext;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
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
  ids.pc2 = await resource(ids.b1!, null, 'pc', 'ПК-2', [await unit(ids.b1!, null, 'PC2')]);
  ids.b2pc = await resource(ids.b2!, null, 'pc', 'ПК-1', [await unit(ids.b2!, null, 'PC1')]);
  for (const k of ['owner', 'director', 'admin', 'foreign']) {
    ids[k] = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`, [`${k}@yu.test`, k === 'owner' || k === 'director' ? k : 'admin'])).id;
  }
  owner = ctxOf(ids.owner!, 'owner');
  director = { ...ctxOf(ids.director!, 'admin', [ids.b1!]), role: 'director' };
  admin = ctxOf(ids.admin!, 'admin', [ids.b1!]);
  foreign = ctxOf(ids.foreign!, 'admin', [ids.b2!]);
  ids.no_show_other = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'no_show' AND code = 'other'`)).id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('приход и завершение (K11 №8–9)', () => {
  it('приход – arrived, одно посещение, событие visit.confirmed; повтор – INVALID_STATUS_TRANSITION, посещение одно (TC-09)', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc1!, '2026-11-15T07:00:00Z', 90);
    const saved = t;
    t = Date.parse('2026-11-15T06:45:00Z'); // окно прихода (Q-101)
    expect(await codeOf(arrive(id, admin, 5))).toBe('VERSION_CONFLICT');
    expect(await codeOf(arrive(id, foreign, 1))).toBe('NOT_FOUND');
    const r = await arrive(id, admin, 1);
    expect(r).toMatchObject({ status: 'arrived', rowVersion: 2 });
    expect(await codeOf(arrive(id, admin, 2))).toBe('INVALID_STATUS_TRANSITION');
    expect(await visits(id)).toEqual([{ status: 'active', completed_at: null, revert_reason: null }]);
    expect(await events('visit.confirmed', id)).toEqual([
      expect.objectContaining({ bookingId: id, clientId: a, plannedMinutes: 90, resourceType: 'pc', plannedStart: '2026-11-15T07:00:00.000Z', arrivedAt: clock.now().toISOString() }),
    ]);
    // вторую активную строку не даёт и база (visits_one_active_idx)
    const dup = await db.client.query(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, now(), $4)`, [id, ids.b1, a, ids.admin]).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    expect(dup).toBe('23505');
    await complete(id, admin, 2);
    expect((await visits(id))[0]!.completed_at).toEqual(clock.now());
    expect(await codeOf(complete(id, admin, 3))).toBe('INVALID_STATUS_TRANSITION');
    expect(await liveRows(id)).toHaveLength(1); // завершение слот задним числом не освобождает
    t = saved;
  });

  it('Q-101: приход не раньше чем за visit.arrive_early_min до начала (зона филиала); завершение – только после прихода', async () => {
    const a = await newClient();
    const id = await book(a, ids.vr2!, '2026-11-14T08:00:00Z'); // 15:00 Новосибирска
    const saved = t;
    expect(await codeOf(complete(id, admin, 1))).toBe('INVALID_STATUS_TRANSITION'); // без прихода
    t = Date.parse('2026-11-14T07:29:00Z'); // за 31 мин
    const err = await arrive(id, admin, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'ARRIVAL_TOO_EARLY', httpStatus: 409, details: { arriveFrom: '2026-11-14T07:30:00.000Z' } });
    expect((err as AppError).message).toContain('с 14:30'); // время филиала, не UTC
    expect(await visits(id)).toEqual([]);
    expect((await row(id)).row_version).toBe(1);
    t = Date.parse('2026-11-14T07:30:00Z'); // за 30 мин – можно
    expect(await arrive(id, admin, 1)).toMatchObject({ status: 'arrived' });

    // уровень филиала перекрывает сеть: 0 – только с начала сеанса
    await db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('visit.arrive_early_min', 'branch', $1, '0', '2026-01-01', $2)`, [ids.b1, SYS]);
    const id2 = await book(a, ids.pc2!, '2026-11-14T10:00:00Z');
    t = Date.parse('2026-11-14T09:59:00Z');
    expect(await codeOf(arrive(id2, admin, 1))).toBe('ARRIVAL_TOO_EARLY');
    t = Date.parse('2026-11-14T10:00:00Z');
    expect(await arrive(id2, admin, 1)).toMatchObject({ status: 'arrived' });
    await db.client.query(`DELETE FROM app.settings_values WHERE key = 'visit.arrive_early_min'`);
    t = saved;
  });
});

describe('неявка (K11 №10, R-08) и исправление (№11)', () => {
  it('до начала – отказ; после – no_show без посещения, событие no_show.marked, строк баллов нет (TC-10 в Э1)', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc2!, '2026-11-14T06:00:00Z');
    expect(await codeOf(noShow(id, admin, 1))).toBe('INVALID_STATUS_TRANSITION');
    const saved = t;
    t = Date.parse('2026-11-14T06:20:00Z');
    await noShow(id, admin, 1, ids.no_show_other);
    expect((await row(id)).status).toBe('no_show');
    expect(await visits(id)).toEqual([]);
    expect(await noShows(id)).toEqual([{ status: 'active', revert_reason: null }]);
    expect(await events('no_show.marked', id)).toHaveLength(1);
    expect(await codeOf(arrive(id, admin, 2))).toBe('INVALID_STATUS_TRANSITION');
    expect((await one<{ n: number }>('SELECT count(*)::int n FROM journal.ledger_entries')).n).toBe(0);
    expect(await liveRows(id)).toHaveLength(1);

    // ошибочная неявка: без причины – COMMENT_REQUIRED; Администратору исправлять нельзя (booking.visit.correct – OD)
    expect(await codeOf(revert(id, director, 2, ' '))).toBe('COMMENT_REQUIRED');
    expect(await codeOf(revert(id, admin, 2, 'пришёл'))).toBe('FORBIDDEN');
    await revert(id, director, 2, 'Клиент пришёл, отметили не того');
    expect(await row(id)).toMatchObject({ status: 'confirmed', row_version: 3 });
    expect(await noShows(id)).toEqual([{ status: 'reverted', revert_reason: 'Клиент пришёл, отметили не того' }]);
    expect(await events('no_show.reverted', id)).toEqual([expect.objectContaining({ bookingId: id, reason: 'Клиент пришёл, отметили не того' })]);
    await arrive(id, admin, 3);
    expect(await visits(id)).toHaveLength(1);
    t = saved;
  });

  it('ошибочный приход – обратная запись и visit.reverted; новый приход – новое посещение, активное одно', async () => {
    const a = await newClient();
    const id = await book(a, ids.vr1!, '2026-11-16T07:00:00Z');
    const saved = t;
    t = Date.parse('2026-11-16T06:50:00Z');
    await arrive(id, admin, 1);
    await revert(id, owner, 2, 'Отметили не ту бронь');
    expect(await visits(id)).toEqual([{ status: 'reverted', completed_at: null, revert_reason: 'Отметили не ту бронь' }]);
    expect(await events('visit.reverted', id)).toHaveLength(1);
    await arrive(id, admin, 3);
    expect((await visits(id)).map((v) => v.status).sort()).toEqual(['active', 'reverted']); // arrived_at одинаков – часы стоят
    const ev = await events('visit.confirmed', id);
    expect(ev).toHaveLength(2);
    expect(new Set(ev.map((e) => e.visitId)).size).toBe(2);
    expect(await codeOf(revert(id, owner, 1, 'x'))).toBe('VERSION_CONFLICT');
    await complete(id, admin, 4);
    expect(await codeOf(revert(id, owner, 5, 'x'))).toBe('INVALID_STATUS_TRANSITION');
    const audit = await db.client.query(`SELECT action FROM journal.audit_events WHERE object_id = $1 ORDER BY id`, [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['booking.created', 'visit.confirmed', 'visit.reverted', 'visit.confirmed', 'visit.completed']);
    t = saved;
  });
});
