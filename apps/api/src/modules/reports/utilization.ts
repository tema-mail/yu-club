// S4-64. Отчёт «Загрузка ресурсов» (K24 §3.3, 14 §6). Считается по единице занятости: плановое время A – network.openIntervalsRange
// (источник истины расписания, один вызов на филиал), блокировки, брони и посещения – мультидиапазоны PostgreSQL 16: range_agg
// склеивает пересечения, поэтому двойного счёта нет. Блокировка учитывается только внутри A и из A не вычитается (иначе ремонт
// поднимал бы загрузку, решение K24). VR1 и VR2 – отдельными строками, PS4 (нет своего ресурса, self_bookable = false) не входит;
// аренда комнаты целиком занимает обе единицы и показывается дополнительной строкой без сложения с ними.
import type { Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can } from '../../core/permissions.ts';
import { branchDay, instantToLocal, parseLocalDate, type Interval, type LocalDate, type TimeZone } from '../../core/time.ts';
import { openIntervalsRange } from '../network/calendar.ts';
import type { BranchInfo } from '../network/index.ts';
import { DAY_RULE, noData, okMetric, prevPeriod, resolveBranches, unavailable, windowsOf, type Metric, type Period, type ReportEnv, type ReportParams } from './framework.ts';

export const UTILIZATION_ACTION = 'reports.ops.view';

export interface UtilizationParams extends ReportParams {
  resourceType?: string[] | undefined;
}

export interface UnitRow {
  unitId: string;
  unitName: string;
  resourceId: string;
  resourceType: string;
  roomId: string | null;
  branchId: string;
  branchName: string;
  availableMin: number;
  blockedMin: number;
  technicalMin: number;
  bookedMin: number;
  usedMin: number;
  freeMin: number;
}

export type UtilizationMetric = 'available' | 'blocked' | 'technical' | 'booked' | 'used' | 'free' | 'actualLoad' | 'commercialLoad';
export const UTILIZATION_MINUTES: Record<Exclude<UtilizationMetric, 'actualLoad' | 'commercialLoad'>, keyof UnitRow> = {
  available: 'availableMin', blocked: 'blockedMin', technical: 'technicalMin', booked: 'bookedMin', used: 'usedMin', free: 'freeMin',
};

interface UnitInfo {
  unit_id: string;
  unit_name: string;
  resource_id: string;
  resource_type: string;
  room_id: string | null;
  branch_id: string;
}

async function unitsOf(tx: Tx, branches: readonly BranchInfo[], p: UtilizationParams): Promise<UnitInfo[]> {
  if (branches.length === 0) return [];
  const r = await tx.query<UnitInfo>(
    `SELECT unit_id, unit_name, resource_id, resource_type, room_id, branch_id FROM app.rpt_units
     WHERE branch_id = ANY($1::uuid[]) AND self_bookable AND resource_id IS NOT NULL AND status = 'active'
       AND ($2::text[] IS NULL OR resource_type = ANY($2::text[]))
     ORDER BY branch_id, unit_name`,
    [branches.map((b) => b.id), p.resourceType?.length ? p.resourceType : null],
  );
  return r.rows;
}

/** Открытые интервалы единиц периода: один вызов openIntervalsRange на филиал (K24 §3.3). */
async function openOfUnits(tx: Tx, branches: readonly BranchInfo[], units: readonly UnitInfo[], period: Period): Promise<Map<string, Interval[]>> {
  const out = new Map<string, Interval[]>();
  for (const b of branches) {
    const mine = units.filter((u) => u.branch_id === b.id);
    if (mine.length === 0) continue;
    const range = await openIntervalsRange(tx, {
      branchId: b.id, from: period.from, to: period.to,
      resources: mine.map((u) => ({ resourceId: u.resource_id, roomId: u.room_id })),
    });
    for (const u of mine) {
      const list: Interval[] = [];
      for (const day of range.values()) list.push(...(day.get(u.resource_id) ?? []));
      out.set(u.unit_id, list);
    }
  }
  return out;
}

const MINUTES = (m: string) => `(SELECT coalesce(round(sum(extract(epoch FROM upper(r) - lower(r))) / 60), 0)::bigint FROM unnest(${m}) AS r)`;

