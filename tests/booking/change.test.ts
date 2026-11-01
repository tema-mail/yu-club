// S1-09: отмена и перенос брони (K5 №13, K11 №6–7, 01 §11–12, R-12). Перенос – новая версия, старая действует,
// пока новая не записана; отмена комнаты не трогает чужую бронь VR и наоборот (18 §5.3 п.5–6); комментарий
// сотрудника обязателен. TC-11 (отмена клубом), TC-17 (график – в серверной проверке переноса) из tz/20 §10.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { cancelBooking, rescheduleBooking, type CancelBy, type RescheduleInput } from '../../apps/api/src/modules/booking/change.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
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
const clientMeta = (clientId: string): AuditRequestMeta => ({ actor: { kind: 'client', clientId, sessionId: '' }, source: 'account', requestId: randomUUID() });
const cancel = (id: string, by: CancelBy) =>
  runOccupancyCommand(pool, (c) => cancelBooking(c, id, by, by.kind === 'client' ? clientMeta(by.clientId) : metaOf(by.ctx), clock));
const reschedule = (id: string, input: RescheduleInput) => runOccupancyCommand(pool, (c) => rescheduleBooking(c, id, input, metaOf(input.ctx), clock));
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
  for (const k of ['owner', 'admin', 'foreign']) {
    ids[k] = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`, [`${k}@yu.test`, k === 'owner' ? 'owner' : 'admin'])).id;
  }
  owner = ctxOf(ids.owner!, 'owner');
  admin = ctxOf(ids.admin!, 'admin', [ids.b1!]);
  foreign = ctxOf(ids.foreign!, 'admin', [ids.b2!]);
  ids.club_other = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' AND code = 'other'`)).id;
  ids.club_equipment = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' AND code = 'equipment_failure'`)).id;
  ids.client_plans = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_client' AND code = 'changed_plans'`)).id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('отмена клиентом (K5 №13, R-12)', () => {
  it('своя confirmed до начала – cancelled_by_client, строки погашены, событие client; чужая – 404; повтор – BOOKING_NOT_CANCELLABLE', async () => {
    const a = await newClient();
    const b = await newClient();
    const id = await book(a, ids.pc1!, '2026-11-15T07:00:00Z');
    expect(await codeOf(cancel(id, { kind: 'client', clientId: b }))).toBe('NOT_FOUND');
    await cancel(id, { kind: 'client', clientId: a, reason: 'Планы' });
    expect(await row(id)).toMatchObject({ status: 'cancelled_by_client', row_version: 2, cancel_comment: 'Планы', cancelled_by_type: 'client' });
    expect(await liveRows(id)).toEqual([]);
    const reason = await one<{ release_reason: string }>(`SELECT DISTINCT release_reason FROM app.occupancy WHERE source_id = $1`, [id]);
    expect(reason.release_reason).toBe('cancelled');
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.client_time WHERE active AND source_id = $1`, [id])).n).toBe(0);
    expect(await events('booking.cancelled', id)).toEqual([expect.objectContaining({ cancelledBy: 'client', bookingVersion: 1, clientId: a, publicReason: null })]);
    expect(await codeOf(cancel(id, { kind: 'client', clientId: a }))).toBe('BOOKING_NOT_CANCELLABLE');
    // слот снова свободен
    expect(await codeOf(book(b, ids.pc1!, '2026-11-15T07:00:00Z'))).toBe('ok');
  });

  it('после начала и при выключенной настройке – BOOKING_NOT_CANCELLABLE', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc2!, '2026-11-14T06:00:00Z');
    const saved = t;
    t = Date.parse('2026-11-14T06:10:00Z');
    expect(await codeOf(cancel(id, { kind: 'client', clientId: a }))).toBe('BOOKING_NOT_CANCELLABLE');
    t = saved;
    await db.client.query(
      `INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('booking.client_cancel_enabled', 'network', 'false', '2026-01-01', $1)`,
      [SYS],
    );
    expect(await codeOf(cancel(id, { kind: 'client', clientId: a }))).toBe('BOOKING_NOT_CANCELLABLE');
    await db.client.query(`UPDATE app.settings_values SET valid_to = '2026-01-02' WHERE key = 'booking.client_cancel_enabled'`);
  });
});

describe('18 §5.3 п.5–6: отмена освобождает только свои единицы', () => {
  it('отмена комнаты целиком не трогает бронь VR-места; отмена VR-места не трогает комнату', async () => {
    const a = await newClient();
    const b = await newClient();
    const vr = await book(a, ids.vr1!, '2026-11-16T05:00:00Z');
    const room = await book(b, ids.whole!, '2026-11-16T06:00:00Z');
    await cancel(room, { kind: 'staff', ctx: admin, rowVersion: 1, initiator: 'club', reasonId: ids.club_other!, comment: 'Технический сбой' });
    expect(await liveRows(vr)).toEqual([{ unit_id: units.VR1, booking_version: 1 }]);
    expect(await liveRows(room)).toEqual([]);
    expect(await codeOf(book(await newClient(), ids.vr2!, '2026-11-16T06:00:00Z'))).toBe('ok');

    const room2 = await book(b, ids.whole!, '2026-11-16T08:00:00Z');
    const vr2 = await book(a, ids.vr2!, '2026-11-16T07:00:00Z');
    await cancel(vr2, { kind: 'client', clientId: a });
    expect((await liveRows(room2)).map((r) => r.unit_id).sort()).toEqual([units.VR1, units.VR2, units.PS4].sort());
  });
});

describe('отмена сотрудником (K11 №6, 01 §12), TC-11', () => {
  it('без комментария – COMMENT_REQUIRED; устаревший rowVersion – VERSION_CONFLICT; чужой филиал – 404; причина не того домена – 400', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc1!, '2026-11-17T05:00:00Z');
    expect(await codeOf(cancel(id, { kind: 'staff', ctx: admin, rowVersion: 1, initiator: 'club', reasonId: ids.club_other!, comment: '  ' }))).toBe('COMMENT_REQUIRED');
    expect(await codeOf(cancel(id, { kind: 'staff', ctx: admin, rowVersion: 7, initiator: 'club', reasonId: ids.club_other!, comment: 'x' }))).toBe('VERSION_CONFLICT');
    expect(await codeOf(cancel(id, { kind: 'staff', ctx: foreign, rowVersion: 1, initiator: 'club', reasonId: ids.club_other!, comment: 'x' }))).toBe('NOT_FOUND');
    expect(await codeOf(cancel(randomUUID(), { kind: 'staff', ctx: foreign, rowVersion: 1, initiator: 'club', reasonId: ids.club_other!, comment: 'x' }))).toBe('NOT_FOUND');
    expect(await codeOf(cancel(id, { kind: 'staff', ctx: admin, rowVersion: 1, initiator: 'club', reasonId: ids.client_plans!, comment: 'x' }))).toBe('VALIDATION_FAILED');
    expect((await row(id)).status).toBe('confirmed');
  });

  it('TC-11: отмена клубом – ресурс свободен, причина и сотрудник записаны, событие для уведомления, штрафа нет', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc2!, '2026-11-17T06:00:00Z');
    await cancel(id, { kind: 'staff', ctx: admin, rowVersion: 1, initiator: 'club', reasonId: ids.club_equipment!, comment: 'Сломался монитор' });
    expect(await row(id)).toMatchObject({ status: 'cancelled_by_club', cancelled_by_type: 'staff', cancel_reason_id: ids.club_equipment, cancel_comment: 'Сломался монитор' });
    expect(await liveRows(id)).toEqual([]);
    expect(await events('booking.cancelled', id)).toEqual([expect.objectContaining({ cancelledBy: 'club', reasonCode: 'equipment_failure', publicReason: 'Неисправность оборудования' })]);
    const audit = await one<{ actor_id: string; reason: string }>(`SELECT actor_id, reason FROM journal.audit_events WHERE action = 'booking.cancelled' AND object_id = $1`, [id]);
    expect(audit).toEqual({ actor_id: ids.admin, reason: 'Сломался монитор' });
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM journal.ledger_entries`)).n).toBe(0);
    expect(await codeOf(book(await newClient(), ids.pc2!, '2026-11-17T06:00:00Z'))).toBe('ok');
  });

  it('по звонку клиента – cancelled_by_client, автор – сотрудник, событие client', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc1!, '2026-11-17T08:00:00Z');
    await cancel(id, { kind: 'staff', ctx: owner, rowVersion: 1, initiator: 'client_by_phone', reasonId: ids.client_plans!, comment: 'Позвонил, не придёт' });
    expect(await row(id)).toMatchObject({ status: 'cancelled_by_client', cancelled_by_type: 'staff' });
    expect(await events('booking.cancelled', id)).toEqual([expect.objectContaining({ cancelledBy: 'client' })]);
    expect(await codeOf(cancel(id, { kind: 'staff', ctx: owner, rowVersion: 2, initiator: 'club', reasonId: ids.club_other!, comment: 'ещё раз' }))).toBe('INVALID_STATUS_TRANSITION');
  });
});

