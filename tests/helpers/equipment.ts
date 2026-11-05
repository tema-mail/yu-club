// Фикстуры модуля equipment (S3-30…S3-39) на настоящей Postgres: два филиала, VR-комната с единицами VR1, VR2, PS4,
// ресурсы «VR-место 1/2» и «комната целиком», настоящая бронь (строка bookings, версия, занятость), контексты ролей.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { interval, type Clock } from '../../apps/api/src/core/time.ts';
import { occupy, runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { expandToUnits } from '../../apps/api/src/modules/resources/index.ts';
import { createTestBranch } from './network.ts';
import { createTestDatabase, type TestDatabase } from './pg.ts';

export interface EquipmentWorld {
  db: TestDatabase;
  pool: pg.Pool;
  branch: string;
  cityId: string;
  other: string;
  room: string;
  otherRoom: string;
  units: { VR1: string; VR2: string; PS4: string; otherUnit: string };
  resources: { VR1: string; VR2: string; whole: string };
  client: string;
  reasonRepair: string;
  categoryId: string;
  close: () => Promise<void>;
}

export function ctxOf(clock: Clock, role: StaffRole, branchIds: string[] = [], staffId: string = randomUUID()): AccessContext {
  return { actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() };
}
export const metaOf = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

export async function inTx<T>(pool: pg.Pool, fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

export async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

export async function createEquipmentWorld(max = 16): Promise<EquipmentWorld> {
  const db = await createTestDatabase({ migrate: true });
  const pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max });
  const one = async (sql: string, params: unknown[] = []): Promise<string> => (await db.client.query<{ id: string }>(`${sql} RETURNING id`, params)).rows[0]!.id;
  const { id: branch, cityId } = await createTestBranch(db.client);
  const { id: other } = await createTestBranch(db.client, { cityId });
  const room = await one(`INSERT INTO app.rooms (branch_id, slug, name) VALUES ($1, 'vr', 'VR-комната')`, [branch]);
  const otherRoom = await one(`INSERT INTO app.rooms (branch_id, slug, name) VALUES ($1, 'vr2', 'Чужая комната')`, [other]);
  const unit = (b: string, r: string, code: string) => one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3)`, [b, r, code]);
  const units = { VR1: await unit(branch, room, 'VR1'), VR2: await unit(branch, room, 'VR2'), PS4: await unit(branch, room, 'PS4'), otherUnit: await unit(other, otherRoom, 'X1') };
  const resource = async (type: string, name: string, ids: string[]) => {
    const id = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4)`, [branch, room, type, name]);
    for (const u of ids) await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2020-01-01')`, [id, u]);
    return id;
  };
  const resources = {
    VR1: await resource('vr_seat', 'VR-место 1', [units.VR1]),
    VR2: await resource('vr_seat', 'VR-место 2', [units.VR2]),
    whole: await resource('room_whole', 'Комната целиком', [units.VR1, units.VR2, units.PS4]),
  };
  const client = await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000099', 'Иван', 'active', 'system', now())`);
  const reasonRepair = (await db.client.query<{ id: string }>(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`)).rows[0]!.id;
  const categoryId = (await db.client.query<{ id: string }>(`SELECT id FROM app.equipment_categories WHERE name = 'VR-шлемы'`)).rows[0]!.id;
  return {
    db, pool, branch, cityId, other, room, otherRoom, units, resources, client, reasonRepair, categoryId,
    close: async () => {
      await pool.end();
      await db.drop();
    },
  };
}

/** Настоящая подтверждённая бронь: строка bookings, версия и занятость единиц ресурса. */
export async function createBooking(w: EquipmentWorld, resourceId: string, startIso: string, minutes = 60, status = 'confirmed'): Promise<string> {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + minutes * 60_000);
  const u = await expandToUnits(w.pool, resourceId, start);
  const id = (
    await w.db.client.query<{ id: string }>(
      `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
       VALUES (gen_random_uuid(), $1, $2, $3, tstzrange($4, $5, '[)'), 20000, 'crm', 'staff', $6) RETURNING id`,
      [w.branch, w.client, resourceId, start, end, status],
    )
  ).rows[0]!.id;
  await w.db.client.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     VALUES ($1, 1, $2, tstzrange($3, $4, '[)'), 'Asia/Novosibirsk', $5, '{"name":"VR"}', 20000, '{}', 'staff')`,
    [id, resourceId, start, end, u.unitIds],
  );
  await runOccupancyCommand(w.pool, (c) => occupy(c, { branchId: w.branch, units: u, period: interval(start, end), source: { type: 'booking', id, version: 1 }, clientId: w.client }));
  return id;
}
