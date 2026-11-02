// S2-31: начисление за посещение (K15 §4, TC-09). Настоящие команды брони (createHold → confirmHold → markArrived /
// revertVisit) и outbox. Платёж эмулируется: состояние – в подменном PaymentLookup (реализация finance – S2-20),
// событие payment.recorded / payment.refunded публикуется в outbox так же, как его опубликует finance.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { clearSubscriptions, processEvent, publish } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { markArrived, revertVisit } from '../../apps/api/src/modules/booking/visit.ts';
import type { PaymentMethod } from '../../apps/api/src/modules/finance/methods.ts';
import { debitBatches, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { ACCRUAL_HANDLERS, registerAccrualHandlers, type PaymentLookup } from '../../apps/api/src/modules/loyalty/accrual.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { createTestPayment } from '../helpers/payment.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let now = new Date('2026-11-15T07:00:00Z');
const clock: Clock = { now: () => now };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let owner: AccessContext;
let slot = 0;

// ---- платёж: состояние в подмене finance, событие – в outbox
const payments = new Map<string, { paymentId: string; bookingId: string; methods: PaymentMethod[]; status: 'active' | 'partially_refunded' | 'refunded' }>();
const lookup: PaymentLookup = {
  livePayment: async (_tx, bookingId) => {
    const p = [...payments.values()].find((x) => x.bookingId === bookingId && x.status !== 'refunded');
    return p ? { paymentId: p.paymentId, methods: p.methods } : null;
  },
  paymentStatus: async (_tx, paymentId) => payments.get(paymentId)?.status ?? null,
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
const meta = (): AuditRequestMeta => ({ actor: owner.actor, source: 'crm', requestId: randomUUID() });
const rowVersion = async (id: string) => Number((await one<{ row_version: number }>('SELECT row_version FROM app.bookings WHERE id = $1', [id])).row_version);

/** Бронь клиента на `minutes` минут; часы сдвигаются к её началу (приход разрешён). */
async function book(clientId: string, minutes: number): Promise<string> {
  const start = new Date(Date.parse('2026-11-16T04:00:00Z') + slot++ * 3_600_000);
  now = new Date(start.getTime() - 86_400_000);
  const h = await runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc!, start, end: new Date(start.getTime() + minutes * 60_000) }] }, clock));
  const id = (await runOccupancyCommand(pool, (c) => confirmHold(c, clientId, h.id, clock))).bookings[0]!.id;
  now = start;
  return id;
}
const arrive = async (id: string) => runOccupancyCommand(pool, async (c) => markArrived(c, id, { ctx: owner, rowVersion: await rowVersion(id) }, meta(), clock));
const revert = async (id: string) => runOccupancyCommand(pool, async (c) => revertVisit(c, id, { ctx: owner, rowVersion: await rowVersion(id), reason: 'ошибка' }, meta(), clock));
async function pay(bookingId: string, clientId: string, methods: PaymentMethod[]): Promise<string> {
  const paymentId = await createTestPayment(db.client, bookingId);
  payments.set(paymentId, { paymentId, bookingId, methods, status: 'active' });
  await inTx((tx) =>
    publish(tx, {
      type: 'payment.recorded', aggregateType: 'payment', aggregateId: paymentId, aggregateVersion: paymentId, branchId: ids.b1!, occurredAt: now,
      payload: { paymentId, sessionId: bookingId, bookingId, branchId: ids.b1!, clientId, attempt: 1, methods, totalKop: 100, pointsCenti: null, certificateId: null },
    }),
  );
  return paymentId;
}
async function refundAll(paymentId: string): Promise<void> {
  const p = payments.get(paymentId)!;
  p.status = 'refunded';
  const refundId = randomUUID();
  await inTx((tx) =>
    publish(tx, {
      type: 'payment.refunded', aggregateType: 'payment', aggregateId: paymentId, aggregateVersion: refundId, branchId: ids.b1!, occurredAt: now,
      payload: { refundId, paymentId, bookingId: p.bookingId, clientId: '', lines: [], reason: 'ошибка способа', sessionStatus: 'refunded' },
    }),
  );
}
/** Все события типа по агрегату/брони – id в порядке записи. */
async function events(type: string, bookingId: string): Promise<string[]> {
  return (await db.client.query<{ id: string }>(`SELECT id FROM app.outbox_events WHERE event_type = $1 AND payload ->> 'bookingId' = $2 ORDER BY occurred_at, xmin::text::bigint`, [type, bookingId])).rows.map((r) => r.id);
}
const deliver = (handler: string, eventId: string) => processEvent(pool, handler, eventId, now);
/** Повторная доставка мимо processed_events (как будто очередь отдала задачу ещё раз после сбоя записи отметки). */
async function redeliver(handler: string, eventId: string): Promise<void> {
  await db.client.query('DELETE FROM app.processed_events WHERE handler = $1 AND event_id = $2', [handler, eventId]);
  await deliver(handler, eventId);
}
const accruals = (bookingId: string) => db.client.query('SELECT status, amount_centi, payment_id FROM app.loyalty_accruals WHERE booking_id = $1 ORDER BY created_at', [bookingId]).then((r) => r.rows);
const balance = async (clientId: string) => (await getBalance(pool, clientId, now)).balanceCenti;
const newClient = async () => (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).id;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  await db.client.query(`UPDATE app.dict_resource_types SET step_minutes = 5 WHERE code = 'pc'`); // брони по 15 и 20 минут
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:55', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 5, 100, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, u.id]);
  ids.owner = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', 'o@yu.test', 'owner', 'x') RETURNING id`)).id;
  owner = { actor: { kind: 'staff', staffId: ids.owner, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: now };
  clearSubscriptions();
  registerAccrualHandlers({ bookings: paymentBookingProvider, payments: lookup, clock });
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});
beforeEach(() => payments.clear());

