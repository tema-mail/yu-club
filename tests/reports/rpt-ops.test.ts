// S4-60: миграция 0406 (K24 §1, §9, §13) – представления rpt_* броней, ресурсов, клиентов и роль yu_reports.
// yu_app: запись в представление → 42501; yu_reports: чтение таблицы модуля мимо rpt_* → 42501, любая запись → 25006
// (default_transaction_read_only); «комната целиком» – whole_room на всех единицах; бронь без профиля – guest; вверх/вниз/вверх.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let branchId: string;
const SYS = '00000000-0000-4000-8000-000000000000';
const ids: Record<string, string> = {};

const q = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => (await db.client.query<T>(text, values)).rows;
const one = async (text: string, values: unknown[] = []) => (await q<{ id: string }>(text, values))[0]!.id;

async function pgCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

async function booking(key: string, resource: string, units: string[], period: [string, string], client: string, status = 'confirmed') {
  const id = await one(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status, cancelled_at, cancel_comment)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange($4, $5, '[)'), 50000, 'crm', 'staff', $6,
             CASE WHEN $6 LIKE 'cancelled%' THEN now() END, CASE WHEN $6 LIKE 'cancelled%' THEN 'тест' END) RETURNING id`,
    [branchId, client, resource, period[0], period[1], status],
  );
  await db.client.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     VALUES ($1, 1, $2, tstzrange($3, $4, '[)'), 'Asia/Novosibirsk', $5::uuid[], '{}', 50000, '{}', 'staff')`,
    [id, resource, period[0], period[1], units],
  );
  for (const u of units) {
    await db.client.query(
      `INSERT INTO app.occupancy (unit_id, branch_id, period, source_type, source_id, booking_version) VALUES ($1, $2, tstzrange($3, $4, '[)'), 'booking', $5, 1)`,
      [u, branchId, period[0], period[1], id],
    );
  }
  ids[key] = id;
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  branchId = (await createTestBranch(db.client)).id;
  const room = await one(`INSERT INTO app.rooms (branch_id, slug, name, whole_rent_allowed) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [branchId]);
  const unit = (code: string) => one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [branchId, room, code]);
  ids.u1 = await unit('vr1');
  ids.u2 = await unit('vr2');
  ids.ps4 = await unit('ps4');
  const resource = async (type: string, name: string, units: string[]) => {
    const id = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [branchId, room, type, name]);
    for (const u of units) await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [id, u]);
    return id;
  };
  ids.vr1 = await resource('vr_seat', 'VR1', [ids.u1]);
  ids.vr2 = await resource('vr_seat', 'VR2', [ids.u2]);
  ids.whole = await resource('room_whole', 'Комната целиком', [ids.u1, ids.u2, ids.ps4]);
  ids.profile = await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79990000001', 'П', 'active', 'system', now()) RETURNING id`);
  ids.guest = await one(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+79990000002', 'guest', 'system') RETURNING id`);
  await booking('b1', ids.vr1, [ids.u1], ['2026-11-10T04:00:00Z', '2026-11-10T05:00:00Z'], ids.profile, 'arrived');
  await booking('wr', ids.whole, [ids.u1, ids.u2, ids.ps4], ['2026-11-10T06:00:00Z', '2026-11-10T08:00:00Z'], ids.guest);
  await booking('cx', ids.vr2, [ids.u2], ['2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z'], ids.profile, 'cancelled_by_client');
  await db.client.query(`UPDATE app.occupancy SET active = false, released_at = now(), release_reason = 'cancelled' WHERE source_id = $1`, [ids.cx]);
  await db.client.query(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, '2026-11-10T04:01:00Z', $4)`, [ids.b1, branchId, ids.profile, SYS]);
  const reason = await one(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`);
  const block = await one(
    `INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, created_by) VALUES ($1, 'unit', ARRAY[$2]::uuid[], tstzrange('2026-11-12T00:00:00Z', '2026-11-12T10:00:00Z', '[)'), $3, $4) RETURNING id`,
    [branchId, ids.u2, reason, SYS],
  );
  await db.client.query(`INSERT INTO app.resource_block_units (block_id, unit_id, period) VALUES ($1, $2, tstzrange('2026-11-12T00:00:00Z', '2026-11-12T10:00:00Z', '[)'))`, [block, ids.u2]);
});
afterAll(async () => {
  await db.drop();
});

