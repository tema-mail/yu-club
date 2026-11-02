// S2-36: резерв баллов на удержание и бронь (K15 §3, TC-05/06). Настоящие команды удержания и брони, outbox.
// Резерв без своего срока: живёт по статусу, сроку и подписи удержания; изменение позиций снимает его без события.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { clearSubscriptions, processEvent, publish } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { cancelBooking } from '../../apps/api/src/modules/booking/change.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { addHoldItem, createHold, releaseHold, removeHoldItem, type HoldDto } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { markNoShow } from '../../apps/api/src/modules/booking/visit.ts';
import type { PaymentMethod } from '../../apps/api/src/modules/finance/methods.ts';
import { createBatch, debitBatches, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import type { PaymentLookup } from '../../apps/api/src/modules/loyalty/accrual.ts';
import { registerReserveHandlers, reserveForHold, RESERVE_HANDLERS, settleStaleReserves } from '../../apps/api/src/modules/loyalty/reserve.ts';
import { lockAccounts } from '../../apps/api/src/core/ledger.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let now = new Date('2026-11-14T05:00:00Z');
const clock: Clock = { now: () => now };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let owner: AccessContext;
let hour = 0;
const live = new Map<string, PaymentMethod[]>();
const lookup: PaymentLookup = {
  livePayment: async (_tx, bookingId) => (live.has(bookingId) ? { paymentId: randomUUID(), methods: live.get(bookingId)! } : null),
  paymentStatus: async () => null,
};

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
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (err: { code?: string }) => err.code ?? String(err));
const clientMeta = (clientId: string): AuditRequestMeta => ({ actor: { kind: 'client', clientId, sessionId: randomUUID() }, source: 'site', requestId: randomUUID() });
const staffMeta = (): AuditRequestMeta => ({ actor: owner.actor, source: 'crm', requestId: randomUUID() });
/** Клиент с `centi` баллов на счёте (начисление K3 + партия). */
async function clientWith(centi: number): Promise<string> {
  const c = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).id;
  await inTx(async (tx) => {
    await openAccount(tx, c, now);
    const p = await postPoints(tx, c, { amount: centi, type: 'loyalty.accrual', branchId: null, occurredAt: now }, randomUUID(), SYSTEM_AUTHOR);
    await createBatch(tx, { clientId: c, entryId: p.entryId, amount: centi, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt: null, accruedAt: now });
  });
  return c;
}
const slot = (resourceId: string, minutes = 60) => {
  const start = new Date(Date.parse('2026-11-16T04:00:00Z') + hour++ * 3_600_000);
  return { resourceId, start, end: new Date(start.getTime() + minutes * 60_000) };
};
const hold = (clientId: string, items: ReturnType<typeof slot>[], branchId = ids.b1!) => runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId, items }, clock));
const reserve = (clientId: string, holdId: string) => inTx((tx) => reserveForHold(tx, { clientId, holdId }, clientMeta(clientId), clock));
const bal = (clientId: string) => getBalance(pool, clientId, now);
const reserves = (clientId: string) => db.client.query(`SELECT status, release_reason, amount_centi FROM app.loyalty_reserves WHERE client_id = $1 ORDER BY created_at, status`, [clientId]).then((r) => r.rows);
const eventOf = async (type: string, key: string, value: string) =>
  (await db.client.query<{ id: string }>(`SELECT id FROM app.outbox_events WHERE event_type = $1 AND payload ->> $2 = $3 ORDER BY occurred_at, xmin::text::bigint DESC LIMIT 1`, [type, key, value])).rows[0]!.id;
