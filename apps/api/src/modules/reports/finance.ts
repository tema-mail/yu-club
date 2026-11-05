// S4-65. Отчёт «Финансы и касса» (K24 §3.4, 14 §7): те же определения, что у сводки K17 §9 (finance/summary.ts), на одном
// представлении rpt_finance_operations; отчёт – расширение на период, город, сеть и детализацию. Сторно входит со знаком минус
// в строку исходного вида. Чистое движение = Поступления − Возвраты − Расходы (изъятия, переводы и корректировки в него не входят);
// начальный остаток, внесённый в периоде, – в остатке на начало, как в K17 §9. Баллы и сертификаты – не деньги: отдельный блок
// из rpt_payments. Слова «прибыль» в подписях нет (приёмка 24).
import type { Tx } from '../../core/audit.ts';
import { formatLocal } from '../../core/time.ts';
import type { BranchInfo } from '../network/index.ts';
import {
  metricDef, noData, okMetric, prevPeriod, resolveBranches, runDetail, runMetrics, windowsOf,
  type BranchWindow, type Metric, type MetricDef, type MetricSpec, type ReportEnv, type ReportParams, type ReportResult,
} from './framework.ts';

export const FINANCE_ACTION = 'reports.finance.view';

export interface FinanceParams extends ReportParams {
  method?: string[] | undefined;
  categoryId?: string | undefined;
}

export type FinanceMetric =
  | 'income' | 'incomeSession' | 'incomeEvent' | 'incomeCertificateSale' | 'incomeExtraService' | 'incomeOther'
  | 'refunds' | 'expenses' | 'withdrawals' | 'transfers' | 'corrections' | 'netMovement' | 'nonMoneyPoints' | 'nonMoneyCertificate';

type Conds = NonNullable<MetricSpec['conds']>;
const VIEW = 'app.rpt_finance_operations';

export function financeDefs(p: FinanceParams): Record<FinanceMetric, MetricDef> {
  const common: Conds = [];
  if (p.method?.length) common.push({ sql: 't.method = ANY(?::text[])', values: [p.method] });
  if (p.categoryId) common.push({ sql: '(t.category_id = ?::uuid OR t.subcategory_id = ?::uuid)', values: [p.categoryId, p.categoryId] });
  const money = (conds: Conds, col: 'signed_kop' | 'delta_kop' = 'signed_kop'): MetricDef => ({
    spec: { view: VIEW, date: 'occurred_at', conds: [...common, ...conds] },
    agg: 'sum', col, unit: 'kop', dateBasis: 'occurred_at', idCol: 'operation_id',
  });
  const income = (source: string) => money([{ sql: `t.original_kind = 'income'` }, { sql: 't.source = ?', values: [source] }]);
  const nonMoney = (method: string, col: string, unit: MetricDef['unit']): MetricDef => ({
    spec: { view: 'app.rpt_payments', date: 'paid_at', conds: [{ sql: 't.method = ?', values: [method] }, { sql: `t.status <> 'refunded'` }] },
    agg: 'sum', col, unit, dateBasis: 'occurred_at', idCol: 'payment_id',
  });
  return {
    income: money([{ sql: `t.original_kind = 'income'` }]),
    incomeSession: income('session'),
    incomeEvent: income('event'),
    incomeCertificateSale: income('certificate_sale'),
    incomeExtraService: income('extra_service'),
    incomeOther: income('other'),
    refunds: money([{ sql: `t.original_kind = 'refund'` }]),
    expenses: money([{ sql: `t.original_kind = 'expense'` }]),
    withdrawals: money([{ sql: `t.original_kind = 'withdrawal'` }]),
    transfers: money([{ sql: `t.original_kind = 'place_transfer'` }]),
    corrections: money([{ sql: `t.original_kind = 'correction'` }], 'delta_kop'),
    // движение места: приход +, возврат и расход −, сторно – обратным знаком; значит Σ delta_kop = Поступления − Возвраты − Расходы
    netMovement: money([{ sql: `t.original_kind IN ('income', 'refund', 'expense')` }], 'delta_kop'),
    nonMoneyPoints: nonMoney('points', 'points_centi', 'centi'),
    nonMoneyCertificate: nonMoney('certificate', 'amount_kop', 'kop'),
  };
}

export interface PlaceBalance {
  branchId: string;
  place: 'cash' | 'noncash';
  openingKop: number;
  incomeKop: number;
  refundKop: number;
  expenseKop: number;
  withdrawalKop: number;
  transferInKop: number;
  transferOutKop: number;
  correctionKop: number;
  closingKop: number;
}

