// Точки графика по дням для отчётов на MetricDef (K11 №240 `series`, 14 §15) – та же форма, что у загрузки (utilization.ts
// utilizationSeries): `{ points: [{ bucket: 'ГГГГ-ММ-ДД', <показатель>: число }], zoneNote }`, точка на каждый день периода, нет
// записей – 0. Считается в том же снимке и тем же where(spec), что итог карточки: окно точки – сутки филиала (K8), сеть – сумма
// филиалов по своим суткам (Q-83), поэтому Σ точек count и sum = итог показателя за период; count_distinct и avg – по дню (их Σ итогу
// не равна, как и на карточке). Запись без филиала (баллы, зарплата, уведомления в сетевой области) – сутки UTC, как payroll_at K3.
// Только по запросу `series=day` (report-handlers.ts) – не чаще запроса отчёта; показатели «на момент запроса» (без колонки даты)
// точек не дают. Нажатие на точку открывает детализацию с сегментом `day:<bucket>` (segment.ts).
import { addDays, branchDay, type LocalDate } from '../../core/time.ts';
import { resolveBranches, where, type BranchWindow, type MetricDef, type Period, type ReportEnv, type ReportParams } from './framework.ts';

export interface DayPoint {
  bucket: string;
  [metric: string]: number | string;
}

export interface DaySeries {
  points: DayPoint[];
  zoneNote: string | null;
}

export interface DaySeriesOpts {
  /** Источник со строками без филиала (spec.nullableBranch): в сетевой области без фильтра они входят сутками UTC. */
  networkRows?: boolean | undefined;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function days(p: Period): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Агрегат точки – как aggSql итога (framework.ts), по колонке подзапроса c. */
function pointAgg(def: MetricDef): string {
  if (def.agg !== 'count' && !IDENT_RE.test(def.col ?? '')) throw new Error('reports: недопустимое имя столбца');
  switch (def.agg) {
    case 'count':
      return 'count(*)';
    case 'sum':
      return 'coalesce(sum(x.c), 0)';
    case 'avg':
      return 'avg(x.c)';
    case 'count_distinct':
      return 'count(DISTINCT x.c)';
  }
}

export async function daySeries(env: ReportEnv, action: string, p: ReportParams, defs: Record<string, MetricDef>, opts: DaySeriesOpts = {}): Promise<DaySeries> {
  const branches = await resolveBranches(env.tx, env.ctx, action, p);
  const list = days(p.period);
  const keys = Object.keys(defs).filter((k) => defs[k]!.spec.date !== undefined);
  const points: DayPoint[] = list.map((bucket) => ({ bucket, ...Object.fromEntries(keys.map((k) => [k, 0])) }));
  // окно на каждую пару день × филиал; дата точки – по позиции окна (та же, что у w в where(spec))
  const windows: BranchWindow[] = [];
  const dayOf: LocalDate[] = [];
  const networkWide = opts.networkRows === true && env.ctx.network && !p.cityId && !p.branchIds?.length && branches.length > 0;
  for (const d of list) {
    for (const b of branches) {
      const day = branchDay(d, b.timezone);
      windows.push({ branchId: b.id, start: day.start, end: day.end });
      dayOf.push(d);
    }
    if (networkWide) {
      windows.push({ branchId: null, start: new Date(`${d}T00:00:00Z`), end: new Date(`${addDays(d, 1)}T00:00:00Z`) });
      dayOf.push(d);
    }
  }
  if (windows.length === 0 || keys.length === 0) return { points, zoneNote: null };
  const at = new Map(points.map((pt, i) => [pt.bucket, i]));
  for (const key of keys) {
    const def = defs[key]!;
    const w = where(def.spec, windows);
    const params = [...w.params, dayOf];
    const col = def.agg === 'count' ? '' : `t.${def.col} AS c, `;
    const r = await env.tx.query<{ day: string; v: string | null }>(
      `SELECT d.day::text AS day, ${pointAgg(def)} AS v
       FROM (SELECT ${col}w.branch_id AS b, w.s AS s FROM ${w.sql}) x
       JOIN unnest($1::uuid[], $2::timestamptz[], $${params.length}::date[]) AS d(b, s, day) ON d.s = x.s AND d.b IS NOT DISTINCT FROM x.b
       GROUP BY d.day`,
      params,
    );
    for (const row of r.rows) {
      const i = at.get(row.day);
      if (i !== undefined) points[i]![key] = Number(row.v ?? 0);
    }
  }
  return { points, zoneNote: null };
}

/** Клиенты (3.6): посещения профилей и клиенты с посещением по дням – те же строки rpt_visits, что clients.ts (client_kind = 'profile').
 *  «Впервые», «вернувшиеся», «новые профили» зависят от истории всей сети и филиала клиента – по дням не считаются. */
export function clientsSeriesDefs(): Record<string, MetricDef> {
  const visits = (extra: Partial<MetricDef> = {}): MetricDef => ({
    spec: { view: 'app.rpt_visits', date: 'planned_start', conds: [{ sql: `t.client_kind = 'profile'` }] },
    agg: 'count', unit: 'count', dateBasis: 'session_start', idCol: 'visit_id', ...extra,
  });
  return { profileVisits: visits(), withVisit: visits({ agg: 'count_distinct', col: 'client_id' }) };
}