const deliver = (handler: string, eventId: string) => processEvent(pool, handler, eventId, now);
async function confirmed(clientId: string, h: HoldDto): Promise<string> {
  const id = (await runOccupancyCommand(pool, (c) => confirmHold(c, clientId, h.id, clock))).bookings[0]!.id;
  await deliver(RESERVE_HANDLERS.bookingConfirmed, await eventOf('booking.confirmed', 'bookingId', id));
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const b of ['b1', 'b2']) {
    ids[b] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, b])).id;
    await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:30', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids[b], SYS]);
    for (const t of ['pc', 'room_whole']) {
      await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, 30, 100, '2026-01-01', 'active', $3)`, [ids[b], t, SYS]);
    }
    for (const [key, type] of [[`${b}pc1`, 'pc'], [`${b}pc2`, 'pc'], [`${b}room`, 'room_whole']] as const) {
      const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, $2, $2) RETURNING id`, [ids[b], key]);
      ids[key] = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, $2, $3) RETURNING id`, [ids[b], type, key])).id;
      await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids[key], u.id]);
    }
  }
  ids.owner = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', 'o@yu.test', 'owner', 'x') RETURNING id`)).id;
  owner = { actor: { kind: 'staff', staffId: ids.owner, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: now };
  clearSubscriptions();
  registerReserveHandlers({ bookings: paymentBookingProvider, payments: lookup, clock });
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('резерв на удержание (07 §6.2)', () => {
  it('минуты × 100; доступно уменьшилось; правила: не своё, тип ресурса, не хватает', async () => {
    const c = await clientWith(10_000);
    const h = await hold(c, [slot(ids.b1pc1!, 60)]);
    expect(await reserve(c, h.id)).toMatchObject({ amountCenti: 6000, availableCenti: 4000 });
    expect(await bal(c)).toMatchObject({ balanceCenti: 10_000, reservedCenti: 6000, availableCenti: 4000 });
    const other = await clientWith(10_000);
    expect(await codeOf(reserve(other, h.id))).toBe('RESERVE_HOLD_INVALID');
    const room = await hold(other, [slot(ids.b1room!, 60)]);
    expect(await codeOf(reserve(other, room.id))).toBe('POINTS_NOT_ALLOWED');
    const poor = await clientWith(500);
    const h2 = await hold(poor, [slot(ids.b1pc2!, 60)]);
    await expect(reserve(poor, h2.id)).rejects.toMatchObject({ code: 'POINTS_INSUFFICIENT', details: { availableCenti: 500, requiredCenti: 6000 } });
  });

  it('повтор на то же удержание – старый replaced, активный один', async () => {
    const c = await clientWith(10_000);
    const h = await hold(c, [slot(ids.b1pc1!, 30)]);
    await reserve(c, h.id);
    await reserve(c, h.id);
    expect((await reserves(c)).map((r) => `${r.status}:${r.release_reason ?? ''}`).sort()).toEqual(['hold:', 'released:replaced']);
    expect((await bal(c)).reservedCenti).toBe(3000);
  });

  it('TC-06: перезапуск таймера удержания продлевает резерв; истечение снимает без события', async () => {
    const c = await clientWith(10_000);
    const h = await hold(c, [slot(ids.b1pc1!, 60)]);
    await reserve(c, h.id);
    const exp = new Date(h.expiresAt);
    await db.client.query(`UPDATE app.holds SET expires_at = $2 WHERE id = $1`, [h.id, new Date(exp.getTime() + 10 * 60_000)]); // как перезапуск общего таймера
    now = new Date(exp.getTime() + 60_000);
    expect((await bal(c)).reservedCenti).toBe(6000);
    now = new Date(exp.getTime() + 11 * 60_000);
    expect(await bal(c)).toMatchObject({ reservedCenti: 0, availableCenti: 10_000 });
    await inTx(async (tx) => {
      await openAccount(tx, c, now);
      await settleStaleReserves(tx, c, now);
    });
    expect((await reserves(c))[0]).toMatchObject({ status: 'released', release_reason: 'hold_expired' });
    now = new Date('2026-11-14T05:00:00Z');
  });

  it('изменение удержания (добавление, удаление позиции, отказ) – резерв сразу не занят, статус – при следующем обращении', async () => {
    const c = await clientWith(20_000);
    const owner0 = { clientId: c, visitorId: null };
    const h = await hold(c, [slot(ids.b1pc1!, 60)]);
    await reserve(c, h.id);
    const added = await runOccupancyCommand(pool, (tx) => addHoldItem(tx, owner0, h.id, slot(ids.b1pc2!, 30), clock));
    expect((await bal(c)).reservedCenti).toBe(0);
    await reserve(c, h.id); // выбрал баллы заново – на 90 минут
    expect((await reserves(c)).map((r) => `${r.status}:${r.release_reason ?? ''}`).sort()).toEqual(['hold:', 'released:hold_changed']);
    expect((await bal(c)).reservedCenti).toBe(9000);
    await runOccupancyCommand(pool, (tx) => removeHoldItem(tx, owner0, h.id, added.items.at(-1)!.id, clock));
    expect((await bal(c)).reservedCenti).toBe(0);
    await reserve(c, h.id);
    await runOccupancyCommand(pool, (tx) => releaseHold(tx, owner0, h.id, clock));
    expect((await bal(c)).reservedCenti).toBe(0);
    await inTx(async (tx) => settleStaleReserves(tx, c, now));
    expect((await reserves(c)).map((r) => r.release_reason).sort()).toEqual(['hold_changed', 'hold_changed', 'hold_released']);
  });

  it('два параллельных резерва одного клиента на разные удержания при балансе на один → один POINTS_INSUFFICIENT', async () => {
    const c = await clientWith(6000);
    const h1 = await hold(c, [slot(ids.b1pc1!, 60)], ids.b1);
    const h2 = await hold(c, [slot(ids.b2pc1!, 60)], ids.b2);
    const results = await Promise.all([codeOf(reserve(c, h1.id)), codeOf(reserve(c, h2.id))]);
    expect(results.sort()).toEqual(['POINTS_INSUFFICIENT', 'ok']);
    expect((await bal(c)).reservedCenti).toBe(6000);
  });
});

describe('резерв брони', () => {
  it('подтверждение: резерв удержания занят до события, после – converted и резерв на каждую бронь', async () => {
    const c = await clientWith(20_000);
    const h = await hold(c, [slot(ids.b1pc1!, 60), slot(ids.b1pc2!, 30)]);
    await reserve(c, h.id);
    const r = await runOccupancyCommand(pool, (tx) => confirmHold(tx, c, h.id, clock));
    expect((await bal(c)).reservedCenti).toBe(9000); // событие ещё не обработано
    await deliver(RESERVE_HANDLERS.bookingConfirmed, await eventOf('booking.confirmed', 'bookingId', r.bookings[0]!.id));
    await deliver(RESERVE_HANDLERS.bookingConfirmed, await eventOf('booking.confirmed', 'bookingId', r.bookings[1]!.id));
    expect((await reserves(c)).map((x) => `${x.status}:${x.amount_centi}`).sort()).toEqual(['booking:3000', 'booking:6000', 'converted:9000']);
    expect((await bal(c)).reservedCenti).toBe(9000);
  });

  it('отмена брони → booking_cancelled; неявка → no_show без списания; оплата наличными → paid_other', async () => {
    const c = await clientWith(30_000);
    const ids3: string[] = [];
    for (const res of [ids.b1pc1!, ids.b1pc2!, ids.b1pc1!]) {
      const h = await hold(c, [slot(res, 30)]);
      await reserve(c, h.id);
      ids3.push(await confirmed(c, h));
    }
    expect((await bal(c)).reservedCenti).toBe(9000);
    const [toCancel, toNoShow, toPay] = ids3 as [string, string, string];
    const reasonId = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' AND code = 'equipment_failure'`)).id;
    const rv = async (id: string) => Number((await one<{ row_version: number }>('SELECT row_version FROM app.bookings WHERE id = $1', [id])).row_version);
    await runOccupancyCommand(pool, async (tx) => cancelBooking(tx, toCancel, { kind: 'staff', ctx: owner, rowVersion: await rv(toCancel), initiator: 'club', reasonId, comment: 'сломался' }, staffMeta(), clock));
    await deliver(RESERVE_HANDLERS.bookingCancelled, await eventOf('booking.cancelled', 'bookingId', toCancel));
    now = new Date(Date.parse('2026-11-17T00:00:00Z'));
    await runOccupancyCommand(pool, async (tx) => markNoShow(tx, toNoShow, { ctx: owner, rowVersion: await rv(toNoShow) }, staffMeta(), clock));
    await deliver(RESERVE_HANDLERS.noShowMarked, await eventOf('no_show.marked', 'bookingId', toNoShow));
    live.set(toPay, ['cash']);
    const pid = randomUUID();
    await inTx((tx) =>
      publish(tx, {
        type: 'payment.recorded', aggregateType: 'payment', aggregateId: pid, aggregateVersion: pid, branchId: ids.b1!, occurredAt: now,
        payload: { paymentId: pid, sessionId: toPay, bookingId: toPay, branchId: ids.b1!, clientId: c, attempt: 1, methods: ['cash'], totalKop: 100, pointsCenti: null, certificateId: null },
      }),
    );
    await deliver(RESERVE_HANDLERS.paymentRecorded, await eventOf('payment.recorded', 'bookingId', toPay));
    const reasons = (await reserves(c)).filter((x) => x.status === 'released').map((x) => x.release_reason).sort();
    expect(reasons).toEqual(['booking_cancelled', 'no_show', 'paid_other']);
    expect(await bal(c)).toMatchObject({ balanceCenti: 30_000, reservedCenti: 0, availableCenti: 30_000 });
    now = new Date('2026-11-14T05:00:00Z');
  });
});

describe('ревизия 02.11: резерв, снятый изменением удержания, не оживает при подтверждении', () => {
  it('зарезервировал 60 мин → добавил слот → подтвердил: резерва нет, баллы доступны', async () => {
    const c = await clientWith(20_000);
    const h = await hold(c, [slot(ids.b1pc1!, 60)]);
    await reserve(c, h.id);
    await runOccupancyCommand(pool, (tx) => addHoldItem(tx, { clientId: c, visitorId: null }, h.id, slot(ids.b1pc2!, 30), clock));
    const r = await runOccupancyCommand(pool, (tx) => confirmHold(tx, c, h.id, clock));
    expect(await bal(c)).toMatchObject({ reservedCenti: 0, availableCenti: 20_000 }); // событие ещё не обработано
    for (const b of r.bookings) await deliver(RESERVE_HANDLERS.bookingConfirmed, await eventOf('booking.confirmed', 'bookingId', b.id));
    expect((await reserves(c)).map((x) => `${x.status}:${x.release_reason ?? ''}`)).toEqual(['released:hold_changed']);
    expect(await bal(c)).toMatchObject({ balanceCenti: 20_000, reservedCenti: 0, availableCenti: 20_000 });
  });

  it('подтверждение при балансе меньше резерва: резервы брони не превышают баланс', async () => {
    const c = await clientWith(6000);
    const h = await hold(c, [slot(ids.b1pc1!, 60)]);
    await reserve(c, h.id);
    await inTx(async (tx) => {
      await openAccount(tx, c, now);
      const p = await postPoints(tx, c, { amount: -3000, type: 'loyalty.manual', basis: 'тест', branchId: null, occurredAt: now }, randomUUID(), SYSTEM_AUTHOR);
      await debitBatches(tx, { clientId: c, entryId: p.entryId, amount: 3000, balanceBefore: p.balanceBefore, kind: 'manual' });
    });
    await confirmed(c, h);
    const b = await bal(c);
    expect(b.reservedCenti).toBeLessThanOrEqual(b.balanceCenti);
    expect((await reserves(c)).filter((x) => x.status === 'booking')).toEqual([]);
  });
});

/** Единый порядок K17 «Решения 02.11»: команда под счётом баллов берёт бронь FOR UPDATE, пока обработчик ждёт блокировку.
 *  Обработчик в порядке «бронь FOR SHARE → счёт» даёт 40P01. */
async function underAccountThenBooking(clientId: string, bookingId: string, handler: () => Promise<unknown>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const acc = await one(`SELECT id FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_id = $1`, [clientId]);
    await lockAccounts(c, [acc.id]);
    const run = handler();
    for (let i = 0; i < 200; i++) {
      if ((await one<{ n: number }>(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await c.query('SELECT 1 FROM app.bookings WHERE id = $1 FOR UPDATE', [bookingId]);
    await c.query('COMMIT');
    await run;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

describe('ревизия 02.11: порядок блокировок – счёт до брони', () => {
  it('обработчик отмены брони параллельно с командой «счёт → бронь» – без дедлока, резерв снят', async () => {
    const c = await clientWith(10_000);
    const h = await hold(c, [slot(ids.b1pc1!, 60)]);
    await reserve(c, h.id);
    const b = await confirmed(c, h);
    const reasonId = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' AND code = 'equipment_failure'`)).id;
    const rv = Number((await one<{ row_version: number }>('SELECT row_version FROM app.bookings WHERE id = $1', [b])).row_version);
    await runOccupancyCommand(pool, (tx) => cancelBooking(tx, b, { kind: 'staff', ctx: owner, rowVersion: rv, initiator: 'club', reasonId, comment: 'сломался' }, staffMeta(), clock));
    const ev = await eventOf('booking.cancelled', 'bookingId', b);
    await underAccountThenBooking(c, b, () => deliver(RESERVE_HANDLERS.bookingCancelled, ev));
    expect((await reserves(c)).filter((x) => x.status === 'released').map((x) => x.release_reason)).toEqual(['booking_cancelled']);
  });
});

describe('ревизия 02.11: границы ADR 0002', () => {
  it('loyalty не читает таблицы удержаний и ресурсов booking – только его представления (0208)', () => {
    const dir = new URL('../../apps/api/src/modules/loyalty/', import.meta.url);
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/app\.(holds|hold_items|resources)\b/g)].map((m) => `${f}: ${m[0]}`));
    expect(hits).toEqual([]);
  });
});