/** Остаток по каждому месту денег (K17 §2). closing считается независимо – Σ движений до конца периода; формула 14 §7.2 – в тесте. */
async function placeBalances(tx: Tx, windows: readonly BranchWindow[]): Promise<PlaceBalance[]> {
  if (windows.length === 0) return [];
  const r = await tx.query<Record<'branch_id' | 'place' | 'opening' | 'income' | 'refund' | 'expense' | 'withdrawal' | 'tin' | 'tout' | 'corr' | 'closing', string>>(
    `WITH w AS (SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS x(branch_id, s, e)),
     moves AS (
       SELECT t.branch_id, t.place, t.delta_kop AS d, t.original_kind AS k, t.occurred_at FROM app.rpt_finance_operations t JOIN w ON w.branch_id = t.branch_id WHERE t.occurred_at < w.e
       UNION ALL
       SELECT t.branch_id, t.counter_place, -t.delta_kop, 'transfer_in', t.occurred_at FROM app.rpt_finance_operations t JOIN w ON w.branch_id = t.branch_id WHERE t.occurred_at < w.e AND t.counter_place IS NOT NULL
     )
     SELECT m.branch_id, m.place,
       coalesce(sum(m.d) FILTER (WHERE m.occurred_at < w.s OR m.k = 'opening_balance'), 0) AS opening,
       coalesce(sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'income'), 0) AS income,
       coalesce(-sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'refund'), 0) AS refund,
       coalesce(-sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'expense'), 0) AS expense,
       coalesce(-sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'withdrawal'), 0) AS withdrawal,
       coalesce(sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'transfer_in'), 0) AS tin,
       coalesce(-sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'place_transfer'), 0) AS tout,
       coalesce(sum(m.d) FILTER (WHERE m.occurred_at >= w.s AND m.k = 'correction'), 0) AS corr,
       coalesce(sum(m.d), 0) AS closing
     FROM moves m JOIN w ON w.branch_id = m.branch_id
     GROUP BY m.branch_id, m.place ORDER BY m.branch_id, m.place`,
    [windows.map((w) => w.branchId), windows.map((w) => w.start), windows.map((w) => w.end)],
  );
  return r.rows.map((x) => ({
    branchId: x.branch_id, place: x.place as PlaceBalance['place'], openingKop: Number(x.opening), incomeKop: Number(x.income), refundKop: Number(x.refund), expenseKop: Number(x.expense),
    withdrawalKop: Number(x.withdrawal), transferInKop: Number(x.tin), transferOutKop: Number(x.tout), correctionKop: Number(x.corr), closingKop: Number(x.closing),
  }));
}

export interface ExpenseGroup {
  categoryId: string;
  name: string;
  amountKop: number;
  sub: Array<{ subcategoryId: string; name: string; amountKop: number }>;
}

async function expenseGroups(tx: Tx, windows: readonly BranchWindow[], p: FinanceParams): Promise<ExpenseGroup[]> {
  if (windows.length === 0) return [];
  const r = await tx.query<{ category_id: string; subcategory_id: string | null; amount: string; cat: string; sub: string | null }>(
    `SELECT t.category_id, t.subcategory_id, sum(t.signed_kop) AS amount, c.name AS cat, s.name AS sub
     FROM app.rpt_finance_operations t
     JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e) ON w.branch_id = t.branch_id AND t.occurred_at >= w.s AND t.occurred_at < w.e
     JOIN app.finance_categories c ON c.id = t.category_id
     LEFT JOIN app.finance_categories s ON s.id = t.subcategory_id
     WHERE t.original_kind = 'expense' AND ($4::text[] IS NULL OR t.method = ANY($4::text[])) AND ($5::uuid IS NULL OR t.category_id = $5 OR t.subcategory_id = $5)
     GROUP BY t.category_id, t.subcategory_id, c.name, s.name ORDER BY c.name, s.name NULLS FIRST`,
    [windows.map((w) => w.branchId), windows.map((w) => w.start), windows.map((w) => w.end), p.method?.length ? p.method : null, p.categoryId ?? null],
  );
  const out = new Map<string, ExpenseGroup>();
  for (const row of r.rows) {
    const g = out.get(row.category_id) ?? { categoryId: row.category_id, name: row.cat, amountKop: 0, sub: [] };
    g.amountKop += Number(row.amount);
    if (row.subcategory_id) g.sub.push({ subcategoryId: row.subcategory_id, name: row.sub ?? '', amountKop: Number(row.amount) });
    out.set(row.category_id, g);
  }
  return [...out.values()];
}

async function incomeByMethod(tx: Tx, windows: readonly BranchWindow[]): Promise<Array<{ method: string; amountKop: number }>> {
  if (windows.length === 0) return [];
  const r = await tx.query<{ method: string; amount: string }>(
    `SELECT t.method, sum(t.signed_kop) AS amount FROM app.rpt_finance_operations t
     JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e) ON w.branch_id = t.branch_id AND t.occurred_at >= w.s AND t.occurred_at < w.e
     WHERE t.original_kind = 'income' AND t.method IS NOT NULL GROUP BY t.method ORDER BY t.method`,
    [windows.map((w) => w.branchId), windows.map((w) => w.start), windows.map((w) => w.end)],
  );
  return r.rows.map((x) => ({ method: x.method, amountKop: Number(x.amount) }));
}

