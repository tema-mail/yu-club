// S4-61: миграция 0407 (K24 §1, §3.4, §3.7, §3.8) – денежные представления. Данные – командами модулей (как S2-80):
// поступление + сторно → Σ signed = 0 в строке исходного вида; сертификат: продажа, погашение, сгорание – по одной строке;
// сверка с reconcile.ts (rpt_cash_places) на тех же данных: Σ движений мест по rpt_finance_operations = operations_sum.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { expireDueCertificates } from '../../apps/api/src/modules/certificates/lifecycle.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { sellCertificate, type CertificateDto } from '../../apps/api/src/modules/certificates/sale.ts';
import { recordExpense, recordIncome, recordOpeningBalance, transferBetweenPlaces } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { adjust } from '../../apps/api/src/modules/loyalty/adjust.ts';
import { runReconcile } from '../../apps/api/src/modules/reports/reconcile.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestPayment } from '../helpers/payment.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PEPPER = 'cert-pepper-'.padEnd(40, 'm');
const T0 = new Date('2026-11-14T05:00:00Z');
const clock = fixedClock(T0);
let db: TestDatabase;
let pool: pg.Pool;
let ownerId: string;
let branchId: string;
let clientA: string;
let incomeId: string;
let certId: string;

const owner = (): AccessContext => ({ actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: T0 });
const meta = (): AuditRequestMeta => ({ actor: owner().actor, access: owner(), source: 'crm', requestId: randomUUID() });
const opts = () => ({ idempotencyKey: randomUUID(), clock });

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

