// S4-67. Отчёт «Лояльность и баллы» (K24 §3.7, 14 §10). Движения – по записям K3 бонусного счёта (rpt_loyalty_moves, сотые балла,
// знак журнала: начисление +, списание и штраф −); сторно – в строке исходного типа с обратным знаком. Правила 07 отчёт не пересчитывает:
// штраф с обрезкой у −50 виден как факт, −2 (TC-10). Баланс на конец периода: период дошёл до сегодня – rpt_loyalty_balances,
// на прошлую дату – Σ записей до даты. Запись без филиала (ручная корректировка) видна только в сетевой области. Баллы не деньги (приёмка 9).
import type { Tx } from '../../core/audit.ts';
import { resolveSettings } from '../../core/settings.ts';
import type { BranchInfo } from '../network/index.ts';
import {
  computeMetrics, DAY_RULE, detailPage, loadMaskedClients, localAt, metricDef, noData, okMetric, pageLimit, prevPeriod, resolveBranches, uuidCursor, windowsOf,
  type BranchWindow, type MaskedClient, type Metric, type MetricDef, type Period, type ReportEnv, type ReportParams,
} from './framework.ts';

export const LOYALTY_ACTION = 'reports.loyalty.view';
const BLOCK_CENTI = -5000;

export type LoyaltyMoveMetric = 'accrued' | 'spentTime' | 'spentGoods' | 'penalties' | 'returned' | 'adjusted' | 'expired';
export type BalanceMetric = 'clientsPositive' | 'clientsNegative' | 'clientsAtThreshold' | 'clientsBlocked' | 'totalBalance';

export function loyaltyDefs(): Record<LoyaltyMoveMetric, MetricDef> {
  const moves = (type: string, spend?: 'time' | 'goods'): MetricDef => ({
    spec: {
      view: 'app.rpt_loyalty_moves', date: 'at', nullableBranch: true,
      conds: [{ sql: 't.original_type = ?', values: [type] }, ...(spend ? [{ sql: 't.spend_kind = ?', values: [spend] }] : [])],
    },
    agg: 'sum', col: 'amount_centi', unit: 'centi', dateBasis: 'at', idCol: 'entry_id',
  });
  return {
    accrued: moves('accrual'), spentTime: moves('spend', 'time'), spentGoods: moves('spend', 'goods'),
    penalties: moves('penalty'), returned: moves('return'), adjusted: moves('adjust'), expired: moves('expire'),
  };
}

/** Окна области: сетевая область без фильтра включает записи без филиала – границы всех филиалов сети. */
function moveWindows(env: ReportEnv, p: ReportParams, branches: readonly BranchInfo[], period: Period): BranchWindow[] {
  const w = windowsOf(branches, period);
  if (env.ctx.network && !p.cityId && !p.branchIds?.length && w.length > 0) {
    w.push({ branchId: null, start: new Date(Math.min(...w.map((x) => x.start.getTime()))), end: new Date(Math.max(...w.map((x) => x.end.getTime()))) });
  }
  return w;
}

// ---- баланс на конец периода

interface BalanceScope {
  at: Date; // конец периода
  current: boolean; // период дошёл до сегодня: источник – текущие балансы
  branchIds: string[] | null; // null – вся сеть; иначе клиенты с бронью в этих филиалах
}

function balancesFrom(s: BalanceScope): { sql: string; params: unknown[] } {
  const zone = s.branchIds ? `EXISTS (SELECT 1 FROM app.rpt_bookings b WHERE b.client_id = x.client_id AND b.branch_id = ANY($1::uuid[]))` : 'TRUE';
  const params: unknown[] = s.branchIds ? [s.branchIds] : [];
  if (s.current) return { sql: `(SELECT client_id, balance_centi AS balance FROM app.rpt_loyalty_balances) x WHERE ${zone}`, params };
  params.push(s.at);
  const at = `$${params.length}`;
  return { sql: `(SELECT client_id, sum(amount_centi) AS balance FROM app.rpt_loyalty_moves WHERE at < ${at} GROUP BY client_id) x WHERE ${zone}`, params };
}

