// S2-22a: «к оплате» (K10 §4 listUnpaid, №22): брони arrived | completed без живого платежа за сутки по зоне филиала,
// после полного возврата – снова к оплате; курсор (start, number); чужой филиал – 404.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { listUnpaid } from '../../apps/api/src/modules/finance/payment.ts';
import { createTestPayment } from '../helpers/payment.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
const deps = { bookings: paymentBookingProvider };
const owner: AccessContext = { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: new Date() };

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function booking(startIso: string, status = 'arrived'): Promise<string> {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + 3_600_000);
  const b = await one(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange($4, $5, '[)'), 20000, 'crm', 'staff', $6) RETURNING id`,
    [ids.b1, ids.client, ids.pc, start, end, status],
  );
  await db.client.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     VALUES ($1, 1, $2, tstzrange($3, $4, '[)'), 'Asia/Novosibirsk', ARRAY[gen_random_uuid()], '{"name":"ПК-1"}', 20000, '{}', 'staff')`,
    [b.id, ids.pc, start, end],
  );
  return b.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 3 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000002', 'И', 'active', 'system', now()) RETURNING id`)).id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('к оплате', () => {
  it('сутки по зоне филиала; оплаченные и не пришедшие – нет; после полного возврата – снова к оплате; курсор', async () => {
    const a = await booking('2026-11-15T03:00:00Z'); // 10:00 15-го по Новосибирску
    const b = await booking('2026-11-15T05:00:00Z', 'completed');
    const paid = await booking('2026-11-15T07:00:00Z');
    await db.client.query(
      `INSERT INTO app.payment_sessions (booking_id, branch_id, client_id, amount_due_kop, booking_version, status) VALUES ($1, $2, $3, 20000, 1, 'paid')`,
      [paid, ids.b1, ids.client],
    );
    await db.client.query(`INSERT INTO app.payments (session_id, attempt, total_kop, topup_rule_snapshot, recorded_by, recorded_at) VALUES ($1, 1, 20000, false, $2, now())`, [paid, owner.actor.staffId]);
    const refunded = await booking('2026-11-15T09:00:00Z');
    await createTestPayment(db.client, refunded);
    await db.client.query(`UPDATE app.payment_sessions SET status = 'refunded' WHERE booking_id = $1`, [refunded]);
    await booking('2026-11-15T11:00:00Z', 'confirmed');
    const night = await booking('2026-11-15T17:30:00Z'); // 00:30 16-го там – другие сутки
    await booking('2026-11-14T16:30:00Z'); // 23:30 14-го там

    const page1 = await listUnpaid(pool, owner, { branchId: ids.b1!, date: '2026-11-15', limit: 2 }, deps);
    expect(page1.items.map((r) => r.bookingId)).toEqual([a, b]);
    expect(page1.items[0]).toMatchObject({ status: 'arrived', amountDueKop: 20_000, resourceName: 'ПК-1', paymentStatus: 'unpaid' });
    const page2 = await listUnpaid(pool, owner, { branchId: ids.b1!, date: '2026-11-15', limit: 2, cursor: page1.nextCursor! }, deps);
    expect(page2).toMatchObject({ items: [{ bookingId: refunded, paymentStatus: 'refunded' }], nextCursor: null });
    expect((await listUnpaid(pool, owner, { branchId: ids.b1!, date: '2026-11-16' }, deps)).items.map((r) => r.bookingId)).toEqual([night]);
  });

  it('Администратор чужого филиала – 404; своего – видит', async () => {
    const admin = (branchIds: string[]): AccessContext => ({ ...owner, role: 'admin', network: false, branchIds: new Set(branchIds) });
    await expect(listUnpaid(pool, admin([randomUUID()]), { branchId: ids.b1!, date: '2026-11-15' }, deps)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listUnpaid(pool, admin([ids.b1!]), { branchId: ids.b1!, date: '2026-11-15' }, deps)).items.length).toBeGreaterThan(0);
  });
});
