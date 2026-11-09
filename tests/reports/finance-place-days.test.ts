// S4-131, 0418: остаток мест денег из дневных сумм = прежний расчёт перебором всего журнала (K24 §3.4 «Σ движений до t»).
// Филиал в UTC+7: граница суток филиала – середина суток UTC, поэтому работает и добор неполных суток из журнала. Операции – прямо
// в журнал (как синтетика нагрузки): приход, расход, изъятие, перевод между местами, сторно перевода, начальный остаток в периоде,
// операции у самой границы. Дневные суммы пишет триггер; сверка – с группировкой rpt_finance_operations.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financeReport, type PlaceBalance } from '../../apps/api/src/modules/reports/finance.ts';
import { prevPeriod, windowsOf, type Period } from '../../apps/api/src/modules/reports/framework.ts';
import { getBranches } from '../../apps/api/src/modules/network/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

let db: TestDatabase;
let fx: Fx;
let b1: string;
let b2: string;

/** Прежний расчёт (до 0418): Σ по всему журналу до границ окна. Оракул сверки. */
const ORACLE = `WITH w AS (SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS x(branch_id, s, e)),
  moves AS (
    SELECT t.branch_id, t.place, t.delta_kop AS d, t.original_kind AS k, t.occurred_at FROM app.rpt_finance_operations t JOIN w ON w.branch_id = t.branch_id WHERE t.occurred_at < w.e
    UNION ALL
    SELECT t.branch_id, t.counter_place, -t.delta_kop, 'transfer_in', t.occurred_at FROM app.rpt_finance_operations t JOIN w ON w.branch_id = t.branch_id WHERE t.occurred_at < w.e AND t.counter_place IS NOT NULL
  )
  SELECT m.branch_id AS "branchId", m.place,
    coalesce(sum(m.d) FILTER (WHERE m.occurred_at < w.s OR m.k = 'opening_balance'), 0)::int AS "openingKop",
    coalesce(sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'income'), 0)::int AS "incomeKop",
    coalesce(-sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'refund'), 0)::int AS "refundKop",
    coalesce(-sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'expense'), 0)::int AS "expenseKop",
    coalesce(-sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'withdrawal'), 0)::int AS "withdrawalKop",
    coalesce(sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'transfer_in'), 0)::int AS "transferInKop",
    coalesce(-sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'place_transfer'), 0)::int AS "transferOutKop",
    coalesce(sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'correction'), 0)::int AS "correctionKop",
    coalesce(sum(m.d), 0)::int AS "closingKop"
  FROM moves m JOIN w ON w.branch_id = m.branch_id
  GROUP BY m.branch_id, m.place ORDER BY m.branch_id, m.place`;