describe('перенос (K11 №7, 01 §11)', () => {
  it('на занятое время – SLOT_TAKEN, старая версия действует; без причины – COMMENT_REQUIRED', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc1!, '2026-11-18T05:00:00Z');
    await book(await newClient(), ids.pc2!, '2026-11-18T07:00:00Z');
    const base = { ctx: admin, rowVersion: 1, reason: 'Попросил клиент' };
    expect(await codeOf(reschedule(id, { ...base, ...span(ids.pc2!, '2026-11-18T07:00:00Z') }))).toBe('SLOT_TAKEN');
    expect(await codeOf(reschedule(id, { ...base, reason: '', ...span(ids.pc2!, '2026-11-18T09:00:00Z') }))).toBe('COMMENT_REQUIRED');
    expect(await row(id)).toMatchObject({ current_version: 1, resource_id: ids.pc1, row_version: 1 });
    expect(await liveRows(id)).toHaveLength(1);
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.client_time WHERE active AND source_id = $1`, [id])).n).toBe(1);
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM journal.booking_versions WHERE booking_id = $1`, [id])).n).toBe(1);
  });

  it('на свободное (со сдвигом на себя) – версия 2, старые строки rescheduled, новые с booking_version 2, цена по новой длительности, событие', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc1!, '2026-11-19T05:00:00Z');
    const res = await reschedule(id, { ctx: admin, rowVersion: 1, reason: 'Задерживается', ...span(ids.pc1!, '2026-11-19T05:30:00Z', 90) });
    expect(res).toMatchObject({ currentVersion: 2, rowVersion: 2 });
    expect(await row(id)).toMatchObject({ current_version: 2, row_version: 2, s: new Date('2026-11-19T05:30:00Z'), e: new Date('2026-11-19T07:00:00Z'), price_kop: '60000' });
    expect((await liveRows(id)).map((r) => r.booking_version)).toEqual([2]);
    const old = await one<{ release_reason: string }>(`SELECT release_reason FROM app.occupancy WHERE NOT active AND source_id = $1`, [id]);
    expect(old.release_reason).toBe('rescheduled');
    const v = await db.client.query(`SELECT version, reason, created_by_type FROM journal.booking_versions WHERE booking_id = $1 ORDER BY version`, [id]);
    expect(v.rows).toEqual([
      { version: 1, reason: null, created_by_type: 'client' },
      { version: 2, reason: 'Задерживается', created_by_type: 'staff' },
    ]);
    expect(await events('booking.rescheduled', id)).toEqual([
      expect.objectContaining({ previous: expect.objectContaining({ version: 1, start: '2026-11-19T05:00:00.000Z' }), current: expect.objectContaining({ version: 2, priceKop: 60000 }) }),
    ]);
    // клиентское время перенесено: на старое время у клиента пересечения больше нет
    expect(await codeOf(book(a, ids.pc2!, '2026-11-19T05:00:00Z', 30))).toBe('ok');
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
  });

  it('TC-17: закрытый по новому графику день – OUTSIDE_SCHEDULE; вне окна – OUTSIDE_BOOKING_WINDOW; ресурс чужого филиала – 404; не confirmed – отказ', async () => {
    const a = await newClient();
    const id = await book(a, ids.pc2!, '2026-11-20T05:00:00Z');
    await db.client.query(
      `INSERT INTO app.calendar_exceptions (branch_id, scope_type, local_date, kind, reason, created_by) VALUES ($1, 'branch', '2026-11-21', 'closed', 'Ремонт', $2)`,
      [ids.b1, SYS],
    );
    const base = { ctx: admin, rowVersion: 1, reason: 'перенос' };
    expect(await codeOf(reschedule(id, { ...base, ...span(ids.pc2!, '2026-11-21T05:00:00Z') }))).toBe('OUTSIDE_SCHEDULE');
    expect(await codeOf(reschedule(id, { ...base, ...span(ids.pc2!, '2027-02-20T05:00:00Z') }))).toBe('OUTSIDE_BOOKING_WINDOW');
    expect(await codeOf(reschedule(id, { ...base, ...span(ids.b2pc!, '2026-11-20T08:00:00Z') }))).toBe('NOT_FOUND');
    expect(await codeOf(reschedule(id, { ...base, ctx: foreign, ...span(ids.pc2!, '2026-11-20T08:00:00Z') }))).toBe('NOT_FOUND');
    await cancel(id, { kind: 'client', clientId: a });
    expect(await codeOf(reschedule(id, { ...base, rowVersion: 2, ...span(ids.pc2!, '2026-11-20T08:00:00Z') }))).toBe('INVALID_STATUS_TRANSITION');
  });

  it('комната целиком переносится на VR-место: свои единицы освобождены, чужая бронь VR2 не тронута', async () => {
    const a = await newClient();
    const b = await newClient();
    const room = await book(a, ids.whole!, '2026-11-22T05:00:00Z');
    const vr2 = await book(b, ids.vr2!, '2026-11-22T07:00:00Z');
    await reschedule(room, { ctx: admin, rowVersion: 1, reason: 'меньше людей', ...span(ids.vr1!, '2026-11-22T07:00:00Z') });
    expect(await liveRows(room)).toEqual([{ unit_id: units.VR1, booking_version: 2 }]);
    expect(await liveRows(vr2)).toEqual([{ unit_id: units.VR2, booking_version: 1 }]);
    expect(await codeOf(book(await newClient(), ids.vr2!, '2026-11-22T05:00:00Z'))).toBe('ok');
  });
});
