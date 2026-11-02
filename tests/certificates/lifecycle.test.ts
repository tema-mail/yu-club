// S2-52: жизненный цикл сертификата (K16 §4, §6, §7; TC-08 сгорание).
// Сгорание – отдельной записью K3, касса не меняется; погашение против сгорания на настоящем Postgres – сумма
// погашений и сгорания = номинал, остаток 0; отмена использованного → CERTIFICATE_USED; корректировка выше
// номинала – отказ; «требует проверки» запрещает погашение; получатель – с историей.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type Clock } from '../../apps/api/src/core/time.ts';
import { cancelSale, correctBalance, expireDueCertificates, linkRecipient, setReview } from '../../apps/api/src/modules/certificates/lifecycle.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { getCertificate, sellCertificate, type CertificateDto } from '../../apps/api/src/modules/certificates/sale.ts';
import type { ChargeResult } from '../../apps/api/src/modules/finance/methods.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { createTestPayment } from '../helpers/payment.ts';

const PEPPER = 'cert-pepper-'.padEnd(40, 'z');
const T0 = new Date('2026-11-14T05:00:00Z');
const clock = fixedClock(T0);
const handler = createCertificatePaymentMethod({ pepper: PEPPER });
let db: TestDatabase;
let pool: pg.Pool;
let ownerId: string;
let clientId: string;
let saleBranch: string;
let otherBranch: string;
let resourceId: string;

async function staff(role: StaffRole): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`, [
    `${randomUUID()}@club.ru`,
    role,
  ]);
  return r.rows[0]!.id;
}
const ctx = (role: StaffRole, staffId: string, branchIds: string[] = []): AccessContext => ({
  actor: { kind: 'staff', staffId, sessionId: randomUUID() },
  role,
  network: role === 'owner',
  cityIds: new Set(),
  branchIds: new Set(branchIds),
  at: T0,
});
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });
const owner = () => ctx('owner', ownerId);

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
// Задача сгорания общая для базы: сертификаты тестов сгорания продаются раньше (daysAgo), чтобы их граница
// наступала раньше границы остальных и проход не сжигал сертификаты следующих тестов.
const sell = (nominalKop: number, method: 'cash' | 'card' = 'cash', daysAgo = 0) =>
  tx((t) =>
    sellCertificate(t, owner(), { branchId: saleBranch, nominalKop, method }, meta(owner()), { pepper: PEPPER, clock: fixedClock(new Date(T0.getTime() - daysAgo * 86_400_000)) }),
  );
async function redeem(cert: { certificate: CertificateDto; pin: string }, amountKop: number, at: Date = T0): Promise<ChargeResult> {
  const b = await pool.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-11-14T04:00:00Z', '2026-11-14T05:00:00Z', '[)'), 300000, 'crm', 'staff', 'arrived') RETURNING id`,
    [otherBranch, clientId, resourceId],
  );
  const id = b.rows[0]!.id;
  const paymentId = await createTestPayment(pool, id);
  const session = { id, bookingId: id, branchId: otherBranch, clientId, amountDueKop: amountKop, bookingVersion: 1, status: 'unpaid' as const, activePaymentId: null, rowVersion: 1 };
  return tx((t) =>
    handler.charge(t, {
      session,
      lineNo: 1,
      amountKop,
      minutes: 60,
      resourceType: 'pc',
      certificate: { number: cert.certificate.number, pin: cert.pin },
      idempotencyKey: `payment:${id}:1:1`,
      author: { type: 'staff', id: ownerId },
      occurredAt: at,
      mode: 'exact',
      paymentId,
    }),
  );
}
const balanceOf = async (id: string) => (await getCertificate(db.client, id, clock))!.balanceKop;
const cashOf = async (branchId: string) =>
  Object.fromEntries(
    (await db.client.query<{ kind: string; balance: string }>(`SELECT kind, balance FROM app.ledger_accounts WHERE owner_type = 'branch' AND owner_id = $1`, [branchId])).rows.map((r) => [r.kind, Number(r.balance)]),
  );