const BALANCE_CONDS = (warn: number): Record<Exclude<BalanceMetric, 'totalBalance'>, string> => ({
  clientsPositive: 'x.balance > 0',
  clientsNegative: 'x.balance < 0',
  clientsAtThreshold: `x.balance > ${BLOCK_CENTI} AND x.balance <= ${Math.trunc(warn)}`,
  clientsBlocked: `x.balance <= ${BLOCK_CENTI}`,
});

async function balanceMetrics(tx: Tx, s: BalanceScope, warn: number): Promise<Record<BalanceMetric, Metric>> {
  const f = balancesFrom(s);
  const c = BALANCE_CONDS(warn);
  const r = (
    await tx.query<{ n: string; pos: string; neg: string; warn: string; blocked: string; total: string | null }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE ${c.clientsPositive}) AS pos, count(*) FILTER (WHERE ${c.clientsNegative}) AS neg,
              count(*) FILTER (WHERE ${c.clientsAtThreshold}) AS warn, count(*) FILTER (WHERE ${c.clientsBlocked}) AS blocked, sum(x.balance) AS total
       FROM ${f.sql}`,
      f.params,
    )
  ).rows[0]!;
  if (Number(r.n) === 0) return { clientsPositive: noData, clientsNegative: noData, clientsAtThreshold: noData, clientsBlocked: noData, totalBalance: noData };
  return {
    clientsPositive: okMetric(Number(r.pos), 'count'),
    clientsNegative: okMetric(Number(r.neg), 'count'),
    clientsAtThreshold: okMetric(Number(r.warn), 'count'),
    clientsBlocked: okMetric(Number(r.blocked), 'count'),
    totalBalance: okMetric(Number(r.total ?? 0), 'centi'),
  };
}

async function balanceScope(env: ReportEnv, p: ReportParams, branches: readonly BranchInfo[]): Promise<BalanceScope> {
  const windows = windowsOf(branches, p.period);
  const end = windows.length ? new Date(Math.max(...windows.map((w) => w.end.getTime()))) : env.clock.now();
  const networkWide = env.ctx.network && !p.cityId && !p.branchIds?.length;
  return { at: end, current: end.getTime() > env.clock.now().getTime(), branchIds: networkWide ? null : branches.map((b) => b.id) };
}

async function warnThreshold(env: ReportEnv): Promise<number> {
  const s = await resolveSettings(env.main, ['reports.loyalty_threshold_warn_centi'], { network: true }, env.clock.now());
  return s['reports.loyalty_threshold_warn_centi'].value;
}

// ---- отчёт

export type LoyaltyMetric = LoyaltyMoveMetric | BalanceMetric;

export interface LoyaltyResult {
  metrics: Record<LoyaltyMetric, Metric>;
  labels: { threshold: string; notMoney: string };
  dateBasis: Record<LoyaltyMetric, string>;
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

export async function loyaltyReport(env: ReportEnv, p: ReportParams): Promise<LoyaltyResult> {
  const branches = await resolveBranches(env.tx, env.ctx, LOYALTY_ACTION, p);
  const prevP = prevPeriod(p.period);
  const defs = loyaltyDefs();
  const moves = await computeMetrics(env.tx, defs, moveWindows(env, p, branches, p.period), moveWindows(env, p, branches, prevP));
  const warn = await warnThreshold(env);
  const balances = branches.length || env.ctx.network ? await balanceMetrics(env.tx, await balanceScope(env, p, branches), warn) : { clientsPositive: noData, clientsNegative: noData, clientsAtThreshold: noData, clientsBlocked: noData, totalBalance: noData };
  const dateBasis = Object.fromEntries((Object.keys(defs) as LoyaltyMoveMetric[]).map((k) => [k, 'at'])) as Record<LoyaltyMoveMetric, string>;
  return {
    metrics: { ...moves, ...balances },
    labels: { threshold: `порог блокировки: от ${warn / 100} до ${BLOCK_CENTI / 100} баллов`, notMoney: 'Баллы не входят в денежную выручку' },
    dateBasis: { ...dateBasis, clientsPositive: 'period_end', clientsNegative: 'period_end', clientsAtThreshold: 'period_end', clientsBlocked: 'period_end', totalBalance: 'period_end' },
    period: p.period,
    prevPeriod: prevP,
    computedAt: env.clock.now().toISOString(),
    dayRule: DAY_RULE,
  };
}

// ---- детализация

export interface LoyaltyDetailRow {
  entryId: string | null;
  clientId: string;
  client: MaskedClient | null;
  atLocal: string | null;
  type: string | null;
  isReversal: boolean;
  spendKind: string | null;
  value: number;
  ref: { type: string; id: string } | null;
  authorType: string | null;
}

interface MoveRow {
  entry_id: string;
  client_id: string;
  branch_id: string | null;
  entry_type: string;
  original_type: string;
  spend_kind: string | null;
  amount_centi: string;
  ref_type: string | null;
  ref_id: string | null;
  at: Date;
  author_type: string;
}

export async function loyaltyDetail(
  env: ReportEnv,
  p: ReportParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: LoyaltyDetailRow[]; total: Metric; nextCursor: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, LOYALTY_ACTION, p);
  const fallback = branches[0];
  const masked = (rows: Array<{ clientId: string; branchId: string | null }>) =>
    loadMaskedClients(env.main, env.ctx, rows.flatMap((r) => (r.branchId ?? fallback?.id ? [{ clientId: r.clientId, branchId: (r.branchId ?? fallback?.id)! }] : [])));
  if (typeof metric === 'string' && ['clientsPositive', 'clientsNegative', 'clientsAtThreshold', 'clientsBlocked', 'totalBalance'].includes(metric)) {
    const warn = await warnThreshold(env);
    const scope = await balanceScope(env, p, branches);
    const f = balancesFrom(scope);
    const c = BALANCE_CONDS(warn);
    const cond = metric === 'totalBalance' ? 'TRUE' : c[metric as Exclude<BalanceMetric, 'totalBalance'>];
    const limit = pageLimit(opts);
    const after = uuidCursor(opts.cursor);
    const params = [...f.params, after, limit + 1];
    const found = (
      await env.tx.query<{ client_id: string; balance: string }>(
        `SELECT x.client_id, x.balance FROM ${f.sql} AND ${cond} AND ($${params.length - 1}::uuid IS NULL OR x.client_id > $${params.length - 1}::uuid) ORDER BY x.client_id LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const rows = found.slice(0, limit);
    const clients = await masked(rows.map((r) => ({ clientId: r.client_id, branchId: null })));
    const out: LoyaltyDetailRow[] = rows.map((r) => ({
      entryId: null, clientId: r.client_id, client: clients.get(`${r.client_id}:${fallback?.id ?? ''}`) ?? null, atLocal: null, type: null, isReversal: false, spendKind: null,
      value: metric === 'totalBalance' ? Number(r.balance) : 1, ref: null, authorType: null,
    }));
    // итог – из агрегата того же условия, а не из строк страницы (TC-20)
    const total = (await balanceMetrics(env.tx, scope, warn))[metric as BalanceMetric];
    return { rows: out, total, nextCursor: found.length > limit ? rows[rows.length - 1]!.client_id : null };
  }
  const def = metricDef(loyaltyDefs(), metric);
  const page = await detailPage<MoveRow>(env.tx, def, moveWindows(env, p, branches, p.period), opts);
  const clients = await masked(page.rows.map((r) => ({ clientId: r.client_id, branchId: r.branch_id })));
  const zoneById = new Map(branches.map((b) => [b.id, b.timezone]));
  const rows: LoyaltyDetailRow[] = page.rows.map((r) => {
    const branchId = r.branch_id ?? fallback?.id ?? '';
    const tz = zoneById.get(branchId) ?? fallback?.timezone;
    return {
      entryId: String(r.entry_id), clientId: r.client_id, client: clients.get(`${r.client_id}:${branchId}`) ?? null,
      atLocal: tz ? localAt(env, r.at, tz) : r.at.toISOString(),
      type: r.original_type, isReversal: r.entry_type === 'reversal', spendKind: r.spend_kind, value: Number(r.amount_centi),
      ref: r.ref_type && r.ref_id ? { type: r.ref_type, id: r.ref_id } : null, authorType: r.author_type,
    };
  });
  return { rows, total: page.total.rows === 0 ? noData : okMetric(page.total.value, 'centi'), nextCursor: page.nextCursor };
}
