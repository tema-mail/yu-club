// S2-51: способ оплаты certificate (K16 §3, §5, §6; TC-08 погашение; 18 §6.3 п.3–5).
// Погашение без дохода в кассу; сверх остатка и истёкший – отказ; drain при R-03; два и больше параллельных погашений
// на настоящем Postgres – остаток ≥ 0; неверный код фиксируется отдельной транзакцией и не откатывается вместе с
// отказом; возврат до срока – returned, после срока – not_restored.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { verifyBalance } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type Clock } from '../../apps/api/src/core/time.ts';
import {
  createCertificatePaymentMethod,
  PIN_LOCK_MS,
  verifyCertificatePin,
} from '../../apps/api/src/modules/certificates/payment-method.ts';
import { sellCertificate, type CertificateDto } from '../../apps/api/src/modules/certificates/sale.ts';
import type { ChargeInput, PaymentLine, PaymentSession } from '../../apps/api/src/modules/finance/methods.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { createTestPayment } from '../helpers/payment.ts';

const PEPPER = 'cert-pepper-'.padEnd(40, 'y');
const T0 = new Date('2026-11-14T05:00:00Z');
const clock = fixedClock(T0);
const handler = createCertificatePaymentMethod({ pepper: PEPPER });
let db: TestDatabase;
let pool: pg.Pool;
let ownerId: string;
let clientId: string;
let saleBranch: string;
let sessionBranch: string;
let resourceId: string;

const owner = (): AccessContext => ({
  actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() },
  role: 'owner',
  network: true,
  cityIds: new Set(),
  branchIds: new Set(),
  at: T0,
});
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

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

async function sell(nominalKop: number, c: Clock = clock): Promise<{ certificate: CertificateDto; pin: string }> {
  const o = owner();
  return tx((t) => sellCertificate(t, o, { branchId: saleBranch, nominalKop, method: 'cash' }, meta(o), { pepper: PEPPER, clock: c }));
}
const paymentOf = new Map<string, string>();
async function booking(): Promise<PaymentSession> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-11-14T04:00:00Z', '2026-11-14T05:00:00Z', '[)'), 300000, 'crm', 'staff', 'arrived') RETURNING id`,
    [sessionBranch, clientId, resourceId],
  );
  const id = r.rows[0]!.id;
  paymentOf.set(id, await createTestPayment(db.client, id));
  return { id, bookingId: id, branchId: sessionBranch, clientId, amountDueKop: 300_000, bookingVersion: 1, status: 'unpaid', activePaymentId: null, rowVersion: 1 };
}
function chargeInput(session: PaymentSession, cert: { number: string; pin: string }, amountKop: number, extra: Partial<ChargeInput> = {}): ChargeInput {
  return {
    session,
    lineNo: 1,
    amountKop,
    minutes: 60,
    resourceType: 'pc',
    certificate: cert,
    idempotencyKey: `payment:${session.id}:1:1`,
    author: { type: 'staff', id: ownerId },
    occurredAt: T0,
    mode: 'exact',
    paymentId: paymentOf.get(session.id) ?? randomUUID(),
    ...extra,
  };
}
const charge = (input: ChargeInput) => tx((t) => handler.charge(t, input));
const balanceOf = async (certificateId: string) =>
  Number((await db.client.query(`SELECT la.balance FROM app.certificates c JOIN app.ledger_accounts la ON la.id = c.ledger_account_id WHERE c.id = $1`, [certificateId])).rows[0].balance);