const opsCount = async () => (await db.client.query(`SELECT count(*)::int AS n FROM journal.finance_operations`)).rows[0].n as number;
const at = (c: CertificateDto, deltaMs = 0): Clock => fixedClock(new Date(new Date(c.expiresAt).getTime() + deltaMs));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  ownerId = await staff('owner');
  clientId = (await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+79130000555', 'active', 'system') RETURNING id`)).rows[0].id;
  saleBranch = (await createTestBranch(db.client)).id;
  otherBranch = (await createTestBranch(db.client)).id;
  resourceId = (await db.client.query(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [otherBranch])).rows[0].id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('сгорание (K16 §4, TC-08)', () => {
  it('5 000 − 1 500 − 2 000 → сгорает 1 500 отдельной записью, касса не меняется; повтор прохода – ничего', async () => {
    const cert = await sell(500_000, 'cash', 30);
    await redeem(cert, 150_000);
    await redeem(cert, 200_000);
    const cash = await cashOf(saleBranch);
    const ops = await opsCount();
    expect(await expireDueCertificates(pool, at(cert.certificate, -1))).toBe(0); // до границы не сгорает
    expect(await expireDueCertificates(pool, at(cert.certificate))).toBe(1);
    expect(await expireDueCertificates(pool, at(cert.certificate))).toBe(0);
    const entries = await db.client.query(
      `SELECT le.entry_type, le.amount, le.author_type, le.occurred_at FROM journal.ledger_entries le JOIN app.certificates c ON c.ledger_account_id = le.account_id WHERE c.id = $1 ORDER BY le.id`,
      [cert.certificate.id],
    );
    expect(entries.rows.map((e) => [e.entry_type, Number(e.amount)])).toEqual([
      ['certificate.issue', 500_000],
      ['certificate.redeem', -150_000],
      ['certificate.redeem', -200_000],
      ['certificate.expire', -150_000],
    ]);
    expect(entries.rows[3]).toMatchObject({ author_type: 'system', occurred_at: new Date(cert.certificate.expiresAt) });
    expect(await cashOf(saleBranch)).toEqual(cash);
    expect(await opsCount()).toBe(ops);
    const after = (await getCertificate(db.client, cert.certificate.id, at(cert.certificate)))!;
    expect(after).toMatchObject({ status: 'expired', balanceKop: 0 });
    const audit = await db.client.query(`SELECT actor_type, after FROM journal.audit_events WHERE action = 'certificate.expired' AND object_id = $1`, [cert.certificate.id]);
    expect(audit.rows).toEqual([{ actor_type: 'system', after: { burnedKop: 150_000, expiresOn: cert.certificate.expiresOn } }]);
  });

  it('гонка «погашение против сгорания»: Σ погашений + сгорание = номинал, остаток 0, без минуса', async () => {
    const certs = [];
    for (let i = 0; i < 6; i++) certs.push(await sell(100_000, 'cash', 20));
    const results = await Promise.allSettled([
      ...certs.map((c) => redeem(c, 60_000, new Date(new Date(c.certificate.expiresAt).getTime() - 1))),
      expireDueCertificates(pool, at(certs[0]!.certificate)),
      expireDueCertificates(pool, at(certs[0]!.certificate)),
    ]);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as AppError).code).toBe('CERTIFICATE_NOT_ACTIVE');
    expect(await expireDueCertificates(pool, at(certs[0]!.certificate))).toBe(0);
    for (const c of certs) {
      const sums = await db.client.query<{ entry_type: string; s: string }>(
        `SELECT le.entry_type, sum(le.amount) AS s FROM journal.ledger_entries le JOIN app.certificates c ON c.ledger_account_id = le.account_id WHERE c.id = $1 GROUP BY 1`,
        [c.certificate.id],
      );
      const by = Object.fromEntries(sums.rows.map((r) => [r.entry_type, Number(r.s)]));
      expect((by['certificate.redeem'] ?? 0) + (by['certificate.expire'] ?? 0)).toBe(-100_000);
      expect(await balanceOf(c.certificate.id)).toBe(0);
    }
  });
});

describe('отмена продажи (K16 §6, 08 §9.1)', () => {
  it('без погашений: reverse выпуска, возврат денег на место продажи со ссылкой на продажу; статус cancelled; не сгорает', async () => {
    const cert = await sell(200_000, 'card', 10);
    const before = await cashOf(saleBranch);
    const director = ctx('director', await staff('director'), [saleBranch]);
    const res = await tx((t) => cancelSale(t, director, { certificateId: cert.certificate.id, rowVersion: 1, reason: 'покупатель передумал', refundMoney: true }, meta(director), clock));
    expect(res).toMatchObject({ status: 'cancelled', balanceKop: 0, rowVersion: 2 });
    const after = await cashOf(saleBranch);
    expect(after.cash_branch_noncash).toBe(before.cash_branch_noncash! - 200_000);
    const refund = await db.client.query(
      `SELECT r.kind, r.place, r.method, r.amount_kop, r.ref_type, r.ref_id = c.sale_operation_id AS to_sale FROM journal.finance_operations r JOIN app.certificates c ON c.id = $1 WHERE r.kind = 'refund' AND r.ref_id = c.sale_operation_id`,
      [cert.certificate.id],
    );
    expect(refund.rows).toEqual([{ kind: 'refund', place: 'noncash', method: 'card', amount_kop: '200000', ref_type: 'operation', to_sale: true }]);
    await fails(redeem(cert, 1_000), 'CERTIFICATE_NOT_ACTIVE');
    await fails(tx((t) => cancelSale(t, owner(), { certificateId: cert.certificate.id, rowVersion: 2, reason: 'ещё', refundMoney: false }, meta(owner()), clock)), 'CERTIFICATE_NOT_ACTIVE');
    expect(await expireDueCertificates(pool, at(cert.certificate))).toBe(0);
  });

  it('использованный → CERTIFICATE_USED; истёкший → CERTIFICATE_EXPIRED; без причины, чужой rowVersion, Администратор – отказ', async () => {
    const used = await sell(100_000);
    await redeem(used, 10_000);
    await fails(tx((t) => cancelSale(t, owner(), { certificateId: used.certificate.id, rowVersion: 1, reason: 'x', refundMoney: true }, meta(owner()), clock)), 'CERTIFICATE_USED');
    const fresh = await sell(100_000);
    const cancel = (who: AccessContext, extra: Partial<Parameters<typeof cancelSale>[2]> = {}, c: Clock = clock) =>
      tx((t) => cancelSale(t, who, { certificateId: fresh.certificate.id, rowVersion: 1, reason: 'ошибка', refundMoney: false, ...extra }, meta(who), c));
    await fails(cancel(owner(), {}, at(fresh.certificate)), 'CERTIFICATE_EXPIRED');
    await fails(cancel(owner(), { reason: '  ' }), 'COMMENT_REQUIRED');
    await fails(cancel(owner(), { rowVersion: 7 }), 'VERSION_CONFLICT');
    await fails(cancel(ctx('admin', await staff('admin'), [saleBranch])), 'FORBIDDEN');
    await fails(cancel(ctx('director', await staff('director'), [otherBranch])), 'NOT_FOUND');
    expect(await balanceOf(fresh.certificate.id)).toBe(100_000);
  });
});

