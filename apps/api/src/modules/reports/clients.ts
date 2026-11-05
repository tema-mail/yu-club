// S4-66. Отчёт «Клиенты и повторные посещения» (K24 §3.6, 14 §9). Только профили: брони без профиля (guest) остаются в общей
// посещаемости 3.2 и сюда не входят (приёмка 12). История посещений для «впервые», «вернувшихся» и «повторных» – вся сеть
// (решение: первый приход в клуб – факт о клиенте, а не о филиале); в строках по филиалу считается филиал посещения, поэтому
// итог сети не равен сумме филиалов (подпись). Новый профиль ≠ первый визит. Детализация обезличена без client.view.full (K24 §6).
import type { Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import {
  computeMetrics, loadMaskedClients, metricDef, noData, okMetric, prevPeriod, resolveBranches, runDetail, windowsOf,
  type BranchWindow, type MaskedClient, type Metric, type MetricDef, type MetricSpec, type Period, type ReportEnv, type ReportParams, DAY_RULE,
} from './framework.ts';

export const CLIENTS_ACTION = 'reports.clients.view';
export const CLIENTS_LABELS = { byBranch: 'Один клиент может быть в нескольких филиалах: итог сети не равен сумме филиалов' };

const VISITS = 'app.rpt_visits';
const PROFILE: NonNullable<MetricSpec['conds']>[number] = { sql: `t.client_kind = 'profile'` };
const distinctClients = (conds: NonNullable<MetricSpec['conds']>, date: string | null = 'planned_start'): MetricDef => ({
  spec: { view: VISITS, ...(date ? { date } : {}), conds: [PROFILE, ...conds] },
  agg: 'count_distinct', col: 'client_id', unit: 'count', dateBasis: 'session_start', idCol: 'client_id',
});

export type ClientsPeriodMetric = 'withVisit' | 'firstTime' | 'returning' | 'repeat' | 'notVisited' | 'profileVisits';

export function clientsDefs(): Record<ClientsPeriodMetric, MetricDef> {
  const hist = (extra: string) => `(SELECT 1 FROM ${VISITS} h WHERE h.client_id = t.client_id ${extra})`;
  return {
    withVisit: distinctClients([]),
    // первый за всю историю приход попал в период: раньше окна посещений нет
    firstTime: distinctClients([{ sql: `NOT EXISTS ${hist('AND h.planned_start < w.s')}` }]),
    returning: distinctClients([{ sql: `EXISTS ${hist('AND h.planned_start < w.s')}` }]),
    repeat: distinctClients([{ sql: `(SELECT count(*) FROM ${VISITS} h WHERE h.client_id = t.client_id) >= 2` }]),
    notVisited: distinctClients([{ sql: `t.planned_start < w.s AND NOT EXISTS ${hist('AND h.planned_start >= w.s AND h.planned_start < w.e')}` }], null),
    profileVisits: { spec: { view: VISITS, date: 'planned_start', conds: [PROFILE] }, agg: 'count', unit: 'count', dateBasis: 'session_start', idCol: 'visit_id' },
  };
}

const arr = (w: readonly BranchWindow[]): [Array<string | null>, Date[], Date[]] => [w.map((x) => x.branchId), w.map((x) => x.start), w.map((x) => x.end)];

// ---- новые профили: у клиента нет филиала, поэтому сеть – все профили периода, зона – профили с бронью в её филиалах (TC-16)

interface NewProfilesScope {
  networkWide: boolean;
  windows: readonly BranchWindow[];
}

function newProfilesFrom(s: NewProfilesScope): { sql: string; params: unknown[] } {
  const [ids, starts, ends] = arr(s.windows);
  if (s.networkWide) {
    return {
      sql: `app.rpt_clients t WHERE t.status <> 'guest' AND t.created_at >= (SELECT min(x) FROM unnest($1::timestamptz[]) x) AND t.created_at < (SELECT max(x) FROM unnest($2::timestamptz[]) x)`,
      params: [starts, ends],
    };
  }
  return {
    sql: `app.rpt_clients t WHERE t.status <> 'guest' AND EXISTS (
            SELECT 1 FROM app.rpt_bookings b JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e) ON w.branch_id = b.branch_id
            WHERE b.client_id = t.client_id AND t.created_at >= w.s AND t.created_at < w.e)`,
    params: [ids, starts, ends],
  };
}

async function countNew(tx: Tx, s: NewProfilesScope): Promise<number> {
  if (s.windows.length === 0) return 0;
  const f = newProfilesFrom(s);
  return Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${f.sql}`, f.params)).rows[0]!.n);
}

// ---- средний интервал: по клиентам с ≥ 2 посещениями в периоде, разницы соседних planned_start

const DAY_SEC = 86_400;

async function intervalRows(tx: Tx, windows: readonly BranchWindow[]): Promise<Array<{ client_id: string; branch_id: string; days: number }>> {
  if (windows.length === 0) return [];
  const [ids, starts, ends] = arr(windows);
  const r = await tx.query<{ client_id: string; branch_id: string; days: string }>(
    `WITH v AS (
       SELECT t.client_id, t.branch_id, t.planned_start,
              lag(t.planned_start) OVER (PARTITION BY t.client_id ORDER BY t.planned_start) AS prev
       FROM ${VISITS} t JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e)
         ON w.branch_id = t.branch_id AND t.planned_start >= w.s AND t.planned_start < w.e
       WHERE t.client_kind = 'profile'
     )
     SELECT client_id, min(branch_id::text) AS branch_id, avg(extract(epoch FROM planned_start - prev)) / ${DAY_SEC} AS days
     FROM v WHERE prev IS NOT NULL GROUP BY client_id ORDER BY client_id`,
    [ids, starts, ends],
  );
  return r.rows.map((x) => ({ client_id: x.client_id, branch_id: x.branch_id, days: Number(x.days) }));
}

const avg = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---- отчёт

export type ClientsMetric = ClientsPeriodMetric | 'newProfiles' | 'visitsPerClient' | 'avgIntervalDays';

export interface ClientsBranchGroup {
  branchId: string;
  metrics: Record<ClientsPeriodMetric, Metric>;
}

export interface ClientsResult {
  metrics: Record<ClientsMetric, Metric>;
  groups: { byBranch: ClientsBranchGroup[] };
  labels: typeof CLIENTS_LABELS;
  dateBasis: Record<ClientsMetric, string>;
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

const isNetworkWide = (env: ReportEnv, p: ReportParams): boolean => env.ctx.network && !p.cityId && !p.branchIds?.length;

export async function clientsReport(env: ReportEnv, p: ReportParams): Promise<ClientsResult> {
  const branches = await resolveBranches(env.tx, env.ctx, CLIENTS_ACTION, p);
  const prevP = prevPeriod(p.period);
  const cur = windowsOf(branches, p.period);
  const prev = windowsOf(branches, prevP);
  const defs = clientsDefs();
  const base = await computeMetrics(env.tx, defs, cur, prev);
  const networkWide = isNetworkWide(env, p);
  const newCur = await countNew(env.tx, { networkWide, windows: cur });
  const newPrev = await countNew(env.tx, { networkWide, windows: prev });
  const valueOf = (m: Metric): number | null => (m.state === 'ok' ? m.value : null);
  const prevOf = (m: Metric): number | null => (m.state === 'ok' ? (m.prev ?? null) : null);
  const visits = valueOf(base.profileVisits);
  const withVisit = valueOf(base.withVisit);
  const prevVisits = prevOf(base.profileVisits);
  const prevWith = prevOf(base.withVisit);
  const iv = await intervalRows(env.tx, cur);
  const ivPrev = await intervalRows(env.tx, prev);
  const byBranch: ClientsBranchGroup[] = [];
  if (branches.length > 1) {
    for (const b of branches) byBranch.push({ branchId: b.id, metrics: await computeMetrics(env.tx, defs, windowsOf([b], p.period), []) });
  }
  const metrics: Record<ClientsMetric, Metric> = {
    ...base,
    newProfiles: newCur === 0 && newPrev === 0 && visits === null ? noData : okMetric(newCur, 'count', newPrev),
    visitsPerClient: visits !== null && withVisit ? okMetric(visits / withVisit, 'count', prevVisits !== null && prevWith ? prevVisits / prevWith : null) : noData,
    avgIntervalDays: iv.length ? okMetric(avg(iv.map((x) => x.days)), 'days', ivPrev.length ? avg(ivPrev.map((x) => x.days)) : null) : noData,
  };
  return {
    metrics,
    groups: { byBranch },
    labels: CLIENTS_LABELS,
    dateBasis: {
      withVisit: 'session_start', firstTime: 'session_start', returning: 'session_start', repeat: 'session_start', notVisited: 'session_start',
      profileVisits: 'session_start', newProfiles: 'created_at', visitsPerClient: 'session_start', avgIntervalDays: 'session_start',
    },
    period: p.period,
    prevPeriod: prevP,
    computedAt: env.clock.now().toISOString(),
    dayRule: DAY_RULE,
  };
}

// ---- детализация

export interface ClientDetailRow {
  clientId: string;
  client: MaskedClient | null;
  branchId: string | null;
  value: number;
}

/** Строка = клиент (обезличена по K24 §6), value – вклад клиента: 1, число посещений или средний интервал. */
export async function clientsDetail(
  env: ReportEnv,
  p: ReportParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: ClientDetailRow[]; total: Metric; nextCursor: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, CLIENTS_ACTION, p);
  const windows = windowsOf(branches, p.period);
  const mask = async (rows: Array<{ clientId: string; branchId: string | null; value: number }>): Promise<ClientDetailRow[]> => {
    const fallback = branches[0]?.id ?? '';
    const masked = await loadMaskedClients(env.main, env.ctx, rows.map((r) => ({ clientId: r.clientId, branchId: r.branchId ?? fallback })));
    return rows.map((r) => ({ ...r, client: masked.get(`${r.clientId}:${r.branchId ?? fallback}`) ?? null }));
  };
  if (metric === 'avgIntervalDays') {
    const rows = await intervalRows(env.tx, windows);
    return {
      rows: await mask(rows.map((r) => ({ clientId: r.client_id, branchId: r.branch_id, value: r.days }))),
      total: rows.length ? okMetric(avg(rows.map((r) => r.days)), 'days') : noData,
      nextCursor: null,
    };
  }
  if (metric === 'newProfiles') {
    const f = windows.length ? newProfilesFrom({ networkWide: isNetworkWide(env, p), windows }) : null;
    const rows = f ? (await env.tx.query<{ client_id: string }>(`SELECT t.client_id FROM ${f.sql} ORDER BY t.client_id LIMIT 10000`, f.params)).rows : [];
    return { rows: await mask(rows.map((r) => ({ clientId: r.client_id, branchId: null, value: 1 }))), total: rows.length ? okMetric(rows.length, 'count') : noData, nextCursor: null };
  }
  if (metric === 'visitsPerClient') {
    if (windows.length === 0) return { rows: [], total: noData, nextCursor: null };
    const [ids, starts, ends] = arr(windows);
    const rows = (
      await env.tx.query<{ client_id: string; branch_id: string; n: string }>(
        `SELECT t.client_id, min(t.branch_id::text) AS branch_id, count(*) AS n FROM ${VISITS} t
         JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e) ON w.branch_id = t.branch_id AND t.planned_start >= w.s AND t.planned_start < w.e
         WHERE t.client_kind = 'profile' GROUP BY t.client_id ORDER BY t.client_id`,
        [ids, starts, ends],
      )
    ).rows;
    const values = rows.map((r) => Number(r.n));
    return {
      rows: await mask(rows.map((r) => ({ clientId: r.client_id, branchId: r.branch_id, value: Number(r.n) }))),
      total: rows.length ? okMetric(avg(values), 'count') : noData,
      nextCursor: null,
    };
  }
  if (typeof metric !== 'string') throw new AppError('REPORT_FILTER_INVALID', 422, 'Неизвестный показатель', { field: 'metric' });
  const def = metricDef(clientsDefs(), metric);
  const page = await runDetail<{ client_id: string; branch_id: string; visit_id: string }>(env, CLIENTS_ACTION, p, def, opts);
  return { rows: await mask(page.rows.map((r) => ({ clientId: r.client_id, branchId: r.branch_id, value: 1 }))), total: page.total, nextCursor: page.nextCursor };
}