export interface FinanceResult extends ReportResult<FinanceMetric | 'cashOpening' | 'cashClosing'> {
  places: PlaceBalance[];
  expenseByCategory: ExpenseGroup[];
  incomeByMethod: Array<{ method: string; amountKop: number }>;
}

const placeTotal = (rows: readonly PlaceBalance[], key: 'openingKop' | 'closingKop') => rows.reduce((s, r) => s + r[key], 0);

export async function financeReport(env: ReportEnv, p: FinanceParams): Promise<FinanceResult> {
  const defs = financeDefs(p);
  const base = await runMetrics(env, FINANCE_ACTION, p, defs);
  const branches = await resolveBranches(env.tx, env.ctx, FINANCE_ACTION, p);
  const windows = windowsOf(branches, p.period);
  const prev = windowsOf(branches, prevPeriod(p.period));
  const places = await placeBalances(env.tx, windows);
  const prevPlaces = await placeBalances(env.tx, prev);
  const balance = (key: 'openingKop' | 'closingKop'): Metric => (places.length === 0 ? noData : okMetric(placeTotal(places, key), 'kop', prevPlaces.length ? placeTotal(prevPlaces, key) : null));
  return {
    ...base,
    metrics: { ...base.metrics, cashOpening: balance('openingKop'), cashClosing: balance('closingKop') },
    dateBasis: { ...base.dateBasis, cashOpening: 'occurred_at', cashClosing: 'occurred_at' },
    places,
    expenseByCategory: await expenseGroups(env.tx, windows, p),
    incomeByMethod: await incomeByMethod(env.tx, windows),
  };
}

export interface FinanceDetailRow {
  id: string;
  number: number | null;
  occurredLocal: string;
  branchId: string;
  branchName: string;
  kind: string;
  isReversal: boolean;
  place: string | null;
  method: string | null;
  source: string | null;
  categoryId: string | null;
  amountKop: number;
  ref: { type: string; id: string } | null;
  authorId: string | null;
  comment: string | null;
}

function zoneOf(branches: readonly BranchInfo[], id: string): BranchInfo | undefined {
  return branches.find((b) => b.id === id);
}

/** Строки показателя: операции кассы или платежи, value – в знаке показателя. Остатки – по местам денег. */
export async function financeDetail(
  env: ReportEnv,
  p: FinanceParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: Array<FinanceDetailRow & { value: number }> | Array<PlaceBalance & { value: number }>; total: Metric; nextCursor: string | null }> {
  if (metric === 'cashOpening' || metric === 'cashClosing') {
    const branches = await resolveBranches(env.tx, env.ctx, FINANCE_ACTION, p);
    const rows = await placeBalances(env.tx, windowsOf(branches, p.period));
    const key = metric === 'cashOpening' ? 'openingKop' : 'closingKop';
    return { rows: rows.map((r) => ({ ...r, value: r[key] })), total: rows.length ? okMetric(placeTotal(rows, key), 'kop') : noData, nextCursor: null };
  }
  const def = metricDef(financeDefs(p), metric);
  const page = await runDetail<Record<string, unknown>>(env, FINANCE_ACTION, p, def, opts);
  const col = def.col!;
  const isOp = def.spec.view === VIEW;
  const rows = page.rows.map((r) => {
    const at = (isOp ? r.occurred_at : r.paid_at) as Date;
    const branch = zoneOf(page.branches, r.branch_id as string)!;
    return {
      id: (isOp ? r.operation_id : r.payment_id) as string,
      number: isOp ? Number(r.number) : null,
      occurredLocal: formatLocal(at, branch.timezone, 'datetime'),
      branchId: branch.id,
      branchName: branch.name,
      kind: (isOp ? r.original_kind : r.method) as string,
      isReversal: isOp ? r.kind === 'reversal' : false,
      place: (r.place as string | undefined) ?? null,
      method: (r.method as string | null) ?? null,
      source: (r.source as string | undefined) ?? null,
      categoryId: (r.category_id as string | undefined) ?? null,
      amountKop: Number(r.amount_kop),
      ref: r.ref_type ? { type: r.ref_type as string, id: r.ref_id as string } : r.booking_id ? { type: 'booking', id: r.booking_id as string } : null,
      authorId: (isOp ? (r.author_id as string | null) : (r.recorded_by as string | null)) ?? null,
      comment: (r.comment as string | null | undefined) ?? null,
      value: Number(r[col]),
    };
  });
  return { rows, total: page.total, nextCursor: page.nextCursor };
}