/** Массивы для unnest: единица и границы открытых интервалов. */
function openArrays(open: ReadonlyMap<string, Interval[]>): [string[], Date[], Date[]] {
  const ids: string[] = [];
  const starts: Date[] = [];
  const ends: Date[] = [];
  for (const [id, list] of open) {
    for (const i of list) {
      ids.push(id);
      starts.push(i.start);
      ends.push(i.end);
    }
  }
  return [ids, starts, ends];
}

const OPEN_CTE = `a AS (SELECT x.unit_id, range_agg(tstzrange(x.s, x.e, '[)')) AS m
                        FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS x(unit_id, s, e) GROUP BY x.unit_id),
  hull AS (SELECT min(s) AS s, max(e) AS e FROM unnest($2::timestamptz[], $3::timestamptz[]) AS y(s, e))`;

async function unitRows(tx: Tx, branches: readonly BranchInfo[], units: readonly UnitInfo[], period: Period): Promise<UnitRow[]> {
  const open = await openOfUnits(tx, branches, units, period);
  const [ids, starts, ends] = openArrays(open);
  const byUnit = new Map<string, { a: string; l: string; t: string; bk: string; f: string; free: string }>();
  if (ids.length > 0) {
    const r = await tx.query<{ unit_id: string; a: string; l: string; t: string; bk: string; f: string; free: string }>(
      `WITH ${OPEN_CTE},
       booked AS (SELECT u.unit_id, u.period, u.booking_id FROM app.rpt_unit_booked u, hull
                  WHERE u.unit_id = ANY($1::uuid[]) AND u.period && tstzrange(hull.s, hull.e, '[)')),
       bk AS (SELECT unit_id, range_agg(period) AS m FROM booked GROUP BY unit_id),
       f AS (SELECT b.unit_id, range_agg(b.period) AS m FROM booked b JOIN app.rpt_visits v ON v.booking_id = b.booking_id GROUP BY b.unit_id),
       blocks AS (SELECT u.unit_id, u.period, u.kind FROM app.rpt_unit_blocks u, hull
                  WHERE u.unit_id = ANY($1::uuid[]) AND u.period && tstzrange(hull.s, hull.e, '[)')),
       l AS (SELECT unit_id, range_agg(period) AS m FROM blocks GROUP BY unit_id),
       t AS (SELECT unit_id, range_agg(period) AS m FROM blocks WHERE kind IN ('repair', 'maintenance') GROUP BY unit_id)
       SELECT a.unit_id, ${MINUTES('a.m')} AS a,
              ${MINUTES(`coalesce(l.m, '{}'::tstzmultirange) * a.m`)} AS l,
              ${MINUTES(`coalesce(t.m, '{}'::tstzmultirange) * a.m`)} AS t,
              ${MINUTES(`coalesce(bk.m, '{}'::tstzmultirange) * a.m`)} AS bk,
              ${MINUTES(`coalesce(f.m, '{}'::tstzmultirange) * a.m`)} AS f,
              ${MINUTES(`a.m - (coalesce(bk.m, '{}'::tstzmultirange) + coalesce(l.m, '{}'::tstzmultirange))`)} AS free
       FROM a LEFT JOIN l ON l.unit_id = a.unit_id LEFT JOIN t ON t.unit_id = a.unit_id
              LEFT JOIN bk ON bk.unit_id = a.unit_id LEFT JOIN f ON f.unit_id = a.unit_id`,
      [ids, starts, ends],
    );
    for (const row of r.rows) byUnit.set(row.unit_id, row);
  }
  const names = new Map(branches.map((b) => [b.id, b.name]));
  return units.map((u) => {
    const v = byUnit.get(u.unit_id);
    return {
      unitId: u.unit_id, unitName: u.unit_name, resourceId: u.resource_id, resourceType: u.resource_type, roomId: u.room_id,
      branchId: u.branch_id, branchName: names.get(u.branch_id) ?? '',
      availableMin: Number(v?.a ?? 0), blockedMin: Number(v?.l ?? 0), technicalMin: Number(v?.t ?? 0),
      bookedMin: Number(v?.bk ?? 0), usedMin: Number(v?.f ?? 0), freeMin: Number(v?.free ?? 0),
    };
  });
}

const sum = (rows: readonly UnitRow[], key: keyof UnitRow): number => rows.reduce((s, r) => s + (r[key] as number), 0);

