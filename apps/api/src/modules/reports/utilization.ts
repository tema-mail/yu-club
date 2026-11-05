// S4-64. Отчёт «Загрузка ресурсов» (K24 §3.3, 14 §6). Считается по единице занятости: плановое время A – network.openIntervalsRange
// (источник истины расписания, один вызов на филиал), блокировки, брони и посещения – мультидиапазоны PostgreSQL 16: range_agg
// склеивает пересечения, поэтому двойного счёта нет. Блокировка учитывается только внутри A и из A не вычитается (иначе ремонт
// поднимал бы загрузку, решение K24). VR1 и VR2 – отдельными строками, PS4 (нет своего ресурса, self_bookable = false) не входит;
// аренда комнаты целиком занимает обе единицы и показывается дополнительной строкой без сложения с ними.
// Единицы и составы – действовавшие в периоде (rpt_units.valid_period): архивация и смена состава историю не переписывают, A считается
// только в границах состава. Фактическая загрузка – F / A по прошедшему времени (факт обрезан текущим моментом), коммерческая – Bk / A
// по всему периоду (D4-20, Q-158).
import type { Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can } from '../../core/permissions.ts';
import { branchDay, instantToLocal, parseLocalDate, type Interval, type LocalDate, type TimeZone } from '../../core/time.ts';
import { openIntervalsRange, type BranchInfo } from '../network/index.ts';
import { DAY_RULE, noData, okMetric, pageByKey, prevPeriod, resolveBranches, unavailable, windowsOf, type Metric, type PageOpts, type Period, type ReportEnv, type ReportParams } from './framework.ts';

export const UTILIZATION_ACTION = 'reports.ops.view';

export interface UtilizationParams extends ReportParams {
  resourceType?: string[] | undefined;
  /** Сегмент детализации (K24 §10): один час суток '00'..'23' по зоне филиала. Все показатели считаются внутри A, значит и внутри часа. */
  hour?: string | undefined;
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
  availableElapsedMin: number; // часть A до текущего момента: база фактической загрузки
  blockedMin: number;
  technicalMin: number;
  bookedMin: number;
  usedMin: number;
  freeMin: number;
}

export type UtilizationMetric = 'available' | 'availableElapsed' | 'blocked' | 'technical' | 'booked' | 'used' | 'free' | 'actualLoad' | 'commercialLoad';
export const UTILIZATION_MINUTES: Record<Exclude<UtilizationMetric, 'actualLoad' | 'commercialLoad'>, keyof UnitRow> = {
  available: 'availableMin', availableElapsed: 'availableElapsedMin', blocked: 'blockedMin', technical: 'technicalMin', booked: 'bookedMin', used: 'usedMin', free: 'freeMin',
};

/** Состав, действовавший в периоде: ресурс и отрезок, когда он был «своим» для единицы (null – без границы). */
interface UnitPart {
  resourceId: string;
  start: Date | null;
  end: Date | null;
}

interface UnitInfo {
  unit_id: string;
  unit_name: string;
  resource_id: string; // последний состав периода – для строки отчёта
  resource_type: string;
  room_id: string | null;
  branch_id: string;
  parts: UnitPart[];
}

/** Единицы с составами, действовавшими в периоде. onlyUnit – календарь одной единицы (там и не сам-бронируемая). */
async function unitsOf(tx: Tx, branches: readonly BranchInfo[], p: { resourceType?: string[] | undefined }, period: Period, onlyUnit?: string): Promise<UnitInfo[]> {
  if (branches.length === 0) return [];
  const w = windowsOf(branches, period);
  const r = await tx.query<Omit<UnitInfo, 'parts'> & { vs: Date | null; ve: Date | null }>(
    `SELECT u.unit_id, u.unit_name, u.resource_id, u.resource_type, u.room_id, u.branch_id, lower(v) AS vs, upper(v) AS ve
     FROM app.rpt_units u
     JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS x(branch_id, s, e) ON x.branch_id = u.branch_id
     CROSS JOIN LATERAL unnest(u.valid_period) AS v
     WHERE u.resource_id IS NOT NULL AND v && tstzrange(x.s, x.e, '[)')
       AND ($4::text[] IS NULL OR u.resource_type = ANY($4::text[]))
       AND (CASE WHEN $5::uuid IS NULL THEN u.self_bookable ELSE u.unit_id = $5::uuid END)
     ORDER BY u.branch_id, u.unit_name, u.unit_id, lower(v) NULLS FIRST`,
    [w.map((x) => x.branchId), w.map((x) => x.start), w.map((x) => x.end), p.resourceType?.length ? p.resourceType : null, onlyUnit ?? null],
  );
  const out = new Map<string, UnitInfo>();
  for (const row of r.rows) {
    const { vs, ve, ...info } = row;
    const part: UnitPart = { resourceId: row.resource_id, start: vs, end: ve };
    const prev = out.get(row.unit_id);
    out.set(row.unit_id, { ...info, parts: [...(prev?.parts ?? []), part] });
  }
  return [...out.values()];
}

