// S4-68. Отчёт «Сертификаты» (K24 §3.8, 14 §11). По событиям rpt_certificate_ops: продажа – филиал продажи, погашение – филиал погашения
// (взаиморасчёт Q-25); продажа – поступление (она же в 3.4 как certificate_sale), погашение – не поступление (приёмка 8). На конец периода –
// остаток по последнему событию каждого сертификата, область – филиал продажи. Подарок имениннику – право на услугу, не деньги (14 §11,
// приёмка 14): выдано, использовано, сгорело – по rpt_gift_ops (0425, K20 §8). Детализация погашения: дата, сумма, клиент (маска), сеанс,
// сотрудник, остаток после.
import type { Tx } from '../../core/audit.ts';
import {
  computeMetrics, DAY_RULE, detailPage, loadMaskedClients, localAt, metricDef, noData, okMetric, pageByKey, prevPeriod, resolveBranches, windowsOf,
  type BranchWindow, type MaskedClient, type Metric, type MetricDef, type Period, type ReportEnv, type ReportParams,
} from './framework.ts';
import type { BranchInfo } from '../network/index.ts';

export const CERTIFICATES_ACTION = 'reports.finance.view';

export type CertificateOpMetric = 'salesCount' | 'salesAmount' | 'redeemedAmount' | 'redeemReturnedAmount' | 'expiredCount' | 'expiredAmount' | 'cancelledCount';
export type CertificateEndMetric = 'activeCount' | 'activeBalance' | 'partiallyRedeemed';

export function certificateDefs(): Record<CertificateOpMetric, MetricDef> {
  const ops = (op: string, agg: 'count' | 'sum'): MetricDef => ({
    spec: { view: 'app.rpt_certificate_ops', date: 'at', conds: [{ sql: 't.op = ?', values: [op] }] },
    agg, ...(agg === 'sum' ? { col: 'amount_kop' } : {}), unit: agg === 'sum' ? 'kop' : 'count', dateBasis: 'at', idCol: 'entry_id',
  });
  return {
    salesCount: ops('sale', 'count'),
    salesAmount: ops('sale', 'sum'),
    redeemedAmount: ops('redeem', 'sum'),
    redeemReturnedAmount: ops('redeem_return', 'sum'),
    expiredCount: ops('expire', 'count'),
    expiredAmount: ops('expire', 'sum'),
    cancelledCount: ops('cancel', 'count'),
  };
}

export type GiftMetric = 'birthdayGift' | 'birthdayGiftUsed' | 'birthdayGiftExpired';

/** Подарок имениннику (K20 §8): выдано – в филиале выдачи, использовано – в филиале брони, сгорело – в филиале выдачи; штуки. */
export function giftDefs(): Record<GiftMetric, MetricDef> {
  const op = (o: string): MetricDef => ({
    spec: { view: 'app.rpt_gift_ops', date: 'at', conds: [{ sql: 't.op = ?', values: [o] }] }, agg: 'count', unit: 'count', dateBasis: 'at', idCol: 'entry_id',
  });
  return { birthdayGift: op('issue'), birthdayGiftUsed: op('use'), birthdayGiftExpired: op('expire') };
}

interface EndRow {
  certificate_id: string;
  number: string;
  sale_branch_id: string;
  balance_after_kop: string;
  has_redeem: boolean;
}

/** Состояние каждого сертификата области на конец периода – последнее событие до конца суток филиала продажи. */
async function endRows(tx: Tx, windows: readonly BranchWindow[]): Promise<EndRow[]> {
  if (windows.length === 0) return [];
  const r = await tx.query<EndRow>(
    `SELECT DISTINCT ON (o.certificate_id) o.certificate_id, o.number, o.sale_branch_id, o.balance_after_kop,
            (SELECT coalesce(sum(CASE x.op WHEN 'redeem' THEN x.amount_kop ELSE -x.amount_kop END), 0) > 0 FROM app.rpt_certificate_ops x
             WHERE x.certificate_id = o.certificate_id AND x.op IN ('redeem', 'redeem_return') AND x.at < w.e) AS has_redeem -- погашение, возвращённое целиком, не считается
     FROM app.rpt_certificate_ops o
     JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e) ON w.branch_id = o.sale_branch_id AND o.at < w.e
     ORDER BY o.certificate_id, o.at DESC, o.entry_id DESC`,
    [windows.map((w) => w.branchId), windows.map((w) => w.start), windows.map((w) => w.end)],
  );
  return r.rows;
}

function endMetrics(rows: readonly EndRow[]): Record<CertificateEndMetric, Metric> {
  if (rows.length === 0) return { activeCount: noData, activeBalance: noData, partiallyRedeemed: noData };
  const active = rows.filter((r) => Number(r.balance_after_kop) > 0);
  return {
    activeCount: okMetric(active.length, 'count'),
    activeBalance: okMetric(active.reduce((s, r) => s + Number(r.balance_after_kop), 0), 'kop'),
    partiallyRedeemed: okMetric(active.filter((r) => r.has_redeem).length, 'count'),
  };
}

export type CertificatesMetric = CertificateOpMetric | CertificateEndMetric | GiftMetric;

