// S4-67: отчёт «Лояльность» (K24 §3.7, 14 §10). Начисление и его сторно – в своей строке; штраф с обрезкой у −50 (TC-10) виден как −2;
// баланс на прошлую дату = Σ записей; детализация = итог; запись без филиала – только в сетевой области; права.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { createBatch, openAccount, postPoints, reverseWithBatches, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { applyPenalty } from '../../apps/api/src/modules/loyalty/penalty.ts';
import { loyaltyDefs, loyaltyDetail, loyaltyReport, type LoyaltyMetric } from '../../apps/api/src/modules/reports/loyalty.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, SYS, type Fx } from '../helpers/reports.ts';

const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
const AT = new Date('2026-10-10T05:00:00Z');
let db: TestDatabase;
let fx: Fx;
let b1: string;
let b2: string;
let res1: string;
let rich: string;
let debtor: string;
let accrualEntry: number;

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
const post = (client: string, amount: number, type: string, branchId: string | null, at: Date, allow = false) =>
  tx(async (t) => {
    await openAccount(t, client, at);
    return postPoints(t, client, { amount, type: type as 'loyalty.accrual', branchId, basis: 'тест', occurredAt: at }, randomUUID(), allow ? { type: 'staff', id: fx.ownerId } : SYSTEM_AUTHOR, allow ? { reason: 'тест' } : undefined);
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  b1 = (await fx.branch('Asia/Novosibirsk')).id;
  b2 = (await fx.branch('Europe/Moscow')).id;
  res1 = await fx.resource(b1, 'pc', 'ПК', []);
  const res2 = await fx.resource(b2, 'pc', 'ПК2', []);
  rich = await fx.client({ firstName: 'Богатый' });
  debtor = await fx.client({ firstName: 'Должник' });
  // сентябрь: начисление 100 баллов богатому – баланс на конец сентября
  const sep = await post(rich, 10_000, 'loyalty.accrual', b1, new Date('2026-09-15T05:00:00Z'));
  await tx((t) => createBatch(t, { clientId: rich, entryId: sep.entryId, amount: 10_000, balanceBefore: 0, source: 'visit', branchId: b1, expiresAt: null, accruedAt: new Date('2026-09-15T05:00:00Z') }));
  // октябрь: начисление 50 и его сторно, начисление 20, списание на время и на товар, возврат, ручная корректировка без филиала
  const wrong = await post(rich, 5_000, 'loyalty.accrual', b1, AT);
  await tx((t) => createBatch(t, { clientId: rich, entryId: wrong.entryId, amount: 5_000, balanceBefore: 10_000, source: 'visit', branchId: b1, expiresAt: null, accruedAt: AT }));
  accrualEntry = wrong.entryId;
  await tx((t) => reverseWithBatches(t, { clientId: rich, entryId: accrualEntry, reason: 'ошибка', idempotencyKey: randomUUID(), author: SYSTEM_AUTHOR, occurredAt: new Date('2026-10-11T05:00:00Z') }));
  await post(rich, 2_000, 'loyalty.accrual', b1, AT);
  await post(rich, -600, 'loyalty.spend_time', b1, AT);
  await post(rich, -300, 'loyalty.spend_goods', b1, AT);
  await post(rich, 100, 'loyalty.return', b1, AT);
  await post(rich, 50, 'loyalty.manual', null, AT);
  // TC-10: баланс −48, неявка: штраф обрезается до −2, итог −50 (блокировка); клиент на пороге – отдельно
  await post(debtor, -4_800, 'loyalty.manual', b2, new Date('2026-09-20T05:00:00Z'), true);
  const bk = await fx.booking({ branchId: b1, clientId: debtor, resourceId: res1, start: '2026-10-12T05:00:00Z', status: 'no_show' });
  const noShowId = await fx.noShow(bk, '2026-10-12T06:00:00Z');
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('loyalty.penalties_from', 'network', $1, '2026-01-01', $2)`, [JSON.stringify('2026-01-01T00:00:00Z'), SYS]);
  const penalty = await tx((t) => applyPenalty(t, { noShowId, bookingId: bk, markedAt: new Date('2026-10-12T06:00:00Z') }, { bookings: paymentBookingProvider, clock: fixedClock('2026-10-12T06:00:00Z') }));
  expect(penalty).toBe('active');
  const warn = await fx.client({ firstName: 'Порог' });
  await post(warn, -4_600, 'loyalty.manual', b2, new Date('2026-10-13T05:00:00Z'), true);
  await fx.booking({ branchId: b2, clientId: warn, resourceId: res2, start: '2026-10-13T05:00:00Z' });
  await fx.booking({ branchId: b1, clientId: rich, resourceId: res1, start: '2026-10-13T05:00:00Z' });
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('лояльность (S4-67)', () => {
  it('начисление и его сторно в своей строке; виды раздельно; штраф TC-10 виден как −2', async () => {
    const r = await fx.run(fx.owner(), (env) => loyaltyReport(env, { period: OCT }));
    const m = r.metrics;
    expect(val(m.accrued)).toBe(2_000); // 5 000 − 5 000 + 2 000
    expect(val(m.spentTime)).toBe(-600);
    expect(val(m.spentGoods)).toBe(-300);
    expect(val(m.returned)).toBe(100);
    expect(val(m.penalties)).toBe(-200);
    expect(val(m.adjusted)).toBe(50 - 4_600);
    expect(val(m.expired)).toBe(0);
    expect(m.accrued).toMatchObject({ unit: 'centi', prev: 10_000 });
    expect(r.labels.notMoney).toContain('не входят');
  });

  it('баланс на прошлую дату = Σ записей; сегодня – rpt_loyalty_balances; категории и пороги', async () => {
    const past = await fx.run(fx.owner(), (env) => loyaltyReport(env, { period: OCT }));
    const bal = (await db.client.query<{ client_id: string; b: string }>(`SELECT client_id, balance_centi::text AS b FROM app.rpt_loyalty_balances`)).rows;
    const sum = bal.reduce((s, x) => s + Number(x.b), 0);
    expect(val(past.metrics.totalBalance)).toBe(sum); // после 31.10 движений нет
    expect(val(past.metrics.clientsBlocked)).toBe(1); // должник: −48 − 2 = −50
    expect(val(past.metrics.clientsAtThreshold)).toBe(1); // −46
    expect(val(past.metrics.clientsPositive)).toBe(1);
    expect(val(past.metrics.clientsNegative)).toBe(2);
    // конец сентября: богатый +100, должник −48
    const sep = await fx.run(fx.owner(), (env) => loyaltyReport(env, { period: { from: d('2026-09-01'), to: d('2026-09-30') } }));
    expect(val(sep.metrics.totalBalance)).toBe(10_000 - 4_800);
    expect(val(sep.metrics.clientsBlocked)).toBe(0);
    expect(val(sep.metrics.clientsAtThreshold)).toBe(1); // должник −48 ещё не заблокирован, но на пороге
    // сегодняшний период – текущие балансы
    const now = await fx.run(fx.owner(), (env) => loyaltyReport(env, { period: { from: d('2026-11-01'), to: d('2026-11-30') } }));
    expect(val(now.metrics.totalBalance)).toBe(sum);
    expect(val(now.metrics.clientsBlocked)).toBe(1);
  });

  it('детализация = итог по каждому показателю; сторно – строкой минус; маска клиента', async () => {
    const report = await fx.run(fx.owner(), (env) => loyaltyReport(env, { period: OCT }));
    for (const key of [...Object.keys(loyaltyDefs()), 'clientsPositive', 'clientsNegative', 'clientsAtThreshold', 'clientsBlocked', 'totalBalance'] as LoyaltyMetric[]) {
      const rows: Array<{ value: number }> = [];
      let cursor: string | undefined;
      do {
        const page = await fx.run(fx.owner(), (env) => loyaltyDetail(env, { period: OCT }, key, { limit: 2, ...(cursor ? { cursor } : {}) }));
        rows.push(...page.rows);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (val(report.metrics[key]) === 0) expect(rows, key).toEqual([]);
      else expect(rows.reduce((s, x) => s + x.value, 0), key).toBe(val(report.metrics[key]));
    }
    const acc = await fx.run(fx.director([b1]), (env) => loyaltyDetail(env, { period: OCT }, 'accrued'));
    const rev = acc.rows.filter((x) => x.isReversal);
    expect(rev).toEqual([expect.objectContaining({ type: 'accrual', value: -5_000 })]);
    const adj = await fx.run(fx.owner(), (env) => loyaltyDetail(env, { period: OCT }, 'adjusted'));
    expect(adj.rows.some((x) => x.value === 50)).toBe(true); // без филиала – в сетевой области
    expect(adj.total).toMatchObject({ value: 50 - 4_600 });
  });

  it('Директор зоны: только движения своих филиалов и балансы клиентов зоны; запись без филиала не видна; Администратору закрыто', async () => {
    const dir = fx.director([b1]);
    const r = await fx.run(dir, (env) => loyaltyReport(env, { period: OCT }));
    expect(val(r.metrics.adjusted)).toBe(0); // корректировка без филиала и b2 не входят
    expect(val(r.metrics.penalties)).toBe(-200);
    expect(val(r.metrics.clientsAtThreshold)).toBe(0); // клиент порога – в зоне b2
    expect(val(r.metrics.clientsBlocked)).toBe(1); // должник – с бронью в b1
    await expect(fx.run(dir, (env) => loyaltyReport(env, { period: OCT, branchIds: [b2] }))).rejects.toMatchObject({ httpStatus: 404 });
    await expect(fx.run(fx.admin([b1]), (env) => loyaltyReport(env, { period: OCT }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const empty = await fx.run(fx.owner(), (env) => loyaltyReport(env, { period: { from: d('2026-03-01'), to: d('2026-03-31') } }));
    expect(empty.metrics.accrued).toEqual({ state: 'no_data' });
    expect(empty.metrics.totalBalance).toEqual({ state: 'no_data' });
  });
});
