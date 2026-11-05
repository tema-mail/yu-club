// S4-65: отчёт «Финансы и касса» (K24 §3.4, 14 §7). Остаток конец = формула 14 §7.2 по каждому месту; продажа сертификата –
// поступление, погашение – нет; баллы – отдельным блоком; поступление и его сторно → 0; возврат – отдельной строкой;
// те же цифры, что у сводки K17 §9; детализация = итог по каждому показателю; Администратор – FORBIDDEN, чужая зона – 404.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { postMoneyOperation, recordExpense, recordIncome, recordOpeningBalance, recordWithdrawal, transferBetweenPlaces } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { branchSummary } from '../../apps/api/src/modules/finance/summary.ts';
import { financeDefs, financeDetail, financeReport, type FinanceMetric } from '../../apps/api/src/modules/reports/finance.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const clock = fixedClock('2026-11-20T05:00:00Z');
const NOV = { from: d('2026-11-01'), to: d('2026-11-30') };
const DAY = '2026-11-15T04:00:00Z';
let db: TestDatabase;
let fx: Fx;
let b1: string;
let b2: string;
let cat: Record<string, string> = {};
const sys = { kind: 'system' as const, process: 'test' };
const sysMeta: AuditRequestMeta = { actor: { kind: 'system', process: 'test' }, source: 'system', requestId: 'test' };

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
const cmd = (fn: typeof recordIncome, body: object) => {
  const o = fx.owner(clock.now());
  return tx((t) => fn(t, o, body, { actor: o.actor, access: o, source: 'crm', requestId: randomUUID() }, { idempotencyKey: randomUUID(), clock }));
};
const val = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  cat = Object.fromEntries((await db.client.query<{ id: string; name: string }>(`SELECT id, name FROM app.finance_categories WHERE name IN ('Прочее', 'Коммунальные', 'Электричество')`)).rows.map((x) => [x.name, x.id]));
  b1 = (await fx.branch('Asia/Novosibirsk')).id;
  b2 = (await fx.branch('Europe/Moscow')).id;
  await cmd(recordOpeningBalance, { branchId: b1, place: 'cash', amountKop: 100_000, date: '2026-10-01', comment: 'старт' });
  // октябрь – прошлый период
  await cmd(recordIncome, { branchId: b1, method: 'cash', amountKop: 7_000, source: 'other', occurredAt: '2026-10-10T04:00:00Z' });
  // ноябрь
  await cmd(recordIncome, { branchId: b1, method: 'cash', amountKop: 5_000, source: 'event', occurredAt: DAY });
  const wrong = await cmd(recordIncome, { branchId: b1, method: 'card', amountKop: 3_000, source: 'other', occurredAt: DAY });
  await tx((t) => { const o = fx.owner(clock.now()); return reverseOperation(t, o, { operationId: wrong.id, reason: 'ошибка' }, { actor: o.actor, access: o, source: 'crm', requestId: randomUUID() }, { idempotencyKey: randomUUID(), clock }); });
  // продажа сертификата – поступление certificate_sale картой на дату DAY
  const saleOwner = fx.owner(clock.now());
  const sold = await tx((t) => sellCertificate(t, saleOwner, { branchId: b1, nominalKop: 50_000, method: 'card' }, { actor: saleOwner.actor, access: saleOwner, source: 'crm', requestId: randomUUID() }, { pepper: 'cert-pepper-'.padEnd(40, 'f'), clock: fixedClock(DAY) }));
  await cmd(recordExpense, { branchId: b1, method: 'cash', amountKop: 1_000, categoryId: cat['Прочее'], occurredAt: DAY, comment: 'мелочи' });
  await cmd(recordExpense, { branchId: b1, method: 'card', amountKop: 2_000, categoryId: cat['Коммунальные'], subcategoryId: cat['Электричество'], occurredAt: DAY, comment: 'свет' });
  await cmd(recordWithdrawal, { branchId: b1, amountKop: 500, occurredAt: DAY, comment: 'изъятие' });
  await cmd(transferBetweenPlaces, { branchId: b1, from: 'cash', amountKop: 4_000, occurredAt: DAY, comment: 'на счёт' });
  const session = await tx((t) => postMoneyOperation(t, sys, { branchId: b1, kind: 'income', place: 'cash', method: 'cash', amountKop: 30_000, source: 'session', ref: { type: 'payment', id: randomUUID() }, occurredAt: new Date(DAY) }, { idempotencyKey: randomUUID() }, sysMeta, clock));
  await tx((t) => postMoneyOperation(t, sys, { branchId: b1, kind: 'refund', place: 'cash', method: 'cash', amountKop: 10_000, comment: 'возврат', ref: { type: 'operation', id: session.id }, occurredAt: new Date(DAY) }, { idempotencyKey: randomUUID() }, sysMeta, clock));
  // оплата баллами и сертификатом: платёж сеанса, в кассе не видна
  const client = await fx.client();
  const res = await fx.resource(b1, 'pc', 'ПК', []);
  for (const [method, centi, line] of [['points', 6_000, 30_000], ['certificate', null, 40_000]] as const) {
    const bk = await fx.booking({ branchId: b1, clientId: client, resourceId: res, start: DAY, status: 'arrived', priceKop: line });
    await db.client.query(`INSERT INTO app.payment_sessions (booking_id, branch_id, client_id, amount_due_kop, booking_version, status) VALUES ($1, $2, $3, $4, 1, 'paid')`, [bk, b1, client, line]);
    const p = (await db.client.query<{ id: string }>(`INSERT INTO app.payments (session_id, attempt, total_kop, topup_rule_snapshot, recorded_by, recorded_at) VALUES ($1, 1, $2, false, gen_random_uuid(), $3) RETURNING id`, [bk, line, DAY])).rows[0]!.id;
    await db.client.query(`INSERT INTO app.payment_lines (payment_id, line_no, method, amount_kop, points_centi, certificate_id, ledger_posting_id) VALUES ($1, 1, $2, $3, $4, $5, gen_random_uuid())`, [p, method, line, centi, method === 'certificate' ? sold.certificate.id : null]);
  }
  await cmd(recordIncome, { branchId: b2, method: 'transfer', amountKop: 9_000, source: 'other', occurredAt: DAY });
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('финансы (S4-65)', () => {
  it('показатели: источник, сторно в своей строке, возврат отдельно, чистое движение; баллы – не деньги', async () => {
    const r = await fx.run(fx.owner(), (env) => financeReport(env, { period: NOV, branchIds: [b1] }));
    const m = r.metrics;
    expect(val(m.income)).toBe(5_000 + 30_000 + 50_000); // сторно карты 3 000 обнулило себя
    expect(val(m.incomeSession)).toBe(30_000);
    expect(val(m.incomeEvent)).toBe(5_000);
    expect(val(m.incomeCertificateSale)).toBe(50_000);
    expect(val(m.incomeOther)).toBe(0);
    expect(val(m.refunds)).toBe(10_000);
    expect(val(m.expenses)).toBe(3_000);
    expect(val(m.withdrawals)).toBe(500);
    expect(val(m.transfers)).toBe(4_000);
    expect(val(m.netMovement)).toBe(85_000 - 10_000 - 3_000);
    expect(val(m.nonMoneyPoints)).toBe(6_000);
    expect(m.nonMoneyPoints).toMatchObject({ unit: 'centi' });
    expect(val(m.nonMoneyCertificate)).toBe(40_000);
    expect(m.income).toMatchObject({ prev: 7_000 });
    expect(r.incomeByMethod).toEqual([{ method: 'card', amountKop: 50_000 }, { method: 'cash', amountKop: 35_000 }]);
    expect(new Map(r.expenseByCategory.map((c) => [c.name, c.amountKop]))).toEqual(new Map([['Коммунальные', 2_000], ['Прочее', 1_000]]));
    expect(r.expenseByCategory.find((c) => c.name === 'Коммунальные')!.sub).toEqual([expect.objectContaining({ name: 'Электричество', amountKop: 2_000 })]);
  });

  it('остаток конец = формула 14 §7.2 по каждому месту; остаток на конец октября = остаток на начало ноября', async () => {
    const r = await fx.run(fx.owner(), (env) => financeReport(env, { period: NOV, branchIds: [b1] }));
    expect(r.places.map((p) => p.place)).toEqual(['cash', 'noncash']);
    for (const p of r.places) {
      expect(p.closingKop, p.place).toBe(p.openingKop + p.incomeKop - p.refundKop - p.expenseKop - p.withdrawalKop + p.transferInKop - p.transferOutKop + p.correctionKop);
    }
    const cash = r.places[0]!;
    expect(cash).toMatchObject({ openingKop: 107_000, incomeKop: 35_000, refundKop: 10_000, expenseKop: 1_000, withdrawalKop: 500, transferOutKop: 4_000, closingKop: 126_500 });
    expect(r.places[1]).toMatchObject({ openingKop: 0, incomeKop: 50_000, expenseKop: 2_000, transferInKop: 4_000, closingKop: 52_000 });
    expect(val(r.metrics.cashClosing)).toBe(126_500 + 52_000);
    const oct = await fx.run(fx.owner(), (env) => financeReport(env, { period: { from: d('2026-10-01'), to: d('2026-10-31') }, branchIds: [b1] }));
    expect(val(oct.metrics.cashClosing)).toBe(val(r.metrics.cashOpening));
    const bal = (await db.client.query(`SELECT sum(balance)::int AS s FROM app.ledger_accounts WHERE owner_id = $1 AND kind IN ('cash_branch', 'cash_branch_noncash')`, [b1])).rows[0].s;
    expect(val(r.metrics.cashClosing)).toBe(bal);
  });

  it('те же цифры, что у сводки K17 §9 (одна формула), сводка читает rpt_finance_operations', async () => {
    const s = await branchSummary(fx.app, fx.owner(clock.now()), { branchId: b1, from: NOV.from, to: NOV.to });
    const r = await fx.run(fx.owner(), (env) => financeReport(env, { period: NOV, branchIds: [b1] }));
    expect(val(r.metrics.income)).toBe(s.total.incomeKop);
    expect(val(r.metrics.expenses)).toBe(s.total.expenseKop);
    expect(val(r.metrics.netMovement)).toBe(s.total.resultKop);
    expect(val(r.metrics.cashOpening)).toBe(s.total.openingKop);
    expect(val(r.metrics.cashClosing)).toBe(s.total.closingKop);
    expect(s.places.map((x) => x.closingKop)).toEqual(r.places.map((x) => x.closingKop));
  });

  it('детализация = итог по каждому показателю, сторно – строкой со знаком минус и видом исходной', async () => {
    const p = { period: NOV, branchIds: [b1] };
    const report = await fx.run(fx.owner(), (env) => financeReport(env, p));
    const keys = [...Object.keys(financeDefs(p)), 'cashOpening', 'cashClosing'] as Array<FinanceMetric | 'cashOpening' | 'cashClosing'>;
    for (const key of keys) {
      const rows: Array<{ value: number }> = [];
      let cursor: string | undefined;
      do {
        const page = await fx.run(fx.owner(), (env) => financeDetail(env, p, key, { limit: 3, ...(cursor ? { cursor } : {}) }));
        rows.push(...(page.rows as Array<{ value: number }>));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(rows.reduce((s, x) => s + x.value, 0), key).toBe(val(report.metrics[key]));
    }
    const other = await fx.run(fx.owner(), (env) => financeDetail(env, p, 'income'));
    const rows = other.rows as Array<{ isReversal: boolean; value: number; kind: string; source: string }>;
    expect(rows.filter((x) => x.isReversal)).toEqual([expect.objectContaining({ kind: 'income', source: 'other', value: -3_000 })]);
  });

  it('права: Администратор – FORBIDDEN; Директор зоны – своё, чужое 404, сеть сужается; сеть – сумма филиалов', async () => {
    await expect(fx.run(fx.admin([b1]), (env) => financeReport(env, { period: NOV }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fx.run(fx.director([b2]), (env) => financeReport(env, { period: NOV, branchIds: [b1] }))).rejects.toMatchObject({ httpStatus: 404 });
    expect(val((await fx.run(fx.director([b2]), (env) => financeReport(env, { period: NOV }))).metrics.income)).toBe(9_000);
    expect(val((await fx.run(fx.owner(), (env) => financeReport(env, { period: NOV }))).metrics.income)).toBe(94_000);
    const empty = await fx.run(fx.owner(), (env) => financeReport(env, { period: { from: d('2026-01-01'), to: d('2026-01-31') }, branchIds: [b2] }));
    expect(empty.metrics.income).toEqual({ state: 'no_data' });
    expect(empty.metrics.cashClosing).toEqual({ state: 'no_data' });
  });
});