const failedCount = async (id: string) => (await db.client.query(`SELECT pin_failed_count, pin_locked_until FROM app.certificates WHERE id = $1`, [id])).rows[0];
const wrongPin = (pin: string) => String((Number(pin) + 1) % 10_000).padStart(4, '0');

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 16 });
  ownerId = (await db.client.query(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'С', 'o@yu.test', 'owner', 'x') RETURNING id`)).rows[0].id;
  clientId = (await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+79130000777', 'active', 'system') RETURNING id`)).rows[0].id;
  saleBranch = (await createTestBranch(db.client)).id;
  sessionBranch = (await createTestBranch(db.client)).id;
  resourceId = (await db.client.query(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [sessionBranch])).rows[0].id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('погашение (K16 §5, TC-08)', () => {
  it('продажа 5 000 ₽, погашения 1 500 и 2 000 в другом филиале → остаток 1 500, касса без новых поступлений', async () => {
    const { certificate, pin } = await sell(500_000);
    const cert = { number: certificate.number, pin };
    const s1 = await booking();
    const s2 = await booking();
    const r1 = await charge(chargeInput(s1, cert, 150_000));
    const r2 = await charge(chargeInput(s2, { number: certificate.number.toLowerCase(), pin }, 200_000));
    expect(r1).toMatchObject({ amountKop: 150_000, certificateId: certificate.id });
    expect(r1.financeOperationId).toBeUndefined();
    expect(r2.amountKop).toBe(200_000);
    expect(await balanceOf(certificate.id)).toBe(150_000);
    const ops = await db.client.query(`SELECT branch_id, amount_kop FROM journal.finance_operations WHERE ref_id = $1 OR branch_id = $2`, [certificate.id, sessionBranch]);
    expect(ops.rows).toEqual([{ branch_id: saleBranch, amount_kop: '500000' }]); // одна операция кассы – продажа
    const places = await db.client.query(`SELECT count(*)::int AS n FROM app.ledger_accounts WHERE owner_id = $1`, [sessionBranch]);
    expect(places.rows[0].n).toBe(0); // в филиале сеанса места денег даже не появились
    const red = await db.client.query(`SELECT booking_id, branch_id, client_id, amount_kop, status FROM app.certificate_redemptions WHERE certificate_id = $1 ORDER BY amount_kop`, [certificate.id]);
    expect(red.rows).toEqual([
      { booking_id: s1.id, branch_id: sessionBranch, client_id: clientId, amount_kop: '150000', status: 'active' },
      { booking_id: s2.id, branch_id: sessionBranch, client_id: clientId, amount_kop: '200000', status: 'active' },
    ]);
    const entries = await db.client.query(
      `SELECT le.entry_type, le.branch_id, le.ref_type FROM journal.ledger_entries le JOIN app.certificates c ON c.ledger_account_id = le.account_id WHERE c.id = $1 ORDER BY le.id`,
      [certificate.id],
    );
    expect(entries.rows.map((e) => [e.entry_type, e.branch_id, e.ref_type])).toEqual([
      ['certificate.issue', saleBranch, 'certificate'],
      ['certificate.redeem', sessionBranch, 'booking'],
      ['certificate.redeem', sessionBranch, 'booking'],
    ]);
    const audit = await db.client.query(`SELECT count(*)::int AS n FROM journal.audit_events WHERE action = 'certificate.redeemed' AND object_id = $1`, [certificate.id]);
    expect(audit.rows[0].n).toBe(2);
  });

  it('повтор с тем же ключом K3 – та же проводка, одно погашение', async () => {
    const { certificate, pin } = await sell(100_000);
    const s = await booking();
    const input = chargeInput(s, { number: certificate.number, pin }, 40_000);
    const a = await charge(input);
    const b = await charge(input);
    expect(b.postingId).toBe(a.postingId);
    expect(await balanceOf(certificate.id)).toBe(60_000);
    const n = await db.client.query(`SELECT count(*)::int AS n FROM app.certificate_redemptions WHERE certificate_id = $1`, [certificate.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('сверх остатка – CERTIFICATE_INSUFFICIENT с остатком; drain (R-03) списывает весь остаток', async () => {
    const { certificate, pin } = await sell(100_000);
    const cert = { number: certificate.number, pin };
    const err = await fails(charge(chargeInput(await booking(), cert, 100_001)), 'CERTIFICATE_INSUFFICIENT');
    expect(err.details).toEqual({ balanceKop: 100_000 });
    const drained = await charge(chargeInput(await booking(), cert, 300_000, { mode: 'drain' }));
    expect(drained.amountKop).toBe(100_000);
    expect(await balanceOf(certificate.id)).toBe(0);
    // остаток 0 – used_up
    const used = await fails(charge(chargeInput(await booking(), cert, 1)), 'CERTIFICATE_NOT_ACTIVE');
    expect(used.details).toEqual({ status: 'used_up' });
  });

  it('истёкший до прохода задачи – CERTIFICATE_EXPIRED; «требует проверки» и неверный код – отказ', async () => {
    const { certificate, pin } = await sell(100_000);
    const cert = { number: certificate.number, pin };
    const at = new Date(certificate.expiresAt);
    await fails(charge(chargeInput(await booking(), cert, 1_000, { occurredAt: at })), 'CERTIFICATE_EXPIRED');
    await charge(chargeInput(await booking(), cert, 1_000, { occurredAt: new Date(at.getTime() - 1) })); // последняя миллисекунда – ещё можно
    await fails(charge(chargeInput(await booking(), { number: certificate.number, pin: wrongPin(pin) }, 1_000)), 'CERTIFICATE_NOT_FOUND');
    await fails(charge(chargeInput(await booking(), { number: 'YC-0000-0000', pin }, 1_000)), 'CERTIFICATE_NOT_FOUND');
    await db.client.query(`UPDATE app.certificates SET review_reason = 'проверка' WHERE id = $1`, [certificate.id]);
    const err = await fails(charge(chargeInput(await booking(), cert, 1_000)), 'CERTIFICATE_NOT_ACTIVE');
    expect(err.details).toEqual({ status: 'needs_review' });
    expect(await balanceOf(certificate.id)).toBe(99_000);
  });

  it('гонка: 8 параллельных погашений по 2 000 ₽ при остатке 5 000 – проходят два, остаток 1 000 ≥ 0', async () => {
    const { certificate, pin } = await sell(500_000);
    const cert = { number: certificate.number, pin };
    const sessions: PaymentSession[] = [];
    for (let i = 0; i < 8; i++) sessions.push(await booking());
    const results = await Promise.allSettled(sessions.map((s) => charge(chargeInput(s, cert, 200_000))));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const codes = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as AppError).code] : []));
    expect(ok).toHaveLength(2);
    expect(codes).toEqual(Array(6).fill('CERTIFICATE_INSUFFICIENT'));
    expect(await balanceOf(certificate.id)).toBe(100_000);
    const acc = await db.client.query(`SELECT ledger_account_id FROM app.certificates WHERE id = $1`, [certificate.id]);
    expect((await verifyBalance(db.client, acc.rows[0].ledger_account_id)).ok).toBe(true);
  });
});

