// S2-20: оплата сеанса (K10 §1–§6, TC-07, TC-08; 18 §6.3). Один живой платёж на бронь (индекс), правило одного
// способа и флаг R-03, приход – только после прихода клиента, деньги – в кассу (источник session), баллы и сертификат –
// без кассы; drain сверяется после обработчика; код сертификата – verifyCertificatePin до транзакции.
// Гонки на настоящем Postgres: 50 оплат одной брони; оплата против отмены; оплата баллами против резерва другой брони.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { markArrived } from '../../apps/api/src/modules/booking/visit.ts';
import { bookingLookup, paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { createCertificatePaymentMethod, verifyCertificatePin } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { clearPaymentMethods, registerPaymentMethod } from '../../apps/api/src/modules/finance/methods.ts';
import { getPayment, getPaymentStatus, paymentLookup, recordPayment, type PaymentDeps } from '../../apps/api/src/modules/finance/payment.ts';
import { createBatch, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { pointsPaymentMethod } from '../../apps/api/src/modules/loyalty/payment-method.ts';
import { convertReserves, reserveForHold } from '../../apps/api/src/modules/loyalty/reserve.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PEPPER = 'cert-pepper-'.padEnd(40, 'z');
const SYS = '00000000-0000-0000-0000-000000000001';
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let owner: AccessContext;
let slot = 0;

const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });
const bookings: PaymentDeps['bookings'] = { facts: (tx, id) => bookingLookup.facts(tx, id), payableBooking: (tx, id) => paymentBookingProvider.payableBooking(tx, id) };

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
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
async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

/** Бронь с версией напрямую (без занятости): статус, цена, минуты; клиент – общий или свой. */
async function booking(opts: { status?: string; priceKop?: number; minutes?: number; clientId?: string; resource?: string } = {}): Promise<string> {
  const start = new Date(Date.parse('2026-11-14T00:00:00Z') + slot++ * 3_600_000);
  const end = new Date(start.getTime() + (opts.minutes ?? 60) * 60_000);
  const resource = opts.resource ?? ids.pc!;
  const b = await one(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange($4, $5, '[)'), $6, 'crm', 'staff', $7) RETURNING id`,
    [ids.b1, opts.clientId ?? ids.client, resource, start, end, opts.priceKop ?? 30_000, opts.status ?? 'arrived'],
  );
  await db.client.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     VALUES ($1, 1, $2, tstzrange($3, $4, '[)'), 'Asia/Novosibirsk', ARRAY[gen_random_uuid()], '{"name":"ПК"}', $5, '{}', 'staff')`,
    [b.id, resource, start, end, opts.priceKop ?? 30_000],
  );
  return b.id;
}
const pay = (bookingId: string, lines: object[], extra: Partial<PaymentDeps> = {}, who: AccessContext = owner, body: object = {}) =>
  tx((t) => recordPayment(t, who, { bookingId, lines, ...body }, meta(who), { bookings, clock, ...extra }));