function metricsOf(rows: readonly UnitRow[], prev: readonly UnitRow[]): Record<UtilizationMetric, Metric> {
  if (rows.length === 0) return Object.fromEntries((['available', 'blocked', 'technical', 'booked', 'used', 'free', 'actualLoad', 'commercialLoad'] as const).map((k) => [k, noData])) as Record<UtilizationMetric, Metric>;
  const A = sum(rows, 'availableMin');
  const pA = prev.length ? sum(prev, 'availableMin') : 0;
  const minutes = (key: keyof UnitRow): Metric => okMetric(sum(rows, key), 'minutes', prev.length ? sum(prev, key) : null);
  const pct = (key: keyof UnitRow): Metric => {
    if (A === 0) return unavailable('missing_input'); // A = 0: загрузка не определена, а не 0%
    return okMetric((sum(rows, key) / A) * 100, 'pct', pA > 0 ? (sum(prev, key) / pA) * 100 : null);
  };
  return {
    available: minutes('availableMin'), blocked: minutes('blockedMin'), technical: minutes('technicalMin'),
    booked: minutes('bookedMin'), used: minutes('usedMin'), free: minutes('freeMin'),
    actualLoad: pct('usedMin'), commercialLoad: pct('bookedMin'),
  };
}

export interface WholeRoomRow {
  branchId: string;
  roomId: string | null;
  bookings: number;
  minutes: number;
}

/** Дополнительная строка «Аренда комнаты целиком: N броней, M минут» – по броне один раз, а не по каждой единице. */
async function wholeRoomRows(tx: Tx, branches: readonly BranchInfo[], period: Period): Promise<WholeRoomRow[]> {
  if (branches.length === 0) return [];
  const w = windowsOf(branches, period);
  const r = await tx.query<{ branch_id: string; room_id: string | null; n: string; minutes: string }>(
    `WITH bk AS (
       SELECT DISTINCT ON (u.booking_id) u.booking_id, u.branch_id, u.room_id, u.period * tstzrange(x.s, x.e, '[)') AS part
       FROM app.rpt_unit_booked u JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS x(branch_id, s, e)
         ON x.branch_id = u.branch_id AND u.period && tstzrange(x.s, x.e, '[)')
       WHERE u.whole_room
     )
     SELECT branch_id, room_id, count(*) AS n, round(sum(extract(epoch FROM upper(part) - lower(part))) / 60)::bigint AS minutes
     FROM bk GROUP BY branch_id, room_id ORDER BY branch_id, room_id`,
    [w.map((x) => x.branchId), w.map((x) => x.start), w.map((x) => x.end)],
  );
  return r.rows.map((x) => ({ branchId: x.branch_id, roomId: x.room_id, bookings: Number(x.n), minutes: Number(x.minutes) }));
}

export interface UtilizationGroup {
  key: string;
  metrics: Record<UtilizationMetric, Metric>;
}

export interface UtilizationResult {
  metrics: Record<UtilizationMetric, Metric>;
  rows: UnitRow[];
  groups: { byBranch: UtilizationGroup[]; byResourceType: UtilizationGroup[]; wholeRoom: WholeRoomRow[] };
  labels: { commercialLoad: string; unit: string };
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dateBasis: 'session_start';
  dayRule: string;
}

function groupBy(rows: readonly UnitRow[], prev: readonly UnitRow[], key: 'branchId' | 'resourceType'): UtilizationGroup[] {
  const keys = [...new Set(rows.map((r) => r[key]))];
  return keys.map((k) => ({ key: k, metrics: metricsOf(rows.filter((r) => r[key] === k), prev.filter((r) => r[key] === k)) }));
}

export async function utilizationReport(env: ReportEnv, p: UtilizationParams): Promise<UtilizationResult> {
  const branches = await resolveBranches(env.tx, env.ctx, UTILIZATION_ACTION, p);
  const units = await unitsOf(env.tx, branches, p);
  const prevP = prevPeriod(p.period);
  const rows = await unitRows(env.tx, branches, units, p.period);
  const prev = await unitRows(env.tx, branches, units, prevP);
  return {
    metrics: metricsOf(rows, prev),
    rows,
    groups: { byBranch: groupBy(rows, prev, 'branchId'), byResourceType: groupBy(rows, prev, 'resourceType'), wholeRoom: await wholeRoomRows(env.tx, branches, p.period) },
    labels: { commercialLoad: 'не равна фактической: бронь может закончиться неявкой', unit: 'единица = место' },
    period: p.period,
    prevPeriod: prevP,
    computedAt: env.clock.now().toISOString(),
    dateBasis: 'session_start',
    dayRule: DAY_RULE,
  };
}

