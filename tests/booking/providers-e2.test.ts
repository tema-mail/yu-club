// S2-05: провайдеры booking для Э2 – payableBooking (K10 §4), activeVisit, adjacentChain, holdBookings (K15 §3–5).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { paymentBookingProvider as p } from '../../apps/api/src/modules/booking/providers.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const clock: Clock = { now: () => new Date('2026-11-14T05:00:00Z') };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let bookings: string[] = [];

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
const span = (resourceId: string, iso: string, minutes: number) => ({ resourceId, start: new Date(iso), end: new Date(Date.parse(iso) + minutes * 60_000) });
const setStatus = (id: string, status: string) =>
  db.client.query(`UPDATE app.bookings SET status = $2, cancelled_at = CASE WHEN $2 LIKE 'cancelled%' THEN now() END, cancel_comment = CASE WHEN $2 LIKE 'cancelled%' THEN 'тест' END WHERE id = $1`, [id, status]);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(
    `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
    [ids.b1, SYS],
  );
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 100, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  for (const n of ['1', '2']) {
    const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, $2, $2) RETURNING id`, [ids.b1, `PC${n}`]);
    ids[`pc${n}`] = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', $2) RETURNING id`, [ids.b1, `ПК-${n}`])).id;
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids[`pc${n}`], u.id]);
  }
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000124', 'Ирина', 'active', 'system', now()) RETURNING id`)).id;
  ids.staff = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('А', 'А', 'a@yu.test', 'admin', 'x') RETURNING id`)).id;
  // 14:00–15:00 ПК-1, 15:00–16:00 ПК-2 (встык – одна цепочка), 17:00–18:00 ПК-1 (разрыв) по местному времени (UTC+7)
  const h = await runOccupancyCommand(pool, (c) =>
    createHold(c, { clientId: ids.client!, visitorId: null }, {
      branchId: ids.b1!,
      items: [span(ids.pc1!, '2026-11-15T07:00:00Z', 60), span(ids.pc2!, '2026-11-15T08:00:00Z', 60), span(ids.pc1!, '2026-11-15T10:00:00Z', 60)],
    }, clock),
  );
  ids.hold = h.id;
  const r = await runOccupancyCommand(pool, (c) => confirmHold(c, ids.client!, h.id, clock));
  bookings = [...r.bookings].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).map((b) => b.id);
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('payableBooking (K10 §4 п.1)', () => {
  it('confirmed и no_show – не к оплате; arrived и completed – к оплате; нет брони – null', async () => {
    const a = bookings[0]!;
    expect(await p.payableBooking(pool, a)).toMatchObject({ status: 'confirmed', payable: false, priceKop: 200, minutes: 60, resourceType: 'pc', clientId: ids.client, branchId: ids.b1, branchTimezone: 'Asia/Novosibirsk', version: 1 });
    for (const [status, payable] of [['arrived', true], ['completed', true], ['no_show', false], ['cancelled_by_club', false]] as const) {
      await setStatus(a, status);
      expect((await p.payableBooking(pool, a))?.payable, status).toBe(payable);
    }
    await setStatus(a, 'confirmed');
    expect(await p.payableBooking(pool, randomUUID())).toBeNull();
  });

  it('перенос – цена и минуты новой версии', async () => {
    const c = bookings[2]!;
    await db.client.query(
      `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, tariff_id, price_kop, price_snapshot, reason, created_by_type, created_by_id)
       SELECT booking_id, 2, $2, tstzrange('2026-11-15T11:00:00Z', '2026-11-15T11:30:00Z', '[)'), branch_timezone, unit_ids, resource_snapshot, tariff_id, 999, price_snapshot, 'перенос', 'staff', $3
       FROM journal.booking_versions WHERE booking_id = $1 AND version = 1`,
      [c, ids.pc2, ids.staff],
    );
    await db.client.query(`UPDATE app.bookings SET current_version = 2 WHERE id = $1`, [c]);
    expect(await p.payableBooking(pool, c)).toMatchObject({ version: 2, priceKop: 999, minutes: 30, resourceId: ids.pc2, start: new Date('2026-11-15T11:00:00Z') });
  });

  it('держит FOR SHARE: смена статуса брони ждёт конца транзакции оплаты', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await p.payableBooking(c1, bookings[0]!);
      await c2.query('BEGIN');
      await c2.query(`SET LOCAL lock_timeout = '200ms'`);
      await expect(c2.query(`UPDATE app.bookings SET row_version = row_version + 1 WHERE id = $1`, [bookings[0]])).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await c2.query('ROLLBACK');
      await c1.query('ROLLBACK');
      c1.release();
      c2.release();
    }
  });
});

describe('activeVisit, adjacentChain, holdBookings (K15)', () => {
  it('activeVisit – только активное посещение', async () => {
    const a = bookings[0]!;
    expect(await p.activeVisit(pool, a)).toBeNull();
    const v = await one(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, '2026-11-15T07:01:00Z', $4) RETURNING id`, [a, ids.b1, ids.client, ids.staff]);
    expect(await p.activeVisit(pool, a)).toEqual({ visitId: v.id, branchId: ids.b1, clientId: ids.client, arrivedAt: new Date('2026-11-15T07:01:00Z') });
    await db.client.query(`UPDATE app.visits SET status = 'reverted', reverted_at = now(), reverted_by = $2, revert_reason = 'ошибка' WHERE id = $1`, [v.id, ids.staff]);
    expect(await p.activeVisit(pool, a)).toBeNull();
  });

  it('цепочка 14:00–15:00 + 15:00–16:00 одна, с разрывом – отдельная; отмена разрывает', async () => {
    const [a, b] = bookings as [string, string, string];
    expect(await p.adjacentChain(pool, a)).toEqual([a, b]);
    expect(await p.adjacentChain(pool, b)).toEqual([a, b]);
    // третья бронь перенесена на 18:00–18:30 – отдельно от цепочки
    expect(await p.adjacentChain(pool, bookings[2]!)).toEqual([bookings[2]]);
    await setStatus(b, 'cancelled_by_club');
    expect(await p.adjacentChain(pool, a)).toEqual([a]);
    await setStatus(b, 'confirmed');
  });

  it('holdBookings – брони удержания с минутами текущей версии', async () => {
    const rows = await p.holdBookings(pool, ids.hold!);
    expect(rows.map((r) => r.bookingId)).toEqual(bookings);
    expect(rows.map((r) => r.minutes)).toEqual([60, 60, 30]);
    expect(rows.every((r) => r.resourceType === 'pc' && r.clientId === ids.client)).toBe(true);
    expect(await p.holdBookings(pool, randomUUID())).toEqual([]);
  });
});