describe('код: отдельная короткая транзакция (K16 §3)', () => {
  it('неверный код увеличивает счётчик и не откатывается вместе с отказом основной команды; нет номера – тот же ответ', async () => {
    const { certificate, pin } = await sell(100_000);
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); // «основная транзакция оплаты», которая потом откатится
      const e1 = await fails(verifyCertificatePin(pool, { number: certificate.number, pin: wrongPin(pin) }, { pepper: PEPPER, clock }), 'CERTIFICATE_NOT_FOUND');
      const e2 = await fails(verifyCertificatePin(pool, { number: 'YC-ZZZZ-ZZZZ', pin }, { pepper: PEPPER, clock }), 'CERTIFICATE_NOT_FOUND');
      expect(e1.message).toBe(e2.message);
      expect(e1.details).toEqual(e2.details);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect((await failedCount(certificate.id)).pin_failed_count).toBe(1);
    // успех обнуляет
    expect(await verifyCertificatePin(pool, { number: certificate.number, pin }, { pepper: PEPPER, clock })).toEqual({ certificateId: certificate.id });
    expect((await failedCount(certificate.id)).pin_failed_count).toBe(0);
  });

  it('5 неверных → CERTIFICATE_PIN_LOCKED на 15 минут, и верный код в это время не проходит; после – проходит', async () => {
    const { certificate, pin } = await sell(100_000);
    const bad = { number: certificate.number, pin: wrongPin(pin) };
    for (let i = 0; i < 4; i++) await fails(verifyCertificatePin(pool, bad, { pepper: PEPPER, clock }), 'CERTIFICATE_NOT_FOUND');
    const lockedErr = await fails(verifyCertificatePin(pool, bad, { pepper: PEPPER, clock }), 'CERTIFICATE_PIN_LOCKED');
    expect(lockedErr.httpStatus).toBe(429);
    expect(lockedErr.details).toEqual({ retryAfterSec: 900 });
    await fails(verifyCertificatePin(pool, { number: certificate.number, pin }, { pepper: PEPPER, clock }), 'CERTIFICATE_PIN_LOCKED');
    // погашение в блоке тоже не проходит, даже с верным кодом
    await fails(charge(chargeInput(await booking(), { number: certificate.number, pin }, 1_000)), 'CERTIFICATE_PIN_LOCKED');
    const later = fixedClock(new Date(T0.getTime() + PIN_LOCK_MS));
    expect(await verifyCertificatePin(pool, { number: certificate.number, pin }, { pepper: PEPPER, clock: later })).toEqual({ certificateId: certificate.id });
    expect(await failedCount(certificate.id)).toEqual({ pin_failed_count: 0, pin_locked_until: null });
    const audit = await db.client.query<{ t: string }>(`SELECT row_to_json(a)::text AS t FROM journal.audit_events a WHERE action = 'certificate.pin_locked' AND object_id = $1`, [certificate.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.t).not.toContain(`"${pin}"`);
  });
});

