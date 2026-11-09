// S4-76. Отчёт «Мероприятия» (K24 §3.5, 14 §8). Строка – мероприятие из rpt_event_results (0415) по дате проведения в зоне филиала;
// деньги – все живые связи мероприятия (rpt_event_money, K17 §14) независимо от их даты: предоплата прошлого месяца входит в результат,
// вручную привязанный расход (без ref_type) – в факт себестоимости. Формулы – как карточка мероприятия (events/money.ts summarize):
// отклонение = факт − план себестоимости; результат = поступления − возвраты − факт прямых расходов (не «прибыль»);
// остаток к оплате = согласованная − поступления + возвраты. Мероприятия без брони включаются (приёмка 10).
import type { Tx } from '../../core/audit.ts';
import {
  computeMetrics, DAY_RULE, detailPage, localAt, metricDef, noData, okMetric, prevPeriod, resolveBranches, windowsOf,
  type BranchWindow, type Metric, type MetricDef, type Period, type ReportEnv, type ReportParams,
} from './framework.ts';

export const EVENTS_ACTION = 'reports.events.view';

export type EventsMetric =
  | 'count' | 'cancelled' | 'withoutBooking' | 'agreedPrice' | 'avgPrice' | 'received' | 'refunded' | 'due' | 'plannedCost' | 'factCost' | 'deviation' | 'result';

export function eventsDefs(): Record<EventsMetric, MetricDef> {
  const ev = (agg: 'count' | 'sum' | 'avg', col?: string, conds: Array<{ sql: string }> = []): MetricDef => ({
    spec: { view: 'app.rpt_event_results', date: 'held_at', conds }, agg, ...(col ? { col } : {}), unit: agg === 'count' ? 'count' : 'kop', dateBasis: 'session_start', idCol: 'event_id',
  });
  return {
    count: ev('count'),
    cancelled: ev('count', undefined, [{ sql: `t.status IN ('cancelled', 'not_held')` }]),
    withoutBooking: ev('count', undefined, [{ sql: 'NOT t.has_booking' }]),
    agreedPrice: ev('sum', 'agreed_price_kop'),
    avgPrice: ev('avg', 'agreed_price_kop'),
    received: ev('sum', 'received_kop'),
    refunded: ev('sum', 'refunded_kop'),
    due: ev('sum', 'due_kop'),
    plannedCost: ev('sum', 'planned_cost_kop'),
    factCost: ev('sum', 'fact_cost_kop'),
    deviation: ev('sum', 'deviation_kop'),
    result: ev('sum', 'result_kop'),
  };
}

const W_SQL = 'unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e)';
const unnestW = (windows: readonly BranchWindow[]) => [windows.map((w) => w.branchId), windows.map((w) => w.start), windows.map((w) => w.end)];

/** Структура факта себестоимости по видам строк состава; расход без строки – «прочее». Σ групп = factCost. */
async function costStructure(tx: Tx, windows: readonly BranchWindow[]): Promise<Array<{ kind: string; amountKop: number }>> {
  if (windows.length === 0) return [];
  const r = await tx.query<{ kind: string; kop: string }>(
    `SELECT coalesce(m.line_kind, 'other') AS kind, sum(m.amount_kop) AS kop
     FROM app.rpt_event_results t JOIN ${W_SQL} ON w.branch_id = t.branch_id AND t.held_at >= w.s AND t.held_at < w.e
     JOIN app.rpt_event_money m ON m.event_id = t.event_id AND m.role = 'expense' AND m.in_cost AND NOT m.reversed
     GROUP BY 1 ORDER BY 1`,
    unnestW(windows),
  );
  return r.rows.map((x) => ({ kind: x.kind, amountKop: Number(x.kop) }));
}

async function byStatus(tx: Tx, windows: readonly BranchWindow[]): Promise<Array<{ status: string; count: number }>> {
  if (windows.length === 0) return [];
  const r = await tx.query<{ status: string; n: string }>(
    `SELECT t.status, count(*) AS n FROM app.rpt_event_results t JOIN ${W_SQL} ON w.branch_id = t.branch_id AND t.held_at >= w.s AND t.held_at < w.e GROUP BY 1 ORDER BY 1`,
    unnestW(windows),
  );
  return r.rows.map((x) => ({ status: x.status, count: Number(x.n) }));
}

export interface EventsResult {
  metrics: Record<EventsMetric, Metric>;
  groups: { byStatus: Array<{ status: string; count: number }>; costStructure: Array<{ kind: string; amountKop: number }> };
  labels: Record<string, string>;
  dateBasis: Record<EventsMetric, string>;
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

export async function eventsReport(env: ReportEnv, p: ReportParams): Promise<EventsResult> {
  const branches = await resolveBranches(env.tx, env.ctx, EVENTS_ACTION, p);
  const prevP = prevPeriod(p.period);
  const defs = eventsDefs();
  const cur = windowsOf(branches, p.period);
  const metrics = await computeMetrics(env.tx, defs, cur, windowsOf(branches, prevP));
  return {
    metrics,
    groups: { byStatus: await byStatus(env.tx, cur), costStructure: await costStructure(env.tx, cur) },
    labels: {
      money: 'Деньги – за всё время мероприятия, период – по дате проведения',
      result: 'Поступления − возвраты − прямые расходы в себестоимости; не бухгалтерская прибыль',
      deviation: 'Факт себестоимости − план; больше нуля – перерасход',
    },
    dateBasis: Object.fromEntries(Object.keys(defs).map((k) => [k, 'session_start'])) as Record<EventsMetric, string>,
    period: p.period,
    prevPeriod: prevP,
    computedAt: env.clock.now().toISOString(),
    dayRule: DAY_RULE,
  };
}

export interface EventDetailRow {
  eventId: string;
  number: string;
  branchId: string;
  heldLocal: string;
  status: string;
  hasBooking: boolean;
  agreedKop: number;
  receivedKop: number;
  refundedKop: number;
  dueKop: number;
  plannedCostKop: number;
  factCostKop: number;
  resultKop: number;
  value: number;
}

interface Row { event_id: string; number: string; branch_id: string; held_at: Date; status: string; has_booking: boolean; [k: string]: unknown }

export async function eventsDetail(
  env: ReportEnv,
  p: ReportParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: EventDetailRow[]; total: Metric; nextCursor: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, EVENTS_ACTION, p);
  const def = metricDef(eventsDefs(), metric);
  const page = await detailPage<Row>(env.tx, def, windowsOf(branches, p.period), opts);
  const zones = new Map(branches.map((b) => [b.id, b.timezone]));
  const n = (r: Row, c: string) => Number(r[c]);
  const rows = page.rows.map((r): EventDetailRow => ({
    eventId: r.event_id, number: r.number, branchId: r.branch_id, heldLocal: localAt(env, r.held_at, zones.get(r.branch_id)!), status: r.status, hasBooking: r.has_booking,
    agreedKop: n(r, 'agreed_price_kop'), receivedKop: n(r, 'received_kop'), refundedKop: n(r, 'refunded_kop'), dueKop: n(r, 'due_kop'), plannedCostKop: n(r, 'planned_cost_kop'),
    factCostKop: n(r, 'fact_cost_kop'), resultKop: n(r, 'result_kop'), value: def.agg === 'count' ? 1 : n(r, def.col!),
  }));
  return { rows, total: page.total.rows === 0 ? noData : okMetric(page.total.value, def.unit), nextCursor: page.nextCursor };
}