function clip(list: readonly Interval[], part: UnitPart): Interval[] {
  const lo = part.start?.getTime() ?? -Infinity;
  const hi = part.end?.getTime() ?? Infinity;
  return list.flatMap((i) => {
    const start = Math.max(i.start.getTime(), lo);
    const end = Math.min(i.end.getTime(), hi);
    return start < end ? [{ start: new Date(start), end: new Date(end) }] : [];
  });
}

/** Склейка пересечений: две строки состава одного времени не удваивают минуты графика. */
function mergeIntervals(list: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const i of [...list].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const last = out[out.length - 1];
    if (last && i.start.getTime() <= last.end.getTime()) {
      if (i.end > last.end) last.end = i.end;
    } else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** Части интервалов, попадающие в один час суток по зоне филиала. */
function onlyHour(list: readonly Interval[], tz: TimeZone, hour: string): Interval[] {
  const out: Interval[] = [];
  for (const iv of list) {
    let at = iv.start;
    while (at < iv.end) {
      const local = instantToLocal(at, tz).time;
      const stop = new Date(Math.min(at.getTime() + (60 - Number(local.slice(3, 5))) * 60_000 - at.getUTCSeconds() * 1000, iv.end.getTime()));
      if (local.slice(0, 2) === hour) out.push({ start: at, end: stop });
      at = stop;
    }
  }
  return out;
}

/** Открытые интервалы единиц периода: один вызов openIntervalsRange на филиал (K24 §3.3), затем обрезка составом и сегментом часа. */
async function openOfUnits(tx: Tx, branches: readonly BranchInfo[], units: readonly UnitInfo[], period: Period, hour?: string): Promise<Map<string, Interval[]>> {
  const out = new Map<string, Interval[]>();
  for (const b of branches) {
    const mine = units.filter((u) => u.branch_id === b.id);
    if (mine.length === 0) continue;
    const resources = new Map(mine.flatMap((u) => u.parts.map((part) => [part.resourceId, { resourceId: part.resourceId, roomId: u.room_id }] as const)));
    const range = await openIntervalsRange(tx, { branchId: b.id, from: period.from, to: period.to, resources: [...resources.values()] });
    for (const u of mine) {
      const list: Interval[] = [];
      for (const day of range.values()) for (const part of u.parts) list.push(...clip(day.get(part.resourceId) ?? [], part));
      const merged = mergeIntervals(list);
      out.set(u.unit_id, hour ? onlyHour(merged, b.timezone, hour) : merged);
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

/** До текущего момента ($4): база фактической загрузки и сам факт – идущее посещение не считается наперёд. */
const ELAPSED = `tstzmultirange(tstzrange(NULL, $4::timestamptz, '[)'))`;

async function unitRows(tx: Tx, branches: readonly BranchInfo[], units: readonly UnitInfo[], period: Period, now: Date, hour?: string): Promise<UnitRow[]> {
  const open = await openOfUnits(tx, branches, units, period, hour);
  const [ids, starts, ends] = openArrays(open);
  const byUnit = new Map<string, { a: string; ae: string; l: string; t: string; bk: string; f: string; free: string }>();
  if (ids.length > 0) {
    const r = await tx.query<{ unit_id: string; a: string; ae: string; l: string; t: string; bk: string; f: string; free: string }>(
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
              ${MINUTES(`a.m * ${ELAPSED}`)} AS ae,
              ${MINUTES(`coalesce(l.m, '{}'::tstzmultirange) * a.m`)} AS l,
              ${MINUTES(`coalesce(t.m, '{}'::tstzmultirange) * a.m`)} AS t,
              ${MINUTES(`coalesce(bk.m, '{}'::tstzmultirange) * a.m`)} AS bk,
              ${MINUTES(`coalesce(f.m, '{}'::tstzmultirange) * a.m * ${ELAPSED}`)} AS f,
              ${MINUTES(`a.m - (coalesce(bk.m, '{}'::tstzmultirange) + coalesce(l.m, '{}'::tstzmultirange))`)} AS free
       FROM a LEFT JOIN l ON l.unit_id = a.unit_id LEFT JOIN t ON t.unit_id = a.unit_id
              LEFT JOIN bk ON bk.unit_id = a.unit_id LEFT JOIN f ON f.unit_id = a.unit_id`,
      [ids, starts, ends, now],
    );
    for (const row of r.rows) byUnit.set(row.unit_id, row);
  }
  const names = new Map(branches.map((b) => [b.id, b.name]));
  return units.map((u) => {
    const v = byUnit.get(u.unit_id);
    return {
      unitId: u.unit_id, unitName: u.unit_name, resourceId: u.resource_id, resourceType: u.resource_type, roomId: u.room_id,
      branchId: u.branch_id, branchName: names.get(u.branch_id) ?? '',
      availableMin: Number(v?.a ?? 0), availableElapsedMin: Number(v?.ae ?? 0), blockedMin: Number(v?.l ?? 0), technicalMin: Number(v?.t ?? 0),
      bookedMin: Number(v?.bk ?? 0), usedMin: Number(v?.f ?? 0), freeMin: Number(v?.free ?? 0),
    };
  });
}

const sum = (rows: readonly UnitRow[], key: keyof UnitRow): number => rows.reduce((s, r) => s + (r[key] as number), 0);

function metricsOf(rows: readonly UnitRow[], prev: readonly UnitRow[]): Record<UtilizationMetric, Metric> {
  if (rows.length === 0) return Object.fromEntries((['available', 'availableElapsed', 'blocked', 'technical', 'booked', 'used', 'free', 'actualLoad', 'commercialLoad'] as const).map((k) => [k, noData])) as Record<UtilizationMetric, Metric>;
  const minutes = (key: keyof UnitRow): Metric => okMetric(sum(rows, key), 'minutes', prev.length ? sum(prev, key) : null);
  const pct = (key: keyof UnitRow, base: keyof UnitRow): Metric => {
    const A = sum(rows, base);
    const pA = prev.length ? sum(prev, base) : 0;
    if (A === 0) return unavailable('missing_input'); // A = 0: загрузка не определена, а не 0%
    return okMetric((sum(rows, key) / A) * 100, 'pct', pA > 0 ? (sum(prev, key) / pA) * 100 : null);
  };
  return {
    available: minutes('availableMin'), availableElapsed: minutes('availableElapsedMin'), blocked: minutes('blockedMin'), technical: minutes('technicalMin'),
    booked: minutes('bookedMin'), used: minutes('usedMin'), free: minutes('freeMin'),
    actualLoad: pct('usedMin', 'availableElapsedMin'), commercialLoad: pct('bookedMin', 'availableMin'),
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
  labels: { actualLoad: string; commercialLoad: string; unit: string };
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
  const prevP = prevPeriod(p.period);
  const now = env.clock.now();
  const rows = await unitRows(env.tx, branches, await unitsOf(env.tx, branches, p, p.period), p.period, now, p.hour);
  const prev = await unitRows(env.tx, branches, await unitsOf(env.tx, branches, p, prevP), prevP, now, p.hour);
  return {
    metrics: metricsOf(rows, prev),
    rows,
    groups: { byBranch: groupBy(rows, prev, 'branchId'), byResourceType: groupBy(rows, prev, 'resourceType'), wholeRoom: await wholeRoomRows(env.tx, branches, p.period) },
    labels: { actualLoad: 'к прошедшему времени периода', commercialLoad: 'ко всему периоду; не равна фактической: бронь может закончиться неявкой', unit: 'единица = место' },
    period: p.period,
    prevPeriod: prevP,
    computedAt: env.clock.now().toISOString(),
    dateBasis: 'session_start',
    dayRule: DAY_RULE,
  };
}

/** Детализация: строка = единица; сумма value по минутам = итог, у долей value – доля единицы. */
export async function utilizationDetail(env: ReportEnv, p: UtilizationParams, metric: unknown, opts: PageOpts = {}): Promise<{ rows: Array<UnitRow & { value: number | null }>; total: Metric; nextCursor: string | null }> {
  const r = await utilizationReport(env, p);
  if (typeof metric !== 'string' || !Object.hasOwn(r.metrics, metric)) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неизвестный показатель', { field: 'metric' });
  const key = metric as UtilizationMetric;
  const { slice, nextCursor } = pageByKey([...r.rows].sort((a, b) => (a.unitId < b.unitId ? -1 : 1)), (row) => row.unitId, opts);
  const rows = slice.map((row) => {
    if (key === 'actualLoad' || key === 'commercialLoad') {
      const top = key === 'actualLoad' ? row.usedMin : row.bookedMin;
      const base = key === 'actualLoad' ? row.availableElapsedMin : row.availableMin;
      return { ...row, value: base > 0 ? (top / base) * 100 : null };
    }
    return { ...row, value: row[UTILIZATION_MINUTES[key]] as number };
  });
  return { rows, total: r.metrics[key], nextCursor };
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
async function partsOf(tx: Tx, ids: string[], starts: Date[], ends: Date[], now: Date): Promise<Array<{ unit_id: string; kind: 'used' | 'booked'; s: Date; e: Date }>> {
  const r = await tx.query<{ unit_id: string; kind: 'used' | 'booked'; s: Date; e: Date }>(
    `WITH ${OPEN_CTE},
     booked AS (SELECT u.unit_id, u.period, u.booking_id FROM app.rpt_unit_booked u, hull
                WHERE u.unit_id = ANY($1::uuid[]) AND u.period && tstzrange(hull.s, hull.e, '[)')),
     bk AS (SELECT unit_id, range_agg(period) AS m FROM booked GROUP BY unit_id),
     f AS (SELECT b.unit_id, range_agg(b.period) AS m FROM booked b JOIN app.rpt_visits v ON v.booking_id = b.booking_id GROUP BY b.unit_id)
     SELECT a.unit_id, 'booked' AS kind, lower(r) AS s, upper(r) AS e FROM a JOIN bk ON bk.unit_id = a.unit_id, unnest(bk.m * a.m) AS r
     UNION ALL
     SELECT a.unit_id, 'used', lower(r), upper(r) FROM a JOIN f ON f.unit_id = a.unit_id, unnest(f.m * a.m * ${ELAPSED}) AS r`,
    [ids, starts, ends, now],
  );
  return r.rows;
}

/** Сеть по часам – только при одной зоне в выборке, иначе подпись «по местному времени каждого филиала» (Q-83). */
export async function utilizationSeries(env: ReportEnv, p: UtilizationParams, by: 'day' | 'hour'): Promise<{ points: SeriesPoint[]; zoneNote: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, UTILIZATION_ACTION, p);
  const units = await unitsOf(env.tx, branches, p, p.period);
  const open = await openOfUnits(env.tx, branches, units, p.period);
  const [ids, starts, ends] = openArrays(open);
  const tzOf = new Map(units.map((u) => [u.unit_id, branches.find((b) => b.id === u.branch_id)!.timezone]));
  const add = by === 'day' ? addToDays : addToHours;
  const available = new Map<string, number>();
  const used = new Map<string, number>();
  const booked = new Map<string, number>();
  for (const [unit, list] of open) for (const iv of list) add(available, iv, tzOf.get(unit)!);
  if (ids.length > 0) {
    for (const part of await partsOf(env.tx, ids, starts, ends, env.clock.now())) add(part.kind === 'used' ? used : booked, { start: part.s, end: part.e }, tzOf.get(part.unit_id)!);
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
  const found = (await env.tx.query<{ branch_id: string }>(`SELECT branch_id FROM app.rpt_units WHERE unit_id = $1 AND resource_id IS NOT NULL LIMIT 1`, [input.unitId])).rows[0];
  if (!found || !can(env.ctx, UTILIZATION_ACTION, { branchId: found.branch_id })) throw notFound();
  const branches = await resolveBranches(env.tx, env.ctx, UTILIZATION_ACTION, { branchIds: [found.branch_id] });
  const empty: UnitCalendar = { unitId: input.unitId, date, open: [], booked: [], blocked: [], free: [] };
  // состав этой даты: до создания и после архивации единицы календарь пуст
  const u = (await unitsOf(env.tx, branches, {}, { from: date, to: date }, input.unitId))[0];
  if (!u) return empty;
  const open = await openOfUnits(env.tx, branches, [u], { from: date, to: date });
  const list = open.get(u.unit_id) ?? [];
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

