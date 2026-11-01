// Провайдеры по реальной таблице броней (после S1-07): список затронутых в календаре (network), связь клиента
// с филиалом в поиске CRM (clients), будущие брони и удержания в changeComposition и блокировках (resources, booking).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { createBlock } from '../../apps/api/src/modules/booking/blocks.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { bookingsProvider, clientBranchLinks } from '../../apps/api/src/modules/booking/providers.ts';
import { searchClients } from '../../apps/api/src/modules/clients/index.ts';
import { previewHoursChange } from '../../apps/api/src/modules/network/index.ts';
import { calendarTargets, changeComposition } from '../../apps/api/src/modules/resources/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const clock: Clock = { now: () => new Date('2026-11-14T05:00:00Z') };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
const span = (resourceId: string, iso: string, minutes: number) => ({ resourceId, start: new Date(iso), end: new Date(Date.parse(iso) + minutes * 60_000) });
const ctxOf = (staffId: string, role: 'owner' | 'admin', branchIds: string[] = []): AccessContext => ({
  actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now(),
});
async function codeOf(p: Promise<unknown>): Promise<AppError | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(
    `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
    [ids.b1, SYS],
  );
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 100, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.unit = u.id;
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, u.id]);
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type, registered_at) VALUES ('+79130000123', 'Ирина', 'Соколова', 'active', 'system', now()) RETURNING id`)).id;
  ids.staff = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('А', 'А', 'a@yu.test', 'admin', 'x') RETURNING id`)).id;
  const h = await runOccupancyCommand(pool, (c) => createHold(c, { clientId: ids.client!, visitorId: null }, { branchId: ids.b1!, items: [span(ids.pc!, '2026-11-15T13:00:00Z', 60)] }, clock));
  ids.booking = (await runOccupancyCommand(pool, (c) => confirmHold(c, ids.client!, h.id, clock))).bookings[0]!.id; // 20:00–21:00 местного
  const h2 = await runOccupancyCommand(pool, (c) => createHold(c, { clientId: null, visitorId: randomUUID() }, { branchId: ids.b1!, items: [span(ids.pc!, '2026-11-16T05:00:00Z', 30)] }, clock));
  ids.hold = h2.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('network: список затронутых броней (K13 previewHoursChange)', () => {
  it('сокращённый день 10–18 возвращает бронь 20:00–21:00; провайдер видит только действующие брони', async () => {
    const r = await previewHoursChange(
      pool,
      ctxOf(SYS, 'owner'),
      { kind: 'exception', branchId: ids.b1, scope: { type: 'branch' }, date: '2026-11-15', exceptionKind: 'short_day', open: '10:00', close: '18:00', reason: 'тест' },
      { clock, bookings: bookingsProvider, targets: calendarTargets },
    );
    expect(r.affectedBookingIds).toEqual([ids.booking]);
    const rows = await bookingsProvider.futureBookings(pool, { branchId: ids.b1!, from: new Date('2026-11-15T00:00:00Z'), to: null });
    expect(rows).toEqual([{ id: ids.booking, resourceId: ids.pc, roomId: null, start: new Date('2026-11-15T13:00:00Z'), end: new Date('2026-11-15T14:00:00Z') }]);
    expect(await calendarTargets.belongsToBranch(pool, { type: 'resource', id: ids.pc! }, ids.b1!)).toBe(true);
    expect(await calendarTargets.belongsToBranch(pool, { type: 'room', id: ids.pc! }, ids.b1!)).toBe(false);
  });
});

describe('clients: связь клиента с филиалом по броням (поиск CRM)', () => {
  it('Администратор филиала находит клиента с бронью в филиале по фамилии; без связи – только по точному телефону', async () => {
    const admin = ctxOf(ids.staff!, 'admin', [ids.b1!]);
    const linked = await searchClients(pool, admin, { text: 'Соколова' }, {}, clientBranchLinks);
    expect(linked.items.map((c) => c.id)).toEqual([ids.client]);
    const other = ctxOf(ids.staff!, 'admin', [randomUUID()]);
    expect((await searchClients(pool, other, { text: 'Соколова' }, {}, clientBranchLinks)).items).toEqual([]);
  });
});

describe('resources и booking: будущие брони и удержания по таблицам', () => {
  const meta: AuditRequestMeta = { actor: { kind: 'system', process: 'test' }, source: 'system', requestId: 't' };

  it('changeComposition видит бронь и удержание ресурса (id удержания, не позиции)', async () => {
    const u2 = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1b', 'PC1b') RETURNING id`, [ids.b1]);
    const e = await codeOf(changeComposition(pool, { resourceId: ids.pc!, unitIds: [u2.id], validFrom: new Date('2026-11-15T00:00:00Z') }, meta, clock, bookingsProvider));
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).details).toEqual({ bookingIds: [ids.booking], holdIds: [ids.hold], blockIds: [] });
  });

  it('блокировка возвращает id удержания в affectedHoldIds', async () => {
    const reason = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`)).id;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await createBlock(c, ctxOf(SYS, 'owner'), { branchId: ids.b1!, target: { type: 'unit', ids: [ids.unit!] }, period: { start: new Date('2026-11-15T00:00:00Z'), end: new Date('2026-11-17T00:00:00Z') }, reasonId: reason }, meta, clock);
      expect(r).toMatchObject({ affectedBookingIds: [ids.booking], affectedHoldIds: [ids.hold] });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