describe('TC-09: одно начисление на бронь при любом порядке и повторной доставке', () => {
  for (const order of ['visit-first', 'payment-first'] as const) {
    it(`${order}: оба события дважды → одно начисление 20 мин = 3,0 балла`, async () => {
      const c = await newClient();
      const b = await book(c, 20);
      let payEvent: string | undefined;
      if (order === 'payment-first') {
        // оплата до прихода невозможна в K10, но событие может прийти раньше visit.confirmed – эмулируем доставку не по порядку
        await arrive(b);
        await pay(b, c, ['cash']);
        payEvent = (await events('payment.recorded', b))[0]!;
        await deliver(ACCRUAL_HANDLERS.paymentRecorded, payEvent);
        await redeliver(ACCRUAL_HANDLERS.paymentRecorded, payEvent);
        const visitEvent = (await events('visit.confirmed', b))[0]!;
        await deliver(ACCRUAL_HANDLERS.visitConfirmed, visitEvent);
        await redeliver(ACCRUAL_HANDLERS.visitConfirmed, visitEvent);
      } else {
        await arrive(b);
        const visitEvent = (await events('visit.confirmed', b))[0]!;
        await deliver(ACCRUAL_HANDLERS.visitConfirmed, visitEvent); // платежа ещё нет – ничего
        expect(await accruals(b)).toEqual([]);
        await pay(b, c, ['card']);
        payEvent = (await events('payment.recorded', b))[0]!;
        await deliver(ACCRUAL_HANDLERS.paymentRecorded, payEvent);
        await redeliver(ACCRUAL_HANDLERS.paymentRecorded, payEvent);
        await redeliver(ACCRUAL_HANDLERS.visitConfirmed, visitEvent);
      }
      expect(await accruals(b)).toMatchObject([{ status: 'active', amount_centi: '300' }]);
      expect(await balance(c)).toBe(300);
    });
  }

  it('без посещения начисления нет; 15 мин → 2,5; сертификат – начисляется (Q-40)', async () => {
    const c = await newClient();
    const b = await book(c, 15);
    await pay(b, c, ['certificate']);
    await deliver(ACCRUAL_HANDLERS.paymentRecorded, (await events('payment.recorded', b))[0]!);
    expect(await accruals(b)).toEqual([]); // посещения нет
    await arrive(b);
    await deliver(ACCRUAL_HANDLERS.visitConfirmed, (await events('visit.confirmed', b))[0]!);
    expect(await accruals(b)).toMatchObject([{ amount_centi: '250' }]);
  });

  it('оплата баллами – начисления нет (Q-40)', async () => {
    const c = await newClient();
    const b = await book(c, 60);
    await arrive(b);
    await pay(b, c, ['points']);
    await deliver(ACCRUAL_HANDLERS.paymentRecorded, (await events('payment.recorded', b))[0]!);
    await deliver(ACCRUAL_HANDLERS.visitConfirmed, (await events('visit.confirmed', b))[0]!);
    expect(await accruals(b)).toEqual([]);
  });
});