export interface CertificatesResult {
  metrics: Record<CertificatesMetric, Metric>;
  labels: { birthdayGift: string; redeemed: string };
  dateBasis: Record<CertificatesMetric, string>;
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

export async function certificatesReport(env: ReportEnv, p: ReportParams): Promise<CertificatesResult> {
  const branches = await resolveBranches(env.tx, env.ctx, CERTIFICATES_ACTION, p);
  const prevP = prevPeriod(p.period);
  const defs = certificateDefs();
  const cur = windowsOf(branches, p.period);
  const ops = await computeMetrics(env.tx, defs, cur, windowsOf(branches, prevP));
  const gifts = await computeMetrics(env.tx, giftDefs(), cur, windowsOf(branches, prevP));
  const atEnd = endMetrics(await endRows(env.tx, cur));
  const dateBasis = Object.fromEntries([...Object.keys(defs), ...Object.keys(gifts)].map((k) => [k, 'at'])) as Record<CertificateOpMetric | GiftMetric, string>;
  return {
    metrics: { ...ops, ...atEnd, ...gifts },
    labels: { birthdayGift: 'Подарок имениннику – право на услугу, не деньги', redeemed: 'Погашение не является поступлением денег' },
    dateBasis: { ...dateBasis, activeCount: 'period_end', activeBalance: 'period_end', partiallyRedeemed: 'period_end' },
    period: p.period,
    prevPeriod: prevP,
    computedAt: env.clock.now().toISOString(),
    dayRule: DAY_RULE,
  };
}

export interface CertificateDetailRow {
  certificateId: string;
  number: string;
  atLocal: string | null;
  op: string | null;
  branchId: string;
  client: MaskedClient | null;
  bookingId: string | null;
  authorId: string | null;
  balanceAfterKop: number;
  value: number;
}

interface OpRow {
  certificate_id: string;
  number: string;
  op: string;
  amount_kop: string;
  branch_id: string;
  client_id: string | null;
  booking_id: string | null;
  author_id: string | null;
  at: Date;
  balance_after_kop: string;
}

export async function certificatesDetail(
  env: ReportEnv,
  p: ReportParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: CertificateDetailRow[]; total: Metric; nextCursor: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, CERTIFICATES_ACTION, p);
  const windows = windowsOf(branches, p.period);
  if (metric === 'activeCount' || metric === 'activeBalance' || metric === 'partiallyRedeemed') {
    const all = await endRows(env.tx, windows);
    const rows = all.filter((r) => Number(r.balance_after_kop) > 0 && (metric !== 'partiallyRedeemed' || r.has_redeem));
    const { slice, nextCursor } = pageByKey(rows, (r) => r.certificate_id, opts);
    const out = slice.map((r) => ({
      certificateId: r.certificate_id, number: r.number, atLocal: null, op: null, branchId: r.sale_branch_id, client: null, bookingId: null, authorId: null,
      balanceAfterKop: Number(r.balance_after_kop), value: metric === 'activeBalance' ? Number(r.balance_after_kop) : 1,
    }));
    return { rows: out, total: endMetrics(all)[metric], nextCursor };
  }
  if (typeof metric === 'string' && Object.hasOwn(giftDefs(), metric)) return giftDetail(env, branches, windows, metricDef(giftDefs(), metric), opts);
  const def = metricDef(certificateDefs(), metric);
  const page = await detailPage<OpRow>(env.tx, def, windows, opts);
  const withClient = page.rows.filter((r) => r.client_id !== null);
  const clients = await loadMaskedClients(env.main, env.ctx, withClient.map((r) => ({ clientId: r.client_id!, branchId: r.branch_id })));
  const zones = new Map(branches.map((b) => [b.id, b.timezone]));
  const rows: CertificateDetailRow[] = page.rows.map((r) => ({
    certificateId: r.certificate_id,
    number: r.number,
    atLocal: localAt(env, r.at, zones.get(r.branch_id)!),
    op: r.op,
    branchId: r.branch_id,
    client: r.client_id ? (clients.get(`${r.client_id}:${r.branch_id}`) ?? null) : null,
    bookingId: r.booking_id,
    authorId: r.author_id,
    balanceAfterKop: Number(r.balance_after_kop),
    value: def.agg === 'sum' ? Number(r.amount_kop) : 1,
  }));
  return { rows, total: page.total.rows === 0 ? noData : okMetric(page.total.value, def.unit), nextCursor: page.nextCursor };
}

interface GiftOpRow {
  entry_id: string;
  gift_id: string;
  number: string;
  op: string;
  branch_id: string;
  client_id: string;
  booking_id: string | null;
  author_id: string | null;
  at: Date;
}

/** Строка подарка: номер GF-, дата события, клиент (маска), бронь (для использования), сотрудник выдачи; суммы и остатка у права нет. */
async function giftDetail(
  env: ReportEnv,
  branches: readonly BranchInfo[],
  windows: readonly BranchWindow[],
  def: MetricDef,
  opts: { cursor?: string | undefined; limit?: number | undefined },
): Promise<{ rows: CertificateDetailRow[]; total: Metric; nextCursor: string | null }> {
  const page = await detailPage<GiftOpRow>(env.tx, def, windows, opts);
  const clients = await loadMaskedClients(env.main, env.ctx, page.rows.map((r) => ({ clientId: r.client_id, branchId: r.branch_id })));
  const zones = new Map(branches.map((b) => [b.id, b.timezone]));
  const rows: CertificateDetailRow[] = page.rows.map((r) => ({
    certificateId: r.gift_id,
    number: r.number,
    atLocal: localAt(env, r.at, zones.get(r.branch_id)!),
    op: r.op,
    branchId: r.branch_id,
    client: clients.get(`${r.client_id}:${r.branch_id}`) ?? null,
    bookingId: r.booking_id,
    authorId: r.author_id,
    balanceAfterKop: 0,
    value: 1,
  }));
  return { rows, total: page.total.rows === 0 ? noData : okMetric(page.total.value, def.unit), nextCursor: page.nextCursor };
}
