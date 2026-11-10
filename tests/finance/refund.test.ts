// S2-21: возврат платежа (K10 §4; 06 §5.2, §17 п.14; 18 §6.3 п.10; 08 §9.2). Возврат не удаляет платёж и проводку;
// деньги – частично и целиком, баллы и сертификат – только целиком; REFUND_EXCEEDS_PAID; attempt=2 после полного,
// ALREADY_PAID после частичного; сертификат после срока – not_restored; событие payment.refunded.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bookingLookup, paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { createCertificatePaymentMethod, verifyCertificatePin } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { clearPaymentMethods, registerPaymentMethod } from '../../apps/api/src/modules/finance/methods.ts';
import { getPayment, getPaymentStatus, recordPayment, type PaymentDeps } from '../../apps/api/src/modules/finance/payment.ts';
import { refundPayment } from '../../apps/api/src/modules/finance/refund.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { recordExpense } from '../../apps/api/src/modules/finance/cashbox.ts';
import { createBatch, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { pointsPaymentMethod } from '../../apps/api/src/modules/loyalty/payment-method.ts';
import { bookingClientMerger } from '../../apps/api/src/modules/booking/merge.ts';
import { certificatesClientMerger } from '../../apps/api/src/modules/certificates/merge.ts';
import { clearClientMergers, mergeClients, registerClientMerger } from '../../apps/api/src/modules/clients/merge.ts';
import { eventsClientMerger } from '../../apps/api/src/modules/events/merge.ts';
import { financeClientMerger } from '../../apps/api/src/modules/finance/merge.ts';
import { loyaltyClientMerger } from '../../apps/api/src/modules/loyalty/merge.ts';
import { notificationsClientMerger } from '../../apps/api/src/modules/notifications/merge.ts';
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


const refund = (paymentId: string, body: object, who: AccessContext = owner) =>
  tx(async (t) => {
    const s = await t.query<{ row_version: number }>(`SELECT s.row_version FROM app.payment_sessions s JOIN app.payments p ON p.session_id = s.booking_id WHERE p.id = $1`, [paymentId]);
    return refundPayment(t, who, { paymentId, rowVersion: s.rows[0]?.row_version ?? 1, reason: 'ошибка способа', ...body }, meta(who), { clock });
  });

describe('возврат денег', () => {
  it('целиком: касса уменьшилась операцией refund со ссылкой на приход, платёж и проводка целы; событие и аудит', async () => {
    const b = await booking();
    const p = await pay(b, [{ method: 'cash', amountKop: 30_000 }]);
    const before = await cash();
    const r = await refund(p.paymentId, { lines: [{ lineNo: 1 }] });
    expect(r.session).toMatchObject({ status: 'refunded', activePaymentId: null });
    expect(await cash()).toBe(before - 30_000);
    const pay1 = (await getPayment(pool, p.paymentId))!;
    expect(pay1).toMatchObject({ status: 'refunded', lines: [{ lineNo: 1, method: 'cash', amountKop: 30_000 }] });
    const ops = await db.client.query(`SELECT kind, ref_type, ref_id, comment FROM journal.finance_operations WHERE id = $1 OR (kind = 'refund' AND ref_id = $1) ORDER BY number`, [pay1.lines[0]!.financeOperationId]);
    expect(ops.rows).toEqual([
      { kind: 'income', ref_type: 'payment', ref_id: p.paymentId, comment: null },
      { kind: 'refund', ref_type: 'operation', ref_id: pay1.lines[0]!.financeOperationId, comment: 'ошибка способа' },
    ]);
    const rr = await db.client.query(`SELECT line_no, seq, amount_kop, outcome FROM app.payment_refunds WHERE payment_id = $1`, [p.paymentId]);
    expect(rr.rows).toEqual([{ line_no: 1, seq: 1, amount_kop: '30000', outcome: 'returned' }]);
    const ev = await db.client.query(`SELECT payload FROM app.outbox_events WHERE event_type = 'payment.refunded' AND aggregate_id = $1`, [p.paymentId]);
    expect(ev.rows[0].payload).toMatchObject({ paymentId: p.paymentId, bookingId: b, sessionStatus: 'refunded', lines: [{ lineNo: 1, method: 'cash', amountKop: 30_000, outcome: 'returned' }] });
    const a = await db.client.query(`SELECT action FROM journal.audit_events WHERE object_type = 'payment' AND object_id = $1 ORDER BY id`, [p.paymentId]);
    expect(a.rows.map((x) => x.action)).toEqual(['payment.recorded', 'payment.refunded']);
    // ручное сторно возврата и прихода по сеансу – только через возврат платежа
    await fails(tx((t) => reverseOperation(t, owner, { operationId: pay1.lines[0]!.financeOperationId, reason: 'x' }, meta(owner), { idempotencyKey: randomUUID(), clock })), 'USE_PAYMENT_REFUND');
  });

  it('полный возврат → повторная оплата attempt=2 другим способом; частичный → ALREADY_PAID', async () => {
    const b = await booking();
    const p1 = await pay(b, [{ method: 'cash', amountKop: 30_000 }]);
    await refund(p1.paymentId, { lines: [{ lineNo: 1 }] });
    const p2 = await pay(b, [{ method: 'card', amountKop: 30_000 }]);
    expect((await getPayment(pool, p2.paymentId))!.attempt).toBe(2);
    const k = await db.client.query(`SELECT 1 FROM journal.ledger_entries WHERE idempotency_key = $1`, [`payment:${b}:2:1#0`]);
    expect(k.rowCount).toBe(1);
    const r = await refund(p2.paymentId, { lines: [{ lineNo: 1, amountKop: 10_000 }] });
    expect(r.session.status).toBe('partially_refunded');
    expect((await fails(pay(b, [{ method: 'cash', amountKop: 30_000 }]), 'ALREADY_PAID')).details).toEqual({ paymentId: p2.paymentId });
    expect((await getPaymentStatus(pool, [b])).get(b)).toBe('partially_refunded');
  });

  it('частями до полной суммы; больше непогашенной части – REFUND_EXCEEDS_PAID; ключи K3 refund:<paymentId>:<line>:<n>', async () => {
    const b = await booking();
    const p = await pay(b, [{ method: 'transfer', amountKop: 30_000 }]);
    await refund(p.paymentId, { lines: [{ lineNo: 1, amountKop: 10_000 }] });
    await fails(refund(p.paymentId, { lines: [{ lineNo: 1, amountKop: 20_001 }] }), 'REFUND_EXCEEDS_PAID');
    const r = await refund(p.paymentId, { lines: [{ lineNo: 1, amountKop: 20_000 }] });
    expect(r.session.status).toBe('refunded');
    await fails(refund(p.paymentId, { lines: [{ lineNo: 1, amountKop: 1 }] }), 'REFUND_EXCEEDS_PAID');
    const keys = await db.client.query(
      `SELECT le.idempotency_key FROM app.payment_refunds r JOIN journal.ledger_entries le ON le.posting_id = r.ledger_posting_id WHERE r.payment_id = $1 ORDER BY r.seq`,
      [p.paymentId],
    );
    expect(keys.rows.map((x) => x.idempotency_key)).toEqual([`refund:${p.paymentId}:1:1#0`, `refund:${p.paymentId}:1:2#0`]);
  });

  it('без причины – COMMENT_REQUIRED; устаревший rowVersion – VERSION_CONFLICT; Администратор – FORBIDDEN; чужой – 404', async () => {
    const b = await booking();
    const p = await pay(b, [{ method: 'cash', amountKop: 30_000 }]);
    await fails(refund(p.paymentId, { lines: [{ lineNo: 1 }], reason: ' ' }), 'COMMENT_REQUIRED');
    await fails(tx((t) => refundPayment(t, owner, { paymentId: p.paymentId, rowVersion: 1, reason: 'x', lines: [{ lineNo: 1 }] }, meta(owner), { clock })), 'VERSION_CONFLICT');
    const as = (role: 'admin' | 'director', branchIds: string[]): AccessContext => ({ actor: { kind: 'staff', staffId: ids.owner!, sessionId: randomUUID() }, role, network: false, cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() });
    await fails(refund(p.paymentId, { lines: [{ lineNo: 1 }] }, as('admin', [ids.b1!])), 'FORBIDDEN');
    await fails(refund(p.paymentId, { lines: [{ lineNo: 1 }] }, as('director', [randomUUID()])), 'NOT_FOUND');
    expect((await refund(p.paymentId, { lines: [{ lineNo: 1 }] }, as('director', [ids.b1!]))).session.status).toBe('refunded');
  });

  it('возврат больше остатка места денег при запрете минуса – CASH_INSUFFICIENT (K17 §6)', async () => {
    const b = await booking();
    const p = await pay(b, [{ method: 'card', amountKop: 30_000 }]);
    const noncash = Number((await db.client.query(`SELECT balance FROM app.ledger_accounts WHERE owner_id = $1 AND kind = 'cash_branch_noncash'`, [ids.b1])).rows[0].balance);
    // уводим безнал ниже суммы возврата расходом
    const other = (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее'`)).rows[0]!.id;
    await tx((t) => recordExpense(t, owner, { branchId: ids.b1, method: 'card', amountKop: noncash - 1_000, categoryId: other, occurredAt: '2026-11-14T04:00:00Z', comment: 'закупка' }, meta(owner), { idempotencyKey: randomUUID(), clock }));
    await fails(refund(p.paymentId, { lines: [{ lineNo: 1 }] }), 'CASH_INSUFFICIENT');
    expect((await getPayment(pool, p.paymentId))!.status).toBe('active');
  });
});

describe('возврат баллов и сертификата – только целиком', () => {
  it('баллы: частично – REFUND_PARTIAL_NOT_ALLOWED; целиком – вернулись в партии; повторная оплата баллами проходит', async () => {
    const c = await clientWith(6_000);
    const b = await booking({ clientId: c });
    const p = await pay(b, [{ method: 'points', amountKop: 30_000 }]);
    expect((await getBalance(pool, c, clock.now())).balanceCenti).toBe(0);
    await fails(refund(p.paymentId, { lines: [{ lineNo: 1, amountKop: 10_000 }] }), 'REFUND_PARTIAL_NOT_ALLOWED');
    const before = await cash();
    const r = await refund(p.paymentId, { lines: [{ lineNo: 1 }] });
    expect(r.session.status).toBe('refunded');
    expect((await getBalance(pool, c, clock.now())).balanceCenti).toBe(6_000);
    expect(await cash()).toBe(before);
    const rr = await db.client.query(`SELECT points_centi, outcome FROM app.payment_refunds WHERE payment_id = $1`, [p.paymentId]);
    expect(rr.rows).toEqual([{ points_centi: '6000', outcome: 'returned' }]);
    expect((await pay(b, [{ method: 'points', amountKop: 30_000 }])).session.status).toBe('paid');
  });

  it('сертификат: до срока – returned, остаток восстановлен; после срока – not_restored, денег нет', async () => {
    const s = await sell(40_000);
    const cert = { number: s.certificate.number, pin: s.pin };
    const b1 = await booking();
    const p1 = await payByCertificate(b1, cert, [{ method: 'certificate', amountKop: 30_000, certificate: cert }]);
    await refund(p1.paymentId, { lines: [{ lineNo: 1 }] });
    const bal = async () => Number((await db.client.query(`SELECT la.balance FROM app.certificates c JOIN app.ledger_accounts la ON la.id = c.ledger_account_id WHERE c.id = $1`, [s.certificate.id])).rows[0].balance);
    expect(await bal()).toBe(40_000);
    const b2 = await booking();
    const p2 = await payByCertificate(b2, cert, [{ method: 'certificate', amountKop: 30_000, certificate: cert }]);
    clock.advance(200 * 86_400_000); // срок 6 месяцев прошёл
    try {
      const before = await cash();
      const r = await refund(p2.paymentId, { lines: [{ lineNo: 1 }] });
      expect(r.session.status).toBe('refunded');
      expect(await bal()).toBe(10_000);
      expect(await cash()).toBe(before);
      const rr = await db.client.query(`SELECT outcome, ledger_posting_id FROM app.payment_refunds WHERE payment_id = $1`, [p2.paymentId]);
      expect(rr.rows).toEqual([{ outcome: 'not_restored', ledger_posting_id: null }]);
    } finally {
      clock.set('2026-11-14T05:00:00Z');
    }
  });

  it('«сертификат + деньги» (R-03): деньги частично, сертификат целиком; обе строки закрыты → refunded', async () => {
    await setTopup(true);
    try {
      const s = await sell(10_000);
      const cert = { number: s.certificate.number, pin: s.pin };
      const b = await booking();
      const p = await payByCertificate(b, cert, [{ method: 'certificate', amountKop: 10_000, certificate: cert }, { method: 'cash', amountKop: 20_000 }]);
      expect((await refund(p.paymentId, { lines: [{ lineNo: 2, amountKop: 5_000 }] })).session.status).toBe('partially_refunded');
      await fails(refund(p.paymentId, { lines: [{ lineNo: 1, amountKop: 1_000 }] }), 'REFUND_PARTIAL_NOT_ALLOWED');
      const r = await refund(p.paymentId, { lines: [{ lineNo: 1 }, { lineNo: 2 }] });
      expect(r.session.status).toBe('refunded');
      const rr = await db.client.query(`SELECT line_no, seq, amount_kop FROM app.payment_refunds WHERE payment_id = $1 ORDER BY line_no, seq`, [p.paymentId]);
      expect(rr.rows).toEqual([
        { line_no: 1, seq: 1, amount_kop: '10000' },
        { line_no: 2, seq: 1, amount_kop: '5000' },
        { line_no: 2, seq: 2, amount_kop: '15000' },
      ]);
    } finally {
      await setTopup(false);
    }
  });
});

describe('гонка', () => {
  it('8 параллельных полных возвратов одного платежа – один проходит, касса уменьшилась один раз', async () => {
    const b = await booking();
    const p = await pay(b, [{ method: 'cash', amountKop: 30_000 }]);
    const before = await cash();
    const res = await Promise.all(Array.from({ length: 8 }, () => codeOf(refund(p.paymentId, { lines: [{ lineNo: 1 }] }))));
    expect(res.filter((x) => x === 'ok')).toHaveLength(1);
    // ждавшие блокировку со старым rowVersion – VERSION_CONFLICT, начавшие после – REFUND_EXCEEDS_PAID
    for (const c of res.filter((x) => x !== 'ok')) expect(['VERSION_CONFLICT', 'REFUND_EXCEEDS_PAID']).toContain(c);
    expect(await cash()).toBe(before - 30_000);
  });
});

describe('возврат баллов после слияния карточек (D5-08, D5-09)', () => {
  beforeAll(() => {
    clearClientMergers();
    for (const m of [bookingClientMerger, financeClientMerger, loyaltyClientMerger, certificatesClientMerger, eventsClientMerger, notificationsClientMerger]) registerClientMerger(m);
  });
  afterAll(() => clearClientMergers());

  const merge = (p: string, s: string) => tx((t) => mergeClients(t, owner, { primaryId: p, secondaryId: s, reason: 'same_person_confirmed' }, meta(owner), undefined, clock));
  const points = async (id: string) => (await getBalance(pool, id, clock.now())).balanceCenti;
  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const r = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if (r.rows[0]!.n > 0) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('возврат не ждёт замка');
  }

  it('счёт объединённой карточки списания берётся до сеанса: пока он занят, сеанс свободен; затем баллы – у основной', async () => {
    const m = await clientWith(6_000);
    const p = await clientWith(1_000);
    const b = await booking({ clientId: m });
    const pm = await pay(b, [{ method: 'points', amountKop: 30_000 }]);
    await merge(p, m);
    const hold = await pool.connect();
    try {
      await hold.query('BEGIN');
      await hold.query(`SELECT id FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_id = $1 FOR UPDATE`, [m]);
      const r = codeOf(refund(pm.paymentId, { lines: [{ lineNo: 1 }] }));
      await waitForLockWait();
      // возврат ждёт счёт второй и ещё не держит сеанс (до правки держал – взаимоблокировка с командами «счёт → сеанс»)
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        expect(await codeOf(probe.query(`SELECT 1 FROM app.payment_sessions WHERE booking_id = $1 FOR UPDATE NOWAIT`, [b]))).toBe('ok');
      } finally {
        await probe.query('ROLLBACK');
        probe.release();
      }
      await hold.query('COMMIT');
      expect(await r).toBe('ok');
    } finally {
      hold.release();
    }
    expect(await points(p)).toBe(7_000);
    expect(await points(m)).toBe(0);
  });

  it('карточку сеанса объединили, пока возврат ждал её счёт, – CLIENT_MERGED; повтор возвращает баллы последней в цепочке', async () => {
    const m = await clientWith(6_000);
    const p = await clientWith(100);
    const q = await clientWith(100);
    const b = await booking({ clientId: m });
    const pm = await pay(b, [{ method: 'points', amountKop: 30_000 }]);
    await merge(p, m);
    const c = await pool.connect();
    let r: Promise<string>;
    try {
      await c.query('BEGIN');
      await mergeClients(c, owner, { primaryId: q, secondaryId: p, reason: 'same_person_confirmed' }, meta(owner), undefined, clock);
      r = codeOf(refund(pm.paymentId, { lines: [{ lineNo: 1 }] }));
      await waitForLockWait();
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await r).toBe('CLIENT_MERGED');
    expect(await codeOf(refund(pm.paymentId, { lines: [{ lineNo: 1 }] }))).toBe('ok');
    expect(await points(q)).toBe(6_200);
    expect(await points(p)).toBe(0);
    expect(await points(m)).toBe(0);
  });
});
