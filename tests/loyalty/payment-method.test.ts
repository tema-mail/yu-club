// S2-37: способ оплаты points (K10 §5, K15 §6–§7). Обработчик вызывается так, как его вызовет finance (S2-20):
// charge/refund в транзакции команды с сеансом оплаты. Регистрацию в реестре способов делает buildServer.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { paymentMethodHandler, type ChargeInput, type PaymentLine, type PaymentSession } from '../../apps/api/src/modules/finance/methods.ts';
import { createBatch, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { pointsPaymentMethod } from '../../apps/api/src/modules/loyalty/payment-method.ts';
import { convertReserves, reserveForHold } from '../../apps/api/src/modules/loyalty/reserve.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let now = new Date('2026-11-14T05:00:00Z');
const clock: Clock = { now: () => now };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let hour = 0;
const staff = { type: 'staff' as const, id: randomUUID() };
const DAY = 86_400_000;

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function inTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
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
async function clientWith(centi: number, expiresAt: Date | null = null): Promise<string> {
  const c = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).id;
  await inTx(async (tx) => {
    await openAccount(tx, c, now);
    const p = await postPoints(tx, c, { amount: centi, type: 'loyalty.accrual', branchId: null, occurredAt: now }, randomUUID(), SYSTEM_AUTHOR);
    await createBatch(tx, { clientId: c, entryId: p.entryId, amount: centi, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt, accruedAt: now });
  });
  return c;
}
/** Бронь клиента; withReserve – через резерв удержания и его перевод на бронь (как сайт + обработчик booking.confirmed). */
async function booking(clientId: string, resourceId: string, minutes: number, withReserve = false): Promise<string> {
  const start = new Date(Date.parse('2026-11-16T04:00:00Z') + hour++ * 3_600_000);
  const h = await runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId, start, end: new Date(start.getTime() + minutes * 60_000) }] }, clock));
  if (withReserve) await inTx((tx) => reserveForHold(tx, { clientId, holdId: h.id }, { actor: { kind: 'client', clientId, sessionId: randomUUID() }, source: 'site', requestId: randomUUID() }, clock));
  const id = (await runOccupancyCommand(pool, (c) => confirmHold(c, clientId, h.id, clock))).bookings[0]!.id;
  if (withReserve) await inTx((tx) => convertReserves(tx, clientId, { bookings: paymentBookingProvider, clock }));
  return id;
}
function chargeInput(bookingId: string, clientId: string, minutes: number, resourceType = 'pc', key = `payment:${bookingId}:1:1`): ChargeInput {
  const session: PaymentSession = { id: bookingId, bookingId, branchId: ids.b1!, clientId, amountDueKop: 20000, bookingVersion: 1, status: 'unpaid', activePaymentId: null, rowVersion: 1 };
  return { session, lineNo: 1, amountKop: 20000, minutes, resourceType, idempotencyKey: key, author: staff, occurredAt: now, mode: 'exact' };
}
const charge = (i: ChargeInput) => inTx((tx) => pointsPaymentMethod.charge(tx, i));
const bal = (c: string) => getBalance(pool, c, now);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:30', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  for (const [key, type] of [['pc1', 'pc'], ['pc2', 'pc'], ['room', 'room_whole']] as const) {
    if (key !== 'pc2') await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, 30, 100, '2026-01-01', 'active', $3)`, [ids.b1, type, SYS]);
    const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, $2, $2) RETURNING id`, [ids.b1, key]);
    ids[key] = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, $2, $3) RETURNING id`, [ids.b1, type, key])).id;
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids[key], u.id]);
  }
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

it('buildServer регистрирует обработчик points в реестре способов', async () => {
  await buildServer(loadConfig({ LOG_LEVEL: 'silent' })).close();
  expect(paymentMethodHandler('points')).toBe(pointsPaymentMethod);
});

describe('charge', () => {
  it('минуты × 100, FEFO, баланс не ниже 0; повтор с ключом – та же проводка', async () => {
    const c = await clientWith(10_000);
    const b = await booking(c, ids.pc1!, 60);
    const r = await charge(chargeInput(b, c, 60));
    expect(r).toMatchObject({ pointsCenti: 6000, amountKop: 20000 });
    expect((await bal(c)).balanceCenti).toBe(4000);
    expect(await charge(chargeInput(b, c, 60))).toEqual(r);
    expect((await bal(c)).balanceCenti).toBe(4000);
  });

  it('POINTS_INSUFFICIENT с двумя числами; чужой резерв занимает баллы; доплаты нет', async () => {
    const c = await clientWith(9000);
    const reserved = await booking(c, ids.pc1!, 60, true); // резерв 6000 на другой брони
    const b = await booking(c, ids.pc2!, 60);
    await expect(charge(chargeInput(b, c, 60))).rejects.toMatchObject({ code: 'POINTS_INSUFFICIENT', details: { availableCenti: 3000, requiredCenti: 6000 } });
    // своя бронь с резервом: резерв не мешает, после оплаты – spent
    await charge(chargeInput(reserved, c, 60));
    expect(await bal(c)).toMatchObject({ balanceCenti: 3000, reservedCenti: 0, availableCenti: 3000 });
    expect((await one<{ status: string }>(`SELECT status FROM app.loyalty_reserves WHERE booking_id = $1`, [reserved])).status).toBe('spent');
  });

  it('POINTS_NOT_ALLOWED для комнаты целиком (Q-42)', async () => {
    const c = await clientWith(100_000);
    const b = await booking(c, ids.room!, 60);
    await expect(charge(chargeInput(b, c, 60, 'room_whole'))).rejects.toMatchObject({ code: 'POINTS_NOT_ALLOWED' });
  });
});

describe('refund – возврат в исходные партии (18 §6.3 п.9)', () => {
  it('целиком в партию; второй возврат той же строки – ALREADY_REVERSED', async () => {
    const c = await clientWith(10_000);
    const b = await booking(c, ids.pc1!, 30);
    const r = await charge(chargeInput(b, c, 30));
    const line: PaymentLine = { lineNo: 1, method: 'points', amountKop: 20000, pointsCenti: 3000, ledgerPostingId: r.postingId };
    const ref = await inTx((tx) => pointsPaymentMethod.refund(tx, { line, amountKop: 20000, idempotencyKey: `refund:p1:1:1`, author: staff, occurredAt: now, reason: 'ошибка способа' }));
    expect(ref.outcome).toBe('returned');
    expect((await bal(c)).balanceCenti).toBe(10_000);
    await expect(inTx((tx) => pointsPaymentMethod.refund(tx, { line, amountKop: 20000, idempotencyKey: `refund:p1:1:2`, author: staff, occurredAt: now, reason: 'ещё раз' }))).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('партия истекла к возврату → not_restored, баланс не растёт', async () => {
    const c = await clientWith(10_000, new Date(now.getTime() + DAY));
    const b = await booking(c, ids.pc1!, 30);
    const r = await charge(chargeInput(b, c, 30));
    now = new Date(now.getTime() + 2 * DAY);
    const line: PaymentLine = { lineNo: 1, method: 'points', amountKop: 20000, pointsCenti: 3000, ledgerPostingId: r.postingId };
    const ref = await inTx((tx) => pointsPaymentMethod.refund(tx, { line, amountKop: 20000, idempotencyKey: `refund:p2:1:1`, author: staff, occurredAt: now, reason: 'отмена' }));
    expect(ref).toEqual({ postingId: null, outcome: 'not_restored' });
    expect((await bal(c)).balanceCenti).toBe(0);
    now = new Date('2026-11-14T05:00:00Z');
  });
});