/** Детализация: строка = единица; сумма value по минутам = итог, у долей value – доля единицы. */
export async function utilizationDetail(env: ReportEnv, p: UtilizationParams, metric: unknown): Promise<{ rows: Array<UnitRow & { value: number | null }>; total: Metric }> {
  const r = await utilizationReport(env, p);
  if (typeof metric !== 'string' || !Object.hasOwn(r.metrics, metric)) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неизвестный показатель', { field: 'metric' });
  const key = metric as UtilizationMetric;
  const rows = r.rows.map((row) => {
    if (key === 'actualLoad' || key === 'commercialLoad') {
      const top = key === 'actualLoad' ? row.usedMin : row.bookedMin;
      return { ...row, value: row.availableMin > 0 ? (top / row.availableMin) * 100 : null };
    }
    return { ...row, value: row[UTILIZATION_MINUTES[key]] as number };
  });
  return { rows, total: r.metrics[key] };
}

// ---- график: по дням и по часам

export interface SeriesPoint {
  bucket: string; // дата филиала или час 00..23
  availableMin: number;
  usedMin: number;
  bookedMin: number;
}

function addToDays(target: Map<string, number>, iv: Interval, tz: TimeZone): void {
  let at = iv.start;
  while (at < iv.end) {
    const date = instantToLocal(at, tz).date;
    const stop = new Date(Math.min(branchDay(date, tz).end.getTime(), iv.end.getTime()));
    target.set(date, (target.get(date) ?? 0) + (stop.getTime() - at.getTime()) / 60_000);
    at = stop;
  }
}

function addToHours(target: Map<string, number>, iv: Interval, tz: TimeZone): void {
  let at = iv.start;
  while (at < iv.end) {
    const local = instantToLocal(at, tz).time;
    const minute = Number(local.slice(3, 5));
    const stop = new Date(Math.min(at.getTime() + (60 - minute) * 60_000 - at.getUTCSeconds() * 1000, iv.end.getTime()));
    const hour = local.slice(0, 2);
    target.set(hour, (target.get(hour) ?? 0) + (stop.getTime() - at.getTime()) / 60_000);
    at = stop;
  }
}

/** Интервалы мультидиапазона пересечения (строки «единица – интервал») для разбиения по ячейкам в зоне филиала. */
async function partsOf(tx: Tx, ids: string[], starts: Date[], ends: Date[]): Promise<Array<{ unit_id: string; kind: 'used' | 'booked'; s: Date; e: Date }>> {
  const r = await tx.query<{ unit_id: string; kind: 'used' | 'booked'; s: Date; e: Date }>(
    `WITH ${OPEN_CTE},
     booked AS (SELECT u.unit_id, u.period, u.booking_id FROM app.rpt_unit_booked u, hull
                WHERE u.unit_id = ANY($1::uuid[]) AND u.period && tstzrange(hull.s, hull.e, '[)')),
     bk AS (SELECT unit_id, range_agg(period) AS m FROM booked GROUP BY unit_id),
     f AS (SELECT b.unit_id, range_agg(b.period) AS m FROM booked b JOIN app.rpt_visits v ON v.booking_id = b.booking_id GROUP BY b.unit_id)
     SELECT a.unit_id, 'booked' AS kind, lower(r) AS s, upper(r) AS e FROM a JOIN bk ON bk.unit_id = a.unit_id, unnest(bk.m * a.m) AS r
     UNION ALL
     SELECT a.unit_id, 'used', lower(r), upper(r) FROM a JOIN f ON f.unit_id = a.unit_id, unnest(f.m * a.m) AS r`,
    [ids, starts, ends],
  );
  return r.rows;
}