describe('0406 rpt_ops (S4-60)', () => {
  it('rpt_bookings: guest/profile, инициатор отмены, длительность; rpt_visits – живое посещение с плановым временем', async () => {
    const rows = await q<{ booking_id: string; client_kind: string; cancelled_by: string | null; minutes: number; city_id: string }>(`SELECT * FROM app.rpt_bookings ORDER BY start_at`);
    const by = new Map(rows.map((r) => [r.booking_id, r]));
    expect(by.get(ids.b1!)).toMatchObject({ client_kind: 'profile', cancelled_by: null, minutes: 60 });
    expect(by.get(ids.wr!)).toMatchObject({ client_kind: 'guest', minutes: 120 });
    expect(by.get(ids.cx!)!.cancelled_by).toBe('client');
    const visits = await q<{ booking_id: string; planned_minutes: number; resource_type: string }>(`SELECT * FROM app.rpt_visits`);
    expect(visits).toEqual([expect.objectContaining({ booking_id: ids.b1, planned_minutes: 60, resource_type: 'vr_seat' })]);
  });

  it('rpt_unit_booked: «комната целиком» – whole_room на всех трёх единицах, отменённая бронь не занимает', async () => {
    const rows = await q<{ unit_id: string; booking_id: string; whole_room: boolean }>(`SELECT unit_id, booking_id, whole_room FROM app.rpt_unit_booked`);
    const whole = rows.filter((r) => r.booking_id === ids.wr);
    expect(whole.map((r) => r.unit_id).sort()).toEqual([ids.u1, ids.u2, ids.ps4].sort());
    expect(whole.every((r) => r.whole_room)).toBe(true);
    expect(rows.find((r) => r.booking_id === ids.b1)).toMatchObject({ unit_id: ids.u1, whole_room: false });
    expect(rows.some((r) => r.booking_id === ids.cx)).toBe(false);
  });

  it('rpt_units: VR1 и VR2 со своим ресурсом, PS4 без ресурса – self_bookable = false; rpt_unit_blocks – kind по причине', async () => {
    const units = new Map((await q<{ unit_id: string; resource_id: string | null; self_bookable: boolean }>(`SELECT * FROM app.rpt_units`)).map((u) => [u.unit_id, u]));
    expect(units.get(ids.u1!)).toMatchObject({ resource_id: ids.vr1, self_bookable: true });
    expect(units.get(ids.u2!)).toMatchObject({ resource_id: ids.vr2, self_bookable: true });
    expect(units.get(ids.ps4!)).toMatchObject({ resource_id: null, self_bookable: false });
    expect(await q(`SELECT unit_id, kind, reason_code FROM app.rpt_unit_blocks`)).toEqual([{ unit_id: ids.u2, kind: 'repair', reason_code: 'repair' }]);
  });

  it('yu_app: запись в представление → 42501', async () => {
    await db.client.query('SET ROLE yu_app');
    try {
      expect(await pgCode(() => db.client.query(`INSERT INTO app.rpt_clients (client_id, status, created_at) VALUES (gen_random_uuid(), 'guest', now())`))).toBe('42501');
      expect(await pgCode(() => db.client.query(`UPDATE app.rpt_clients SET status = 'blocked'`))).toBe('42501');
      expect(await pgCode(() => db.client.query(`DELETE FROM app.rpt_clients`))).toBe('42501');
      expect((await db.client.query(`SELECT count(*)::int AS n FROM app.rpt_bookings`)).rows[0].n).toBe(3);
    } finally {
      await db.client.query('RESET ROLE');
    }
  });

  it('yu_reports: rpt_* читаются, таблица модуля мимо rpt_* → 42501, любая запись → 25006', async () => {
    const c = new pg.Client({ connectionString: db.reportsUrl });
    await c.connect();
    try {
      expect((await c.query(`SHOW default_transaction_read_only`)).rows[0].default_transaction_read_only).toBe('on');
      expect((await c.query(`SELECT count(*)::int AS n FROM app.rpt_bookings`)).rows[0].n).toBe(3);
      expect((await c.query(`SELECT count(*)::int AS n FROM app.branch_weekly_hours`)).rows[0].n).toBe(0);
      expect(await pgCode(() => c.query(`SELECT * FROM app.bookings`))).toBe('42501');
      expect(await pgCode(() => c.query(`SELECT * FROM app.clients`))).toBe('42501');
      expect(await pgCode(() => c.query(`SELECT * FROM journal.finance_operations`))).toBe('42501');
      expect(await pgCode(() => c.query(`INSERT INTO app.bookings (id) VALUES (gen_random_uuid())`))).toBe('25006');
      // запись в представление отвергается ещё при раскрытии представления – правом (прав на запись у роли нет вовсе)
      expect(await pgCode(() => c.query(`UPDATE app.rpt_clients SET status = 'blocked'`))).toBe('42501');
      expect(await pgCode(() => c.query(`CREATE TABLE app.x (id int)`))).toBe('25006');
      // сменить режим своей сессии роль может, но записывать ей всё равно нечего: прав нет
      await c.query('SET default_transaction_read_only = off');
      expect(await pgCode(() => c.query(`INSERT INTO app.bookings (id) VALUES (gen_random_uuid())`))).toBe('42501');
    } finally {
      await c.end();
    }
  });

  it('вверх/вниз/вверх: down с 0406 убирает представления и права yu_reports, повторный up возвращает', async () => {
    const steps = (await loadMigrations()).filter((m) => m.version >= '0406').length;
    const down = await migrateDown(db.client, steps);
    expect(down).toContain('0406');
    expect((await q(`SELECT 1 FROM pg_views WHERE viewname LIKE 'rpt_%' AND viewname IN ('rpt_bookings','rpt_units')`)).length).toBe(0);
    expect((await q<{ ok: boolean }>(`SELECT has_schema_privilege('yu_reports', 'app', 'USAGE') AS ok`))[0]!.ok).toBe(false);
    await migrateUp(db.client);
    expect((await q(`SELECT 1 FROM pg_views WHERE viewname IN ('rpt_bookings','rpt_units')`)).length).toBe(2);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM app.rpt_bookings`))[0]!.n).toBe(3);
  });
});
