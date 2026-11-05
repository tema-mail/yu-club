// S4-66. Отчёт «Клиенты и повторные посещения» (K24 §3.6, 14 §9). Только профили: брони без профиля (guest) остаются в общей
// посещаемости 3.2 и сюда не входят (приёмка 12). История посещений для «впервые», «вернувшихся» и «повторных» – вся сеть
// (решение: первый приход в клуб – факт о клиенте, а не о филиале); в строках по филиалу считается филиал посещения, поэтому
// итог сети не равен сумме филиалов (подпись). Новый профиль ≠ первый визит. Детализация обезличена без client.view.full (K24 §6).
import type { Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import {
  loadMaskedClients, noData, okMetric, pageByKey, pageLimit, prevPeriod, resolveBranches, uuidCursor, windowsOf,
  type BranchWindow, type MaskedClient, type Metric, type Period, type ReportEnv, type ReportParams, DAY_RULE,
} from './framework.ts';

export const CLIENTS_ACTION = 'reports.clients.view';
export const CLIENTS_LABELS = { byBranch: 'Один клиент может быть в нескольких филиалах: итог сети не равен сумме филиалов' };

const VISITS = 'app.rpt_visits';

export type ClientsPeriodMetric = 'withVisit' | 'firstTime' | 'returning' | 'repeat' | 'notVisited' | 'profileVisits';
const PERIOD_METRICS: readonly ClientsPeriodMetric[] = ['withVisit', 'firstTime', 'returning', 'repeat', 'notVisited', 'profileVisits'];

const arr = (w: readonly BranchWindow[]): [Array<string | null>, Date[], Date[]] => [w.map((x) => x.branchId), w.map((x) => x.start), w.map((x) => x.end)];

// ---- один проход по истории профилей: итог и детализация – из одних и тех же строк (Σ detail = aggregate, TC-20)

interface ClientStat {
  client_id: string;
  branch_id: string; // филиал посещения в периоде или до него – для маски
  visits: number; // посещений в периоде
  firstTime: boolean;
  returning: boolean;
  repeat: boolean;
  notVisited: boolean;
}

/** Строка на клиента области. История – вся сеть; «до периода» и «в периоде» – по суткам филиала посещения. */
async function clientStats(tx: Tx, windows: readonly BranchWindow[]): Promise<ClientStat[]> {
  if (windows.length === 0) return [];
  const [ids, starts, ends] = arr(windows);
  const r = await tx.query<{ client_id: string; branch_id: string; n: string; first_at: Date; total: string; window_start: Date | null; had_prior: boolean }>(
    `WITH w AS (SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS x(branch_id, s, e)),
     v AS (SELECT client_id, branch_id, planned_start FROM ${VISITS} WHERE client_kind = 'profile'),
     h AS (SELECT client_id, min(planned_start) AS first_at, count(*) AS total FROM v GROUP BY client_id),
     s AS (
       SELECT v.client_id, min(v.branch_id::text) AS branch_id,
              count(*) FILTER (WHERE v.planned_start >= w.s AND v.planned_start < w.e) AS n,
              min(w.s) FILTER (WHERE v.planned_start >= w.s AND v.planned_start < w.e) AS window_start,
              bool_or(v.planned_start < w.s) AS had_prior
       FROM v JOIN w ON w.branch_id = v.branch_id GROUP BY v.client_id
     )
     SELECT s.client_id, s.branch_id, s.n, h.first_at, h.total, s.window_start, s.had_prior
     FROM s JOIN h ON h.client_id = s.client_id ORDER BY s.client_id`,
    [ids, starts, ends],
  );
  return r.rows.map((x) => {
    const visits = Number(x.n);
    const first = visits > 0 && x.first_at.getTime() >= x.window_start!.getTime();
    return {
      client_id: x.client_id, branch_id: x.branch_id, visits, firstTime: first, returning: visits > 0 && !first,
      repeat: visits > 0 && Number(x.total) >= 2, notVisited: visits === 0 && x.had_prior,
    };
  });
}

const STAT_FILTERS: Record<Exclude<ClientsPeriodMetric, 'profileVisits'>, (s: ClientStat) => boolean> = {
  withVisit: (s) => s.visits > 0,
  firstTime: (s) => s.firstTime,
  returning: (s) => s.returning,
  repeat: (s) => s.repeat,
  notVisited: (s) => s.notVisited,
};

function statValues(stats: readonly ClientStat[]): Record<ClientsPeriodMetric, number> {
  const count = (k: Exclude<ClientsPeriodMetric, 'profileVisits'>) => stats.filter(STAT_FILTERS[k]).length;
  return {
    withVisit: count('withVisit'), firstTime: count('firstTime'), returning: count('returning'), repeat: count('repeat'), notVisited: count('notVisited'),
    profileVisits: stats.reduce((n, s) => n + s.visits, 0),
  };
}

/** Период без посещений профилей и истории области – no_data; прошлое значение – если и там есть записи. */
function periodMetrics(cur: readonly ClientStat[], prev: readonly ClientStat[] | null): Record<ClientsPeriodMetric, Metric> {
  const c = statValues(cur);
  const live = c.profileVisits > 0;
  const p = prev && statValues(prev);
  const hasPrev = p !== null && p.profileVisits > 0;
  return Object.fromEntries(PERIOD_METRICS.map((k) => {
    if (!live && !(k === 'notVisited' && c.notVisited > 0)) return [k, noData];
    return [k, okMetric(c[k], 'count', hasPrev ? p[k] : null)];
  })) as Record<ClientsPeriodMetric, Metric>;
}

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
  const stats = await clientStats(env.tx, cur);
  const base = periodMetrics(stats, await clientStats(env.tx, prev));
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
    for (const b of branches) byBranch.push({ branchId: b.id, metrics: periodMetrics(await clientStats(env.tx, windowsOf([b], p.period)), null) });
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
    const { slice, nextCursor } = pageByKey(rows, (r) => r.client_id, opts);
    return {
      rows: await mask(slice.map((r) => ({ clientId: r.client_id, branchId: r.branch_id, value: r.days }))),
      total: rows.length ? okMetric(avg(rows.map((r) => r.days)), 'days') : noData,
      nextCursor,
    };
  }
  if (metric === 'newProfiles') {
    const after = uuidCursor(opts.cursor);
    if (windows.length === 0) return { rows: [], total: noData, nextCursor: null };
    const scope = { networkWide: isNetworkWide(env, p), windows };
    const f = newProfilesFrom(scope);
    const limit = pageLimit(opts);
    const params = [...f.params, after, limit + 1];
    const found = (
      await env.tx.query<{ client_id: string }>(
        `SELECT t.client_id FROM ${f.sql} AND ($${params.length - 1}::uuid IS NULL OR t.client_id > $${params.length - 1}::uuid) ORDER BY t.client_id LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const rows = found.slice(0, limit);
    const total = await countNew(env.tx, scope); // из агрегата, а не из строк страницы (TC-20)
    return {
      rows: await mask(rows.map((r) => ({ clientId: r.client_id, branchId: null, value: 1 }))),
      total: total > 0 ? okMetric(total, 'count') : noData,
      nextCursor: found.length > limit ? rows[rows.length - 1]!.client_id : null,
    };
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
    const { slice, nextCursor } = pageByKey(rows, (r) => r.client_id, opts);
    return {
      rows: await mask(slice.map((r) => ({ clientId: r.client_id, branchId: r.branch_id, value: Number(r.n) }))),
      total: rows.length ? okMetric(avg(values), 'count') : noData,
      nextCursor,
    };
  }
  if (metric === 'profileVisits' || (typeof metric === 'string' && Object.hasOwn(STAT_FILTERS, metric))) {
    const key = metric as ClientsPeriodMetric;
    const all = await clientStats(env.tx, windows);
    const chosen = key === 'profileVisits' ? all.filter((s) => s.visits > 0) : all.filter(STAT_FILTERS[key]);
    const { slice, nextCursor } = pageByKey(chosen, (s) => s.client_id, opts);
    const value = (s: ClientStat) => (key === 'profileVisits' ? s.visits : 1);
    const total = chosen.reduce((n, s) => n + value(s), 0);
    return {
      rows: await mask(slice.map((s) => ({ clientId: s.client_id, branchId: s.branch_id, value: value(s) }))),
      total: chosen.length ? okMetric(total, 'count') : noData,
      nextCursor,
    };
  }
  throw new AppError('REPORT_FILTER_INVALID', 422, 'Неизвестный показатель', { field: 'metric' });
}