/** Сеть по часам – только при одной зоне в выборке, иначе подпись «по местному времени каждого филиала» (Q-83). */
export async function utilizationSeries(env: ReportEnv, p: UtilizationParams, by: 'day' | 'hour'): Promise<{ points: SeriesPoint[]; zoneNote: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, UTILIZATION_ACTION, p);
  const units = await unitsOf(env.tx, branches, p);
  const open = await openOfUnits(env.tx, branches, units, p.period);
  const [ids, starts, ends] = openArrays(open);
  const tzOf = new Map(units.map((u) => [u.unit_id, branches.find((b) => b.id === u.branch_id)!.timezone]));
  const add = by === 'day' ? addToDays : addToHours;
  const available = new Map<string, number>();
  const used = new Map<string, number>();
  const booked = new Map<string, number>();
  for (const [unit, list] of open) for (const iv of list) add(available, iv, tzOf.get(unit)!);
  if (ids.length > 0) {
    for (const part of await partsOf(env.tx, ids, starts, ends)) add(part.kind === 'used' ? used : booked, { start: part.s, end: part.e }, tzOf.get(part.unit_id)!);
  }
  const points = [...new Set([...available.keys(), ...booked.keys(), ...used.keys()])].sort().map((bucket) => ({
    bucket, availableMin: Math.round(available.get(bucket) ?? 0), usedMin: Math.round(used.get(bucket) ?? 0), bookedMin: Math.round(booked.get(bucket) ?? 0),
  }));
  const zones = new Set(branches.map((b) => b.timezone));
  return { points, zoneNote: by === 'hour' && zones.size > 1 ? 'по местному времени каждого филиала' : null };
}

// ---- календарь единицы (K11 №242)

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UnitCalendar {
  unitId: string;
  date: LocalDate;
  open: Array<{ start: string; end: string }>;
  booked: Array<{ start: string; end: string }>;
  blocked: Array<{ start: string; end: string }>;
  free: Array<{ start: string; end: string }>;
}

export async function utilizationCalendar(env: ReportEnv, input: { unitId: unknown; date: unknown }): Promise<UnitCalendar> {
  if (typeof input.unitId !== 'string' || !UUID_RE.test(input.unitId)) throw notFound();
  let date: LocalDate;
  try {
    date = parseLocalDate(String(input.date));
  } catch {
    throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверная дата', { field: 'date' });
  }
  const u = (await env.tx.query<UnitInfo>(`SELECT unit_id, unit_name, resource_id, resource_type, room_id, branch_id FROM app.rpt_units WHERE unit_id = $1 AND resource_id IS NOT NULL`, [input.unitId])).rows[0];
  if (!u || !can(env.ctx, UTILIZATION_ACTION, { branchId: u.branch_id })) throw notFound();
  const branches = await resolveBranches(env.tx, env.ctx, UTILIZATION_ACTION, { branchIds: [u.branch_id] });
  const open = await openOfUnits(env.tx, branches, [u], { from: date, to: date });
  const list = open.get(u.unit_id) ?? [];
  const empty: UnitCalendar = { unitId: u.unit_id, date, open: [], booked: [], blocked: [], free: [] };
  if (list.length === 0) return empty;
  const [ids, starts, ends] = openArrays(open);
  const r = await env.tx.query<{ kind: 'open' | 'booked' | 'blocked' | 'free'; s: Date; e: Date }>(
    `WITH ${OPEN_CTE},
     bk AS (SELECT range_agg(u.period) AS m FROM app.rpt_unit_booked u, hull WHERE u.unit_id = $4 AND u.period && tstzrange(hull.s, hull.e, '[)')),
     l AS (SELECT range_agg(u.period) AS m FROM app.rpt_unit_blocks u, hull WHERE u.unit_id = $4 AND u.period && tstzrange(hull.s, hull.e, '[)')),
     parts AS (
       SELECT 'open' AS kind, a.m AS m FROM a
       UNION ALL SELECT 'booked', coalesce(bk.m, '{}'::tstzmultirange) * a.m FROM a, bk
       UNION ALL SELECT 'blocked', coalesce(l.m, '{}'::tstzmultirange) * a.m FROM a, l
       UNION ALL SELECT 'free', a.m - (coalesce(bk.m, '{}'::tstzmultirange) + coalesce(l.m, '{}'::tstzmultirange)) FROM a, bk, l
     )
     SELECT kind, lower(x) AS s, upper(x) AS e FROM parts, unnest(parts.m) AS x ORDER BY kind, s`,
    [ids, starts, ends, u.unit_id],
  );
  for (const row of r.rows) empty[row.kind].push({ start: row.s.toISOString(), end: row.e.toISOString() });
  return empty;
}

