// K24 §3.4, §3.8: неденежная оплата с частичным возвратом считается за вычетом возвращённого; погашение, возвращённое целиком, не делает сертификат «частично погашенным».
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { certificatesDetail, certificatesReport } from '../../apps/api/src/modules/reports/certificates.ts';
import { financeDetail, financeReport } from '../../apps/api/src/modules/reports/finance.ts';
import { createTestPayment } from '../helpers/payment.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, SYS, type Fx } from '../helpers/reports.ts';

const PEPPER = 'cert-pepper-'.padEnd(40, 'c');
const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
const AT = '2026-10-05T05:00:00Z';
const clock = fixedClock(AT);
let db: TestDatabase;
let fx: Fx;
const val = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);

async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await fx.app.connect();
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
const sell = (branchId: string, nominalKop: number) => {
  const o: AccessContext = fx.owner();
  return tx((t) => sellCertificate(t, o, { branchId, nominalKop, method: 'card' }, { actor: o.actor, access: o, source: 'crm', requestId: randomUUID() }, { pepper: PEPPER, clock }));
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('возвраты в отчётах', () => {
  it('оплата баллами с частичным возвратом и сертификатом с возвратом целиком: итог и строки за вычетом возвращённого', async () => {
    const { id: branch } = await fx.branch();
    const res = await fx.resource(branch, 'pc', 'ПК', []);
    const client = await fx.client();
    const line = async (method: 'points' | 'certificate', amountKop: number, opts: { points?: number; certificateId?: string; refund: number; refundPoints?: number }) => {
      const booking = await fx.booking({ branchId: branch, clientId: client, resourceId: res, start: AT, priceKop: amountKop });
      const paymentId = await createTestPayment(db.client, booking);
      await db.client.query(`UPDATE app.payments SET status = 'partially_refunded', recorded_at = $2 WHERE id = $1`, [paymentId, AT]);
      await db.client.query(
        `INSERT INTO app.payment_lines (payment_id, line_no, method, amount_kop, points_centi, certificate_id, ledger_posting_id) VALUES ($1, 1, $2, $3, $4, $5, gen_random_uuid())`,
        [paymentId, method, amountKop, opts.points ?? null, opts.certificateId ?? null],
      );
      await db.client.query(
        `INSERT INTO app.payment_refunds (payment_id, line_no, seq, amount_kop, points_centi, reason, outcome, ledger_posting_id, created_by, created_at)
         VALUES ($1, 1, 1, $2, $3, 'т', 'returned', gen_random_uuid(), $4, $5)`,
        [paymentId, opts.refund, opts.refundPoints ?? null, SYS, AT],
      );
    };
    const cert = await sell(branch, 10_000);
    await line('points', 1_000, { points: 1_000, refund: 300, refundPoints: 300 });
    await line('certificate', 5_000, { certificateId: cert.certificate.id, refund: 5_000 });
    const r = await fx.run(fx.owner(), (env) => financeReport(env, { period: OCT, branchIds: [branch] }));
    expect(val(r.metrics.nonMoneyPoints)).toBe(700);
    expect(val(r.metrics.nonMoneyCertificate)).toBe(0);
    const detail = await fx.run(fx.owner(), (env) => financeDetail(env, { period: OCT, branchIds: [branch] }, 'nonMoneyPoints'));
    expect(val(detail.total)).toBe(700);
    expect(detail.rows.map((x) => x.value)).toEqual([700]);
  });

  it('погашение, возвращённое целиком, – не «частично погашен»; непогашенный остаток считается погашенным только при живом погашении', async () => {
    const { id: branch } = await fx.branch();
    const res = await fx.resource(branch, 'pc', 'ПК', []);
    const client = await fx.client();
    const handler = createCertificatePaymentMethod({ pepper: PEPPER });
    const redeem = async (c: { certificate: { number: string; id: string }; pin: string }, amountKop: number) => {
      const id = await fx.booking({ branchId: branch, clientId: client, resourceId: res, start: AT, status: 'arrived', priceKop: amountKop });
      const paymentId = await createTestPayment(db.client, id);
      const session = { id, bookingId: id, branchId: branch, clientId: client, amountDueKop: amountKop, bookingVersion: 1, status: 'unpaid' as const, activePaymentId: null, rowVersion: 1 };
      return tx((t) =>
        handler.charge(t, {
          session, lineNo: 1, amountKop, minutes: 60, resourceType: 'pc', certificate: { number: c.certificate.number, pin: c.pin },
          idempotencyKey: `payment:${id}:1:1`, author: { type: 'staff', id: fx.ownerId }, occurredAt: new Date(AT), mode: 'exact', paymentId,
        }),
      );
    };
    const returned = await sell(branch, 10_000);
    const charged = await redeem(returned, 3_000);
    await tx((t) =>
      handler.refund(t, {
        line: { lineNo: 1, method: 'certificate', amountKop: 3_000, certificateId: returned.certificate.id, ledgerPostingId: charged.postingId },
        amountKop: 3_000, idempotencyKey: `refund:${randomUUID()}`, author: { type: 'staff', id: fx.ownerId }, occurredAt: new Date(AT), reason: 'ошибка способа',
      }),
    );
    const partial = await sell(branch, 10_000);
    await redeem(partial, 4_000);
    const p = { period: OCT, branchIds: [branch] };
    const report = await fx.run(fx.owner(), (env) => certificatesReport(env, p));
    expect(val(report.metrics.activeCount)).toBe(2);
    expect(val(report.metrics.partiallyRedeemed)).toBe(1);
    const page = await fx.run(fx.owner(), (env) => certificatesDetail(env, p, 'partiallyRedeemed'));
    expect(page.rows.map((x) => x.certificateId)).toEqual([partial.certificate.id]);
  });
});