describe('сторно начисления', () => {
  it('visit.reverted → сторно, партия уменьшается; повторный приход с тем же платежом – новое начисление', async () => {
    const c = await newClient();
    const b = await book(c, 60);
    await arrive(b);
    await pay(b, c, ['cash']);
    await deliver(ACCRUAL_HANDLERS.paymentRecorded, (await events('payment.recorded', b))[0]!);
    expect(await balance(c)).toBe(1000);
    await revert(b);
    await deliver(ACCRUAL_HANDLERS.visitReverted, (await events('visit.reverted', b))[0]!);
    expect(await accruals(b)).toMatchObject([{ status: 'reversed' }]);
    expect(await balance(c)).toBe(0);
    await arrive(b); // отметили приход заново – платёж уже есть
    await deliver(ACCRUAL_HANDLERS.visitConfirmed, (await events('visit.confirmed', b))[1]!);
    expect((await accruals(b)).map((a) => a.status)).toEqual(['reversed', 'active']);
    expect(await balance(c)).toBe(1000);
  });

  it('сторно ниже −50 → loyalty_issues, предел не обходится', async () => {
    const c = await newClient();
    const b = await book(c, 60);
    await arrive(b);
    await pay(b, c, ['cash']);
    await deliver(ACCRUAL_HANDLERS.paymentRecorded, (await events('payment.recorded', b))[0]!);
    // штрафы довели баланс до −45 (+10 начислено → −45): 1000 − 5500 = −4500
    await inTx(async (tx) => {
      await openAccount(tx, c, now);
      for (let i = 0; i < 11; i++) {
        const p = await postPoints(tx, c, { amount: -500, type: 'loyalty.penalty', branchId: null, occurredAt: now }, randomUUID(), SYSTEM_AUTHOR);
        await debitBatches(tx, { clientId: c, entryId: p.entryId, amount: 500, balanceBefore: p.balanceBefore, kind: 'penalty' });
      }
    });
    expect(await balance(c)).toBe(-4500);
    await revert(b);
    const ev = (await events('visit.reverted', b))[0]!;
    await deliver(ACCRUAL_HANDLERS.visitReverted, ev);
    await redeliver(ACCRUAL_HANDLERS.visitReverted, ev);
    expect(await accruals(b)).toMatchObject([{ status: 'active' }]);
    expect(await balance(c)).toBe(-4500);
    const issues = (await db.client.query(`SELECT kind, ref_type, amount_centi, status FROM app.loyalty_issues WHERE client_id = $1`, [c])).rows;
    expect(issues).toEqual([{ kind: 'accrual_reversal_below_limit', ref_type: 'visit', amount_centi: '1000', status: 'open' }]);
  });

  it('полный возврат → сторно; повторная оплата баллами – без начисления, деньгами – одно новое', async () => {
    const c = await newClient();
    const b = await book(c, 30);
    await arrive(b);
    const p1 = await pay(b, c, ['cash']);
    await deliver(ACCRUAL_HANDLERS.paymentRecorded, (await events('payment.recorded', b))[0]!);
    await refundAll(p1);
    await deliver(ACCRUAL_HANDLERS.paymentRefunded, (await db.client.query(`SELECT id FROM app.outbox_events WHERE event_type = 'payment.refunded' AND aggregate_id = $1`, [p1])).rows[0].id);
    expect(await balance(c)).toBe(0);
    const p2 = await pay(b, c, ['points']);
    await deliver(ACCRUAL_HANDLERS.paymentRecorded, (await events('payment.recorded', b))[1]!);
    expect((await accruals(b)).map((a) => a.status)).toEqual(['reversed']);
    await refundAll(p2);
    await pay(b, c, ['transfer']);
    await deliver(ACCRUAL_HANDLERS.paymentRecorded, (await events('payment.recorded', b))[2]!);
    expect((await accruals(b)).map((a) => a.status)).toEqual(['reversed', 'active']);
    expect(await balance(c)).toBe(500);
  });

  it('payment.refunded раньше payment.recorded → итог как при прямом порядке (нет начисления)', async () => {
    const c = await newClient();
    const b = await book(c, 30);
    await arrive(b);
    const p = await pay(b, c, ['cash']);
    await refundAll(p);
    await deliver(ACCRUAL_HANDLERS.paymentRefunded, (await db.client.query(`SELECT id FROM app.outbox_events WHERE event_type = 'payment.refunded' AND aggregate_id = $1`, [p])).rows[0].id);
    await deliver(ACCRUAL_HANDLERS.paymentRecorded, (await events('payment.recorded', b))[0]!);
    await deliver(ACCRUAL_HANDLERS.visitConfirmed, (await events('visit.confirmed', b))[0]!);
    expect(await accruals(b)).toEqual([]);
    expect(await balance(c)).toBe(0);
  });
});