async function redeem(cert: { certificate: CertificateDto; pin: string }, amountKop: number, resourceId: string) {
  const handler = createCertificatePaymentMethod({ pepper: PEPPER });
  const id = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
       VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-11-14T04:00:00Z', '2026-11-14T05:00:00Z', '[)'), 300000, 'crm', 'staff', 'arrived') RETURNING id`,
      [branchId, clientA, resourceId],
    )
  ).rows[0]!.id;
  const paymentId = await createTestPayment(db.client, id);
  const session = { id, bookingId: id, branchId, clientId: clientA, amountDueKop: amountKop, bookingVersion: 1, status: 'unpaid' as const, activePaymentId: null, rowVersion: 1 };
  await tx((t) =>
    handler.charge(t, {
      session, lineNo: 1, amountKop, minutes: 60, resourceType: 'pc', certificate: { number: cert.certificate.number, pin: cert.pin },
      idempotencyKey: `payment:${id}:1:1`, author: { type: 'staff', id: ownerId }, occurredAt: T0, mode: 'exact', paymentId,
    }),
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  ownerId = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', $1, 'owner', 'x') RETURNING id`, [`${randomUUID()}@club.ru`])).rows[0]!.id;
  branchId = (await createTestBranch(db.client)).id;
  clientA = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000901', 'К', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
  const resourceId = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [branchId])).rows[0]!.id;
  const category = (await db.client.query<{ id: string }>(`INSERT INTO app.finance_categories (kind, name) VALUES ('expense', 'Хозтовары') RETURNING id`)).rows[0]!.id;

  await tx((t) => recordOpeningBalance(t, owner(), { branchId, place: 'cash', amountKop: 1_000_000, date: '2026-11-01', comment: 'остаток' }, meta(), opts()));
  incomeId = (await tx((t) => recordIncome(t, owner(), { branchId, method: 'card', amountKop: 30_000, source: 'extra_service', occurredAt: T0.toISOString(), comment: 'услуга' }, meta(), opts()))).id;
  await tx((t) => reverseOperation(t, owner(), { operationId: incomeId, reason: 'ошибка' }, meta(), opts()));
  await tx((t) => recordExpense(t, owner(), { branchId, method: 'cash', amountKop: 5_000, categoryId: category, occurredAt: T0.toISOString(), comment: 'мыло' }, meta(), opts()));
  const tr = await tx((t) => transferBetweenPlaces(t, owner(), { branchId, from: 'cash', amountKop: 200_000, occurredAt: T0.toISOString(), comment: 'инкассация' }, meta(), opts()));
  await tx((t) => reverseOperation(t, owner(), { operationId: tr.id, reason: 'ошибка' }, meta(), opts()));
  await tx((t) => transferBetweenPlaces(t, owner(), { branchId, from: 'cash', amountKop: 70_000, occurredAt: T0.toISOString(), comment: 'в банк' }, meta(), opts()));

  const c1 = await tx((t) => sellCertificate(t, owner(), { branchId, nominalKop: 500_000, method: 'cash' }, meta(), { pepper: PEPPER, clock }));
  certId = c1.certificate.id;
  await redeem(c1, 100_000, resourceId);
  expect(await expireDueCertificates(pool, fixedClock(new Date(new Date(c1.certificate.expiresAt).getTime() + 1000)))).toBe(1);

  await tx((t) => adjust(t, owner(), { clientId: clientA, deltaCenti: 1000, reason: 'подарок' }, meta(), clock));
  await tx((t) => adjust(t, owner(), { clientId: clientA, deltaCenti: -300, reason: 'исправление' }, meta(), clock));
}, 60_000);

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('0407 rpt_money (S4-61)', () => {
  it('поступление и его сторно: обе строки вида income, Σ signed_kop = 0, источник и способ – исходные', async () => {
    const rows = (await db.client.query(`SELECT kind, original_kind, source, method, signed_kop::int AS s, is_reversed FROM app.rpt_finance_operations WHERE operation_id = $1 OR reversal_of = $1 ORDER BY number`, [incomeId])).rows;
    expect(rows).toEqual([
      { kind: 'income', original_kind: 'income', source: 'extra_service', method: 'card', s: 30_000, is_reversed: true },
      { kind: 'reversal', original_kind: 'income', source: 'extra_service', method: 'card', s: -30_000, is_reversed: false },
    ]);
    const sum = (await db.client.query(`SELECT sum(signed_kop)::int AS s FROM app.rpt_finance_operations WHERE original_kind = 'income' AND source = 'extra_service'`)).rows[0].s;
    expect(sum).toBe(0);
  });

  it('сертификат: продажа, погашение, сгорание – по одной строке; погашение – филиал сеанса и бронь', async () => {
    const ops = (await db.client.query(`SELECT op, amount_kop::int AS a, branch_id, booking_id IS NOT NULL AS has_booking FROM app.rpt_certificate_ops WHERE certificate_id = $1 ORDER BY at, op`, [certId])).rows;
    expect(ops.map((o) => o.op).sort()).toEqual(['expire', 'redeem', 'sale']);
    expect(ops.find((o) => o.op === 'sale')!.a).toBe(500_000);
    expect(ops.find((o) => o.op === 'redeem')).toMatchObject({ a: 100_000, branch_id: branchId, has_booking: true });
    expect(ops.find((o) => o.op === 'expire')!.a).toBe(400_000);
    // продажа – поступление кассы certificate_sale, погашение в кассе не видно (K24 §3.8)
    const fin = (await db.client.query(`SELECT count(*)::int AS n FROM app.rpt_finance_operations WHERE source = 'certificate_sale'`)).rows[0].n;
    expect(fin).toBe(1);
    // строки платежей (rpt_payments) пишет оплата K10 – их проверяет отчёт 3.2/3.4 (S4-63, S4-65)
    expect((await db.client.query(`SELECT count(*)::int AS n FROM app.rpt_payments`)).rows[0].n).toBe(0);
  });

  it('баллы: начисление и списание вручную – вид adjust, Σ = баланс; blocked при ≤ −50', async () => {
    const moves = (await db.client.query(`SELECT entry_type, original_type, amount_centi::int AS a FROM app.rpt_loyalty_moves WHERE client_id = $1 ORDER BY entry_id`, [clientA])).rows;
    expect(moves.every((m) => m.original_type === 'adjust')).toBe(true);
    expect(moves.reduce((s, m) => s + m.a, 0)).toBe(700);
    expect((await db.client.query(`SELECT balance_centi::int AS b, available_centi::int AS av, blocked FROM app.rpt_loyalty_balances WHERE client_id = $1`, [clientA])).rows[0]).toEqual({ b: 700, av: 700, blocked: false });
  });

  it('сверка с reconcile.ts: Σ движений мест по rpt_finance_operations = operations_sum rpt_cash_places, сверка чистая', async () => {
    const mine = (
      await db.client.query<{ place: string; s: string }>(
        `SELECT place, sum(d)::text AS s FROM (
           SELECT place, delta_kop AS d FROM app.rpt_finance_operations WHERE branch_id = $1
           UNION ALL SELECT counter_place, -delta_kop FROM app.rpt_finance_operations WHERE branch_id = $1 AND counter_place IS NOT NULL
         ) x GROUP BY place ORDER BY place`,
        [branchId],
      )
    ).rows;
    const theirs = (await db.client.query<{ place: string; s: string }>(`SELECT place, operations_sum::text AS s FROM app.rpt_cash_places WHERE branch_id = $1 ORDER BY place`, [branchId])).rows;
    expect(mine).toEqual(theirs);
    expect(mine).toEqual([
      { place: 'cash', s: String(1_000_000 - 5_000 - 70_000 + 500_000) },
      { place: 'noncash', s: '70000' },
    ]);
    const r = (await runReconcile(pool, { trigger: 'manual', clock, logger: { error: () => {}, info: () => {} } }))!;
    expect(r.discrepancies).toEqual([]);
  });

  it('yu_reports читает денежные представления, кассу напрямую – нет', async () => {
    const c = new pg.Client({ connectionString: db.reportsUrl });
    await c.connect();
    try {
      expect((await c.query(`SELECT count(*)::int AS n FROM app.rpt_finance_operations`)).rows[0].n).toBeGreaterThan(5);
      await expect(c.query(`SELECT 1 FROM journal.ledger_entries`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });
});