describe('корректировка и «требует проверки» (K16 §6)', () => {
  it('Владелец: ± в пределах номинала; выше номинала – CORRECTION_EXCEEDS_NOMINAL; Директор – FORBIDDEN', async () => {
    const cert = await sell(100_000);
    await redeem(cert, 40_000);
    const correct = (who: AccessContext, rowVersion: number, deltaKop: number) =>
      tx((t) => correctBalance(t, who, { certificateId: cert.certificate.id, rowVersion, deltaKop, reason: 'ошибка кассира', ref: 'бронь №12' }, meta(who), clock));
    await fails(correct(owner(), 1, 40_001), 'CORRECTION_EXCEEDS_NOMINAL');
    await fails(correct(owner(), 1, -60_001), 'CERTIFICATE_INSUFFICIENT');
    await fails(correct(ctx('director', await staff('director'), [saleBranch]), 1, 1_000), 'FORBIDDEN');
    expect((await correct(owner(), 1, 40_000)).balanceKop).toBe(100_000);
    expect((await correct(owner(), 2, -5_000)).balanceKop).toBe(95_000);
    const e = await db.client.query(`SELECT basis FROM journal.ledger_entries WHERE entry_type = 'certificate.correction' AND amount = -5000`);
    expect(e.rows[0].basis).toBe('ошибка кассира (бронь №12)');
  });

  it('флаг включён – погашение запрещено, снят – разрешено; Администратор не ставит', async () => {
    const cert = await sell(100_000);
    const director = ctx('director', await staff('director'), [saleBranch]);
    const admin = ctx('admin', await staff('admin'), [saleBranch]);
    await fails(tx((t) => setReview(t, admin, { certificateId: cert.certificate.id, rowVersion: 1, on: true, reason: 'x' }, meta(owner()), clock)), 'FORBIDDEN');
    const on = await tx((t) => setReview(t, director, { certificateId: cert.certificate.id, rowVersion: 1, on: true, reason: 'спорная продажа' }, meta(director), clock));
    expect(on.status).toBe('needs_review');
    await fails(redeem(cert, 1_000), 'CERTIFICATE_NOT_ACTIVE');
    const off = await tx((t) => setReview(t, director, { certificateId: cert.certificate.id, rowVersion: 2, on: false, reason: 'проверено' }, meta(director), clock));
    expect(off.status).toBe('active');
    await redeem(cert, 1_000);
  });
});

describe('получатель (K16 §7)', () => {
  it('привязка и смена – строка истории; Администратор филиала предъявления может, чужой – NOT_FOUND', async () => {
    const cert = await sell(100_000);
    const second = (await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+79130000556', 'active', 'system') RETURNING id`)).rows[0].id as string;
    const link = (who: AccessContext, client: string | null, rowVersion: number, presentedBranchId?: string) =>
      tx((t) => linkRecipient(t, who, { certificateId: cert.certificate.id, clientId: client, rowVersion, presentedBranchId: presentedBranchId ?? null }, meta(who), clock));
    expect((await link(owner(), clientId, 1)).recipientClientId).toBe(clientId);
    const admin = ctx('admin', await staff('admin'), [otherBranch]);
    await fails(link(admin, second, 2), 'NOT_FOUND');
    expect((await link(admin, second, 2, otherBranch)).recipientClientId).toBe(second);
    await fails(link(owner(), 'не-uuid', 3), 'VALIDATION_FAILED');
    const h = await db.client.query(`SELECT old_client_id, new_client_id FROM journal.certificate_holder_history WHERE certificate_id = $1 ORDER BY id`, [cert.certificate.id]);
    expect(h.rows).toEqual([
      { old_client_id: null, new_client_id: clientId },
      { old_client_id: clientId, new_client_id: second },
    ]);
  });
});