/** Как HTTP-слой: код сертификата – своей транзакцией до транзакции оплаты. */
async function payByCertificate(bookingId: string, cert: { number: string; pin: string }, lines: object[]) {
  const { certificateId } = await verifyCertificatePin(pool, cert, { pepper: PEPPER, clock });
  return pay(bookingId, lines, { verifiedCertificateId: certificateId });
}
/** Флаг R-03 на сети (владельцем базы: в тесте история значений не нужна). */
async function setTopup(on: boolean): Promise<void> {
  await db.client.query(`DELETE FROM app.settings_values WHERE key = 'payment.certificate_topup_enabled'`);
  await db.client.query(
    `INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('payment.certificate_topup_enabled', 'network', $1, '2026-01-01', $2)`,
    [JSON.stringify(on), SYS],
  );
}
const cash = async () => Number((await db.client.query(`SELECT coalesce(sum(balance), 0) AS s FROM app.ledger_accounts WHERE owner_id = $1`, [ids.b1])).rows[0].s);
async function clientWith(centi: number): Promise<string> {
  const c = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(1e6 + slot++).padStart(7, '0')}`])).id;
  await tx(async (t) => {
    await openAccount(t, c, clock.now());
    const p = await postPoints(t, c, { amount: centi, type: 'loyalty.accrual', branchId: null, occurredAt: clock.now() }, randomUUID(), SYSTEM_AUTHOR);
    await createBatch(t, { clientId: c, entryId: p.entryId, amount: centi, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt: null, accruedAt: clock.now() });
  });
  return c;
}
const sell = (nominalKop: number) => tx((t) => sellCertificate(t, owner, { branchId: ids.b1!, nominalKop, method: 'cash' }, meta(owner), { pepper: PEPPER, clock }));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 55 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:30', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 100, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, u.id]);
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000001', 'И', 'active', 'system', now()) RETURNING id`)).id;
  ids.owner = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', 'o@yu.test', 'owner', 'x') RETURNING id`)).id;
  owner = { actor: { kind: 'staff', staffId: ids.owner, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  clearPaymentMethods();
  registerPaymentMethod(pointsPaymentMethod);
  registerPaymentMethod(createCertificatePaymentMethod({ pepper: PEPPER }));
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('деньги', () => {
  it('наличные: приход в кассу (source session, ref payment), сеанс paid, аудит, событие payment.recorded', async () => {
    const b = await booking();
    const before = await cash();
    const r = await pay(b, [{ method: 'cash', amountKop: 30_000 }], {}, owner, { receiptIssued: true });
    expect(r.session).toMatchObject({ status: 'paid', activePaymentId: r.paymentId, amountDueKop: 30_000, rowVersion: 2 });
    expect(await cash()).toBe(before + 30_000);
    const p = (await getPayment(pool, r.paymentId))!;
    expect(p).toMatchObject({ attempt: 1, status: 'active', totalKop: 30_000, topupRuleSnapshot: false, lines: [{ lineNo: 1, method: 'cash', amountKop: 30_000 }] });
    const op = await db.client.query(`SELECT kind, place, source, ref_type, ref_id, receipt_issued FROM journal.finance_operations WHERE id = $1`, [p.lines[0]!.financeOperationId]);
    expect(op.rows).toEqual([{ kind: 'income', place: 'cash', source: 'session', ref_type: 'payment', ref_id: r.paymentId, receipt_issued: true }]);
    const k = await db.client.query(`SELECT idempotency_key FROM journal.ledger_entries WHERE posting_id = $1`, [p.lines[0]!.ledgerPostingId]);
    expect(k.rows[0].idempotency_key).toBe(`payment:${b}:1:1#0`);
    const ev = await db.client.query(`SELECT payload FROM app.outbox_events WHERE event_type = 'payment.recorded' AND aggregate_id = $1`, [r.paymentId]);
    expect(ev.rows[0].payload).toMatchObject({ bookingId: b, methods: ['cash'], totalKop: 30_000, attempt: 1, pointsCenti: null, certificateId: null });
    const a = await db.client.query(`SELECT action FROM journal.audit_events WHERE object_type = 'payment' AND object_id = $1`, [r.paymentId]);
    expect(a.rows).toEqual([{ action: 'payment.recorded' }]);
    expect(await getPaymentStatus(pool, [b, randomUUID()])).toEqual(new Map([[b, 'paid'], [expect.any(String), 'unpaid']]));
    expect(await tx((t) => paymentLookup.livePayment(t, b))).toEqual({ paymentId: r.paymentId, methods: ['cash'] });
  });

  it('карта и перевод – в безнал; повтор – ALREADY_PAID с paymentId', async () => {
    const b = await booking();
    const r = await pay(b, [{ method: 'card', amountKop: 30_000 }]);
    const op = await db.client.query(`SELECT place, method FROM journal.finance_operations WHERE ref_id = $1`, [r.paymentId]);
    expect(op.rows).toEqual([{ place: 'noncash', method: 'card' }]);
    expect((await fails(pay(b, [{ method: 'transfer', amountKop: 30_000 }]), 'ALREADY_PAID')).details).toEqual({ paymentId: r.paymentId });
  });

  it('BOOKING_NOT_PAYABLE: confirmed, no_show, отменённая; AMOUNT_MISMATCH; NOTHING_TO_PAY; none для 0 ₽ – без проводки', async () => {
    for (const status of ['confirmed', 'no_show']) await fails(pay(await booking({ status }), [{ method: 'cash', amountKop: 30_000 }]), 'BOOKING_NOT_PAYABLE');
    const c = await booking({ status: 'confirmed' });
    await db.client.query(`UPDATE app.bookings SET status = 'cancelled_by_club', cancelled_at = now(), cancel_comment = 'x' WHERE id = $1`, [c]);
    await fails(pay(c, [{ method: 'cash', amountKop: 30_000 }]), 'BOOKING_NOT_PAYABLE');
    const b = await booking();
    await fails(pay(b, [{ method: 'cash', amountKop: 29_999 }]), 'AMOUNT_MISMATCH');
    await fails(pay(b, [{ method: 'none', amountKop: 0 }]), 'NOTHING_TO_PAY');
    const free = await booking({ priceKop: 0 });
    await fails(pay(free, [{ method: 'cash', amountKop: 0 }]), 'NOTHING_TO_PAY');
    const before = await cash();
    const r = await pay(free, [{ method: 'none', amountKop: 0 }]);
    expect((await getPayment(pool, r.paymentId))!).toMatchObject({ totalKop: 0, lines: [] });
    expect(await cash()).toBe(before);
    expect(await tx((t) => paymentLookup.livePayment(t, free))).toEqual({ paymentId: r.paymentId, methods: ['none'] });
    await fails(pay(randomUUID(), [{ method: 'cash', amountKop: 1 }]), 'NOT_FOUND');
  });

  it('Администратор чужого филиала – 404; своего – проводит', async () => {
    const b = await booking();
    const admin = (branchIds: string[]): AccessContext => ({ actor: { kind: 'staff', staffId: ids.owner!, sessionId: randomUUID() }, role: 'admin', network: false, cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() });
    await fails(pay(b, [{ method: 'cash', amountKop: 30_000 }], {}, admin([randomUUID()])), 'NOT_FOUND');
    expect((await pay(b, [{ method: 'cash', amountKop: 30_000 }], {}, admin([ids.b1!]))).session.status).toBe('paid');
  });
});

describe('TC-07: один способ на сеанс и R-03', () => {
  const methods = ['cash', 'card', 'transfer', 'points', 'certificate'] as const;
  const line = (m: string, amountKop: number) => ({ method: m, amountKop, ...(m === 'certificate' ? { certificate: { number: 'X', pin: '0000' } } : {}) });

  it('флаг false: любая пара способов – PAYMENT_METHODS_COMBINED, денег не тронуто', async () => {
    const b = await booking();
    const before = await cash();
    for (const a of methods) {
      for (const c of methods) await fails(pay(b, [line(a, 10_000), line(c, 20_000)], { verifiedCertificateId: randomUUID() }), 'PAYMENT_METHODS_COMBINED');
    }
    expect(await cash()).toBe(before);
  });

  it('флаг true: только «сертификат, затем деньги»; баллы + деньги и деньги + сертификат – отказ; снимок флага в платеже', async () => {
    await setTopup(true);
    try {
      const b = await booking();
      await fails(pay(b, [line('points', 10_000), line('cash', 20_000)]), 'PAYMENT_METHODS_COMBINED');
      await fails(pay(b, [line('cash', 20_000), line('certificate', 10_000)], { verifiedCertificateId: randomUUID() }), 'PAYMENT_METHODS_COMBINED');
      await fails(pay(b, [line('certificate', 10_000), line('points', 20_000)], { verifiedCertificateId: randomUUID() }), 'PAYMENT_METHODS_COMBINED');
      const { certificate, pin } = await sell(10_000);
      const before = await cash();
      const r = await payByCertificate(b, { number: certificate.number, pin }, [{ method: 'certificate', amountKop: 10_000, certificate: { number: certificate.number, pin } }, { method: 'card', amountKop: 20_000 }]);
      const p = (await getPayment(pool, r.paymentId))!;
      expect(p).toMatchObject({ topupRuleSnapshot: true, lines: [{ lineNo: 1, method: 'certificate', amountKop: 10_000, certificateId: certificate.id }, { lineNo: 2, method: 'card', amountKop: 20_000 }] });
      expect(await cash()).toBe(before + 20_000); // погашение сертификата в кассу не пишется (TC-08)
    } finally {
      await setTopup(false);
    }
  });

  it('drain: остаток сертификата изменился между экраном и проводкой – AMOUNT_MISMATCH, всё откатилось', async () => {
    await setTopup(true);
    try {
      const b = await booking();
      const { certificate, pin } = await sell(12_000);
      const before = await cash();
      const cert = { number: certificate.number, pin };
      await fails(payByCertificate(b, cert, [{ method: 'certificate', amountKop: 10_000, certificate: cert }, { method: 'cash', amountKop: 20_000 }]), 'AMOUNT_MISMATCH');
      expect(await cash()).toBe(before);
      const red = await db.client.query(`SELECT count(*)::int AS n FROM app.certificate_redemptions WHERE certificate_id = $1`, [certificate.id]);
      expect(red.rows[0].n).toBe(0);
      expect((await getPaymentStatus(pool, [b])).get(b)).toBe('unpaid');
    } finally {
      await setTopup(false);
    }
  });
});

describe('баллы и сертификат', () => {
  it('баллы: минуты × 100 списаны, касса не изменилась, способ points в событии', async () => {
    const c = await clientWith(10_000);
    const b = await booking({ clientId: c, minutes: 60 });
    const before = await cash();
    const r = await pay(b, [{ method: 'points', amountKop: 30_000 }]);
    expect((await getPayment(pool, r.paymentId))!.lines).toMatchObject([{ method: 'points', amountKop: 30_000, pointsCenti: 6_000 }]);
    expect((await getBalance(pool, c, clock.now())).balanceCenti).toBe(4_000);
    expect(await cash()).toBe(before);
    const ev = await db.client.query(`SELECT payload FROM app.outbox_events WHERE aggregate_id = $1`, [r.paymentId]);
    expect(ev.rows[0].payload).toMatchObject({ methods: ['points'], pointsCenti: 6_000 });
  });

  it('сертификат строго (флаг false): остатка мало – CERTIFICATE_INSUFFICIENT; хватает – погашен, касса без прихода', async () => {
    const small = await sell(10_000);
    const b = await booking();
    const cs = { number: small.certificate.number, pin: small.pin };
    await fails(payByCertificate(b, cs, [{ method: 'certificate', amountKop: 30_000, certificate: cs }]), 'CERTIFICATE_INSUFFICIENT');
    const big = await sell(50_000);
    const cb = { number: big.certificate.number, pin: big.pin };
    const before = await cash();
    const r = await payByCertificate(b, cb, [{ method: 'certificate', amountKop: 30_000, certificate: cb }]);
    expect((await getPayment(pool, r.paymentId))!.lines).toMatchObject([{ method: 'certificate', certificateId: big.certificate.id, amountKop: 30_000 }]);
    expect(await cash()).toBe(before);
    const red = await db.client.query(`SELECT payment_id FROM app.certificate_redemptions WHERE certificate_id = $1`, [big.certificate.id]);
    expect(red.rows).toEqual([{ payment_id: r.paymentId }]);
  });

  it('6 неверных кодов через оплату → блок 15 минут; верный код после проверки – оплата проходит', async () => {
    const s = await sell(40_000);
    const b = await booking();
    const wrong = { number: s.certificate.number, pin: s.pin === '0000' ? '1111' : '0000' };
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) codes.push(await codeOf(payByCertificate(b, wrong, [{ method: 'certificate', amountKop: 30_000, certificate: wrong }])));
    expect(codes).toEqual(['CERTIFICATE_NOT_FOUND', 'CERTIFICATE_NOT_FOUND', 'CERTIFICATE_NOT_FOUND', 'CERTIFICATE_NOT_FOUND', 'CERTIFICATE_PIN_LOCKED', 'CERTIFICATE_PIN_LOCKED']);
    const right = { number: s.certificate.number, pin: s.pin };
    await fails(payByCertificate(b, right, [{ method: 'certificate', amountKop: 30_000, certificate: right }]), 'CERTIFICATE_PIN_LOCKED');
    clock.advance(15 * 60_000 + 1000);
    try {
      expect((await payByCertificate(b, right, [{ method: 'certificate', amountKop: 30_000, certificate: right }])).session.status).toBe('paid');
    } finally {
      clock.set('2026-11-14T05:00:00Z');
    }
  });

  it('строка сертификата без проверки кода до транзакции – не проводится', async () => {
    const s = await sell(40_000);
    const b = await booking();
    const cert = { number: s.certificate.number, pin: s.pin };
    await expect(pay(b, [{ method: 'certificate', amountKop: 30_000, certificate: cert }])).rejects.toThrow(/не проверен/);
  });
});

describe('гонки', () => {
  it('50 параллельных оплат одной брони разными ключами → один платёж, 49 ALREADY_PAID, один приход', async () => {
    const b = await booking();
    const before = await cash();
    const res = await Promise.all(Array.from({ length: 50 }, (_, i) => codeOf(pay(b, [{ method: i % 2 ? 'cash' : 'card', amountKop: 30_000 }]))));
    expect(res.filter((x) => x === 'ok')).toHaveLength(1);
    expect(res.filter((x) => x === 'ALREADY_PAID')).toHaveLength(49);
    expect(await cash()).toBe(before + 30_000);
    const n = await db.client.query(`SELECT count(*)::int AS n FROM app.payments WHERE session_id = $1`, [b]);
    expect(n.rows[0].n).toBe(1);
  });

  it('оплата против отмены брони: либо оплачено до отмены, либо BOOKING_NOT_PAYABLE – без взаимоблокировок', async () => {
    for (let i = 0; i < 10; i++) {
      const b = await booking();
      const cancel = tx(async (t) => {
        await t.query(`SELECT 1 FROM app.bookings WHERE id = $1 FOR UPDATE`, [b]);
        await t.query(`UPDATE app.bookings SET status = 'cancelled_by_club', cancelled_at = now(), cancel_comment = 'гонка' WHERE id = $1`, [b]);
      });
      const [p] = await Promise.all([codeOf(pay(b, [{ method: 'cash', amountKop: 30_000 }])), cancel]);
      expect(['ok', 'BOOKING_NOT_PAYABLE']).toContain(p);
      const status = (await getPaymentStatus(pool, [b])).get(b);
      expect(status).toBe(p === 'ok' ? 'paid' : 'unpaid');
    }
  });

  it('оплата баллами против резерва другой брони того же клиента: баллов на одно – проходит ровно одно', async () => {
    for (let i = 0; i < 5; i++) {
      const c = await clientWith(6_000); // 60 минут
      const b = await booking({ clientId: c, minutes: 60 });
      const start = new Date(Date.parse('2026-11-16T04:00:00Z') + (slot++ % 18) * 3_600_000);
      const h = await runOccupancyCommand(pool, (t) =>
        createHold(t, { clientId: c, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc!, start, end: new Date(start.getTime() + 3_600_000) }] }, clock),
      );
      const clientMeta: AuditRequestMeta = { actor: { kind: 'client', clientId: c, sessionId: randomUUID() }, source: 'site', requestId: randomUUID() };
      const [p, r] = await Promise.all([
        codeOf(pay(b, [{ method: 'points', amountKop: 30_000 }])),
        codeOf(tx((t) => reserveForHold(t, { clientId: c, holdId: h.id }, clientMeta, clock))),
      ]);
      expect([p, r].sort()).toEqual(['POINTS_INSUFFICIENT', 'ok']);
      expect((await getBalance(pool, c, clock.now())).balanceCenti).toBe(p === 'ok' ? 0 : 6_000);
    }
  });

  it('бронь из удержания с резервом, worker ещё не обработал booking.confirmed: оплата баллами проходит; потом событие – резервов нет, списание одно', async () => {
    const c = await clientWith(6_000);
    const start = new Date(Date.parse('2026-11-14T05:30:00Z')); // приход открыт: «сейчас» 05:00, начало через 30 минут
    const h = await runOccupancyCommand(pool, (t) =>
      createHold(t, { clientId: c, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc!, start, end: new Date(start.getTime() + 3_600_000) }] }, clock),
    );
    const clientMeta: AuditRequestMeta = { actor: { kind: 'client', clientId: c, sessionId: randomUUID() }, source: 'site', requestId: randomUUID() };
    await tx((t) => reserveForHold(t, { clientId: c, holdId: h.id }, clientMeta, clock));
    const b = (await runOccupancyCommand(pool, (t) => confirmHold(t, c, h.id, clock))).bookings[0]!.id;
    const rv = Number((await one<{ row_version: number }>('SELECT row_version FROM app.bookings WHERE id = $1', [b])).row_version);
    await runOccupancyCommand(pool, (t) => markArrived(t, b, { ctx: owner, rowVersion: rv }, meta(owner), clock));
    const due = (await paymentBookingProvider.payableBooking(pool, b))!.priceKop;
    const r = await pay(b, [{ method: 'points', amountKop: due }]); // до исправления – POINTS_INSUFFICIENT (свой резерв удержания)
    expect((await getPayment(pool, r.paymentId))!.lines).toMatchObject([{ method: 'points', pointsCenti: 6_000 }]);
    // worker позже: резерв удержания закрыт, на оплаченную бронь не создан
    await tx((t) => convertReserves(t, c, { bookings: paymentBookingProvider, payments: paymentLookup, clock }));
    const res = await db.client.query(`SELECT status FROM app.loyalty_reserves WHERE client_id = $1`, [c]);
    expect(res.rows.map((x) => x.status)).toEqual(['converted']);
    expect(await getBalance(pool, c, clock.now())).toMatchObject({ balanceCenti: 0, reservedCenti: 0 });
  });
});