describe('возврат погашения (K16 §6)', () => {
  const line = (r: { postingId: string; amountKop: number; certificateId?: string }): PaymentLine => ({
    lineNo: 1,
    method: 'certificate',
    amountKop: r.amountKop,
    certificateId: r.certificateId!,
    ledgerPostingId: r.postingId,
  });
  const refund = (l: PaymentLine, at: Date, key = randomUUID()) =>
    tx((t) => handler.refund(t, { line: l, amountKop: l.amountKop, idempotencyKey: `refund:${key}`, author: { type: 'staff', id: ownerId }, occurredAt: at, reason: 'ошибка способа' }));

  it('до срока – returned, остаток восстановлен; повтор с тем же ключом – та же проводка', async () => {
    const { certificate, pin } = await sell(100_000);
    const r = await charge(chargeInput(await booking(), { number: certificate.number, pin }, 30_000));
    const key = randomUUID();
    const a = await refund(line(r), T0, key);
    expect(a.outcome).toBe('returned');
    expect(await balanceOf(certificate.id)).toBe(100_000);
    const b = await refund(line(r), T0, key);
    expect(b).toEqual(a);
    expect(await balanceOf(certificate.id)).toBe(100_000);
    const red = await db.client.query(`SELECT status, return_entry_id IS NOT NULL AS has FROM app.certificate_redemptions WHERE certificate_id = $1`, [certificate.id]);
    expect(red.rows).toEqual([{ status: 'returned', has: true }]);
    // только целиком
    await fails(tx((t) => handler.refund(t, { line: line(r), amountKop: 10_000, idempotencyKey: 'refund:x', author: { type: 'staff', id: ownerId }, occurredAt: T0, reason: 'частично' })), 'VALIDATION_FAILED');
  });

  it('после срока – not_restored: остаток не восстанавливается, срок не продлевается', async () => {
    const { certificate, pin } = await sell(100_000);
    const r = await charge(chargeInput(await booking(), { number: certificate.number, pin }, 30_000));
    const res = await refund(line(r), new Date(certificate.expiresAt));
    expect(res).toEqual({ postingId: null, outcome: 'not_restored' });
    expect(await balanceOf(certificate.id)).toBe(70_000);
    expect((await refund(line(r), T0)).outcome).toBe('not_restored'); // исход окончательный
    const c = await db.client.query(`SELECT expires_at FROM app.certificates WHERE id = $1`, [certificate.id]);
    expect(c.rows[0].expires_at.toISOString()).toBe(certificate.expiresAt);
  });
});