async function op(branchId: string, o: { kind: string; place: string; direction: 'in' | 'out'; amount: number; at: string; reversalOf?: string; category?: string }): Promise<string> {
  const id = randomUUID();
  const comment = ['income', 'opening_balance', 'place_transfer'].includes(o.kind) ? null : 'тест';
  await db.client.query(
    `INSERT INTO journal.finance_operations (id, branch_id, kind, place, method, direction, amount_kop, source, category_id, comment, occurred_at, author_type, posting_id, reversal_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'system', gen_random_uuid(), $12)`,
    [id, branchId, o.kind, o.place, o.kind === 'place_transfer' || o.kind === 'reversal' || o.kind === 'opening_balance' ? null : o.place === 'cash' ? 'cash' : 'card', o.direction, o.amount,
      o.kind === 'income' ? 'other' : null, o.category ?? null, o.kind === 'place_transfer' ? 'перевод' : comment, o.at, o.reversalOf ?? null],
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  b1 = (await fx.branch('Asia/Novosibirsk')).id;
  b2 = (await fx.branch('Europe/Kaliningrad')).id;
  const cat = (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее'`)).rows[0]!.id;
  for (const b of [b1, b2]) {
    await op(b, { kind: 'opening_balance', place: 'cash', direction: 'in', amount: 100_000, at: '2026-09-01T03:00:00Z' });
    // у границы 1 ноября по Новосибирску (2026-10-31T17:00Z): до, ровно на ней, после; и после полуночи UTC
    await op(b, { kind: 'income', place: 'cash', direction: 'in', amount: 1_100, at: '2026-10-31T16:59:59Z' });
    await op(b, { kind: 'income', place: 'noncash', direction: 'in', amount: 2_200, at: '2026-10-31T17:00:00Z' });
    await op(b, { kind: 'expense', place: 'cash', direction: 'out', amount: 330, at: '2026-10-31T23:30:00Z', category: cat });
    await op(b, { kind: 'withdrawal', place: 'cash', direction: 'out', amount: 440, at: '2026-11-01T00:10:00Z' });
    const tr = await op(b, { kind: 'place_transfer', place: 'cash', direction: 'out', amount: 5_000, at: '2026-11-10T08:00:00Z' });
    await op(b, { kind: 'reversal', place: 'cash', direction: 'in', amount: 5_000, at: '2026-11-11T08:00:00Z', reversalOf: tr });
    await op(b, { kind: 'place_transfer', place: 'noncash', direction: 'out', amount: 700, at: '2026-11-30T16:59:00Z' });
    await op(b, { kind: 'opening_balance', place: 'noncash', direction: 'in', amount: 9_000, at: '2026-11-15T05:00:00Z' });
    const inc = await op(b, { kind: 'income', place: 'cash', direction: 'in', amount: 600, at: '2026-11-30T17:30:00Z' });
    await op(b, { kind: 'reversal', place: 'cash', direction: 'out', amount: 600, at: '2026-12-01T01:00:00Z', reversalOf: inc });
  }
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('дневные суммы мест денег (0418)', () => {
  it('триггер: сумма и число операций по суткам UTC = группировка журнала (с переводом во второе место)', async () => {
    const days = await db.client.query(`SELECT branch_id, day::text, place, kind, delta_kop::int AS d, ops FROM app.rpt_finance_place_days ORDER BY 1, 2, 3, 4`);
    const journal = await db.client.query(
      `SELECT branch_id, day::text, place, kind, sum(d)::int AS d, count(*)::int AS ops FROM (
         SELECT branch_id, (occurred_at AT TIME ZONE 'UTC')::date AS day, place, original_kind AS kind, delta_kop AS d FROM app.rpt_finance_operations
         UNION ALL
         SELECT branch_id, (occurred_at AT TIME ZONE 'UTC')::date, counter_place, 'transfer_in', -delta_kop FROM app.rpt_finance_operations WHERE original_kind = 'place_transfer'
       ) m GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
    );
    expect(days.rows.length).toBeGreaterThan(10);
    expect(days.rows).toEqual(journal.rows);
  });

  const periods: Period[] = [
    { from: d('2026-11-01'), to: d('2026-11-30') },
    { from: d('2026-11-01'), to: d('2026-11-01') },
    { from: d('2026-10-31'), to: d('2026-11-15') },
    { from: d('2026-12-01'), to: d('2026-12-31') },
  ];
  for (const period of periods) {
    it(`остаток по местам = прежний расчёт по всему журналу: ${period.from}…${period.to} (и прошлый период)`, async () => {
      const r = await fx.run(fx.owner(), (env) => financeReport(env, { period, branchIds: [b1, b2] }));
      const branches = [...(await getBranches(db.client, [b1, b2])).values()].sort((a, b) => a.id.localeCompare(b.id));
      const w = windowsOf(branches, period);
      const oracle = (await db.client.query<PlaceBalance>(ORACLE, [w.map((x) => x.branchId), w.map((x) => x.start), w.map((x) => x.end)])).rows;
      expect(oracle.length).toBeGreaterThan(0);
      expect(r.places).toEqual(oracle);
      const pw = windowsOf(branches, prevPeriod(period));
      const prev = (await db.client.query<PlaceBalance>(ORACLE, [pw.map((x) => x.branchId), pw.map((x) => x.start), pw.map((x) => x.end)])).rows;
      const sum = (rows: PlaceBalance[], k: 'openingKop' | 'closingKop') => rows.reduce((s, x) => s + x[k], 0);
      expect(r.metrics.cashClosing).toMatchObject({ state: 'ok', value: sum(oracle, 'closingKop'), prev: prev.length ? sum(prev, 'closingKop') : null });
      expect(r.metrics.cashOpening).toMatchObject({ state: 'ok', value: sum(oracle, 'openingKop'), prev: prev.length ? sum(prev, 'openingKop') : null });
    });
  }
});
