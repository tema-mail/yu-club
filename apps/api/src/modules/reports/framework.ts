// S4-62. Каркас отчётов (K24 §2, §6, §9). Период – локальные даты; у каждого филиала свои сутки (K8 branchDay), сеть и город –
// сумма по филиалам (Q-83). Итог и детализация показателя строятся ОДНИМ построителем where(spec), поэтому Σ detail = aggregate
// (TC-20). Чтение – только представления rpt_* под ролью yu_reports в READ ONLY-снимке REPEATABLE READ (withReportTx);
// ПДн – через clients/index.ts основным пулом, маска на сервере (maskClient). Кэша результатов нет: computedAt – момент расчёта.
// Одновременных отчётов на процесс – не больше предела полосы (экран 2, экспорт 1; D5-10): отчёты и брони делят процессор одной
// базы, и без предела две сводки и два экспорта занимали четыре ядра (S4-131). Сверх – ожидание, затем REPORT_BUSY 503 с Retry-After.
import pg from 'pg';
import type { Db, Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, roleAllows, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { addDays, branchDay, formatLocal, instantToLocal, parseLocalDate, type Clock, type LocalDate, type TimeZone } from '../../core/time.ts';
import { getClientPhones, getClientRefs, type ClientRef } from '../clients/index.ts';
import { BRANCH_COLUMNS, BRANCH_FROM, toBranchInfo, type BranchInfo, type BranchRow } from '../network/index.ts';

export const DAY_RULE = 'Сутки – по времени каждого филиала';
export const SCREEN_TIMEOUT_MS = 15_000;
export const EXPORT_TIMEOUT_MS = 300_000;
/** Бюджет всего отчёта на экране: дашборд – десятки запросов подряд, statement_timeout ограничивает только один (D4-22). */
export const SCREEN_BUDGET_MS = 30_000;
const DETAIL_PAGE = 100; // экран – по 100 строк (K24 §9, 17 §4.4)
const DETAIL_MAX_LIMIT = 500;
const POOL_WAIT_MS = 15_000; // пул занят отчётами дольше – тот же ответ, что на долгий запрос

// ---- значение показателя (K24 §2)

export type MetricUnit = 'count' | 'kop' | 'centi' | 'minutes' | 'pct' | 'days';
export type UnavailableReason = 'source_not_ready' | 'missing_input' | 'not_permitted';
export type Metric =
  | { state: 'ok'; value: number; unit: MetricUnit; prev?: number | null; deltaAbs?: number | null; deltaPct?: number | null }
  | { state: 'no_data' }
  | { state: 'unavailable'; reason: UnavailableReason };

export const unavailable = (reason: UnavailableReason): Metric => ({ state: 'unavailable', reason });
export const noData: Metric = { state: 'no_data' };

/** Значение с прошлым периодом. База 0 или её нет → deltaPct = null (14 §2.4, приёмка 22). */
export function okMetric(value: number, unit: MetricUnit, prev: number | null = null): Metric {
  if (prev === null) return { state: 'ok', value, unit, prev: null, deltaAbs: null, deltaPct: null };
  return { state: 'ok', value, unit, prev, deltaAbs: value - prev, deltaPct: prev === 0 ? null : ((value - prev) / Math.abs(prev)) * 100 };
}

// ---- период

export interface Period {
  from: LocalDate;
  to: LocalDate;
}

function isoDate(raw: unknown, field: string): LocalDate {
  if (typeof raw !== 'string') throw new AppError('REPORT_PERIOD_INVALID', 422, 'Неверный период', { field });
  try {
    return parseLocalDate(raw);
  } catch {
    throw new AppError('REPORT_PERIOD_INVALID', 422, 'Неверный период', { field });
  }
}

const daysBetween = (a: LocalDate, b: LocalDate): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** from ≤ to, не дальше года в будущее; интерактивно – не длиннее maxDays (иначе REPORT_PERIOD_TOO_LONG с useExport). */
export function parsePeriod(input: { from: unknown; to: unknown }, opts: { clock: Clock; maxDays?: number }): Period {
  const from = isoDate(input.from, 'from');
  const to = isoDate(input.to, 'to');
  const limit = addDays(opts.clock.now().toISOString().slice(0, 10) as LocalDate, 366);
  if (from > to || to > limit) throw new AppError('REPORT_PERIOD_INVALID', 422, 'Неверный период', { from, to });
  const days = daysBetween(from, to) + 1;
  if (opts.maxDays !== undefined && days > opts.maxDays) {
    throw new AppError('REPORT_PERIOD_TOO_LONG', 422, 'Период слишком длинный для экрана – сформируйте файл', { useExport: true, maxDays: opts.maxDays });
  }
  return { from, to };
}

/** Прошлый период (14 §4.2): календарный месяц – прошлый календарный месяц, иначе (и неделя) – предшествующий той же длины. */
export function prevPeriod(p: Period): Period {
  const [y, m] = p.from.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const isMonth = p.from.endsWith('-01') && p.to === `${p.from.slice(0, 8)}${String(lastDay).padStart(2, '0')}`;
  if (isMonth) {
    const to = addDays(p.from, -1);
    return { from: `${to.slice(0, 8)}01` as LocalDate, to };
  }
  const to = addDays(p.from, -1);
  return { from: addDays(to, -daysBetween(p.from, p.to)), to };
}

// ---- область: какие филиалы считаем

export interface ReportFilter {
  cityId?: string | undefined;
  branchIds?: string[] | undefined;
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** K24 §8: нет права – FORBIDDEN; филиал или город вне зоны – 404; «вся сеть» без сетевой зоны сужается до зоны. */
export async function resolveBranches(db: Db | Tx, ctx: AccessContext, action: string, filter: ReportFilter = {}): Promise<BranchInfo[]> {
  if (!roleAllows(ctx.role, action)) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });
  const scope = scopeFilter(ctx, action);
  if (scope.kind === 'none') {
    if (filter.branchIds?.length || filter.cityId) throw notFound();
    return [];
  }
  for (const id of [...(filter.branchIds ?? []), ...(filter.cityId ? [filter.cityId] : [])]) if (!UUID_RE.test(id)) throw notFound();
  const params: unknown[] = [];
  const conds: string[] = [];
  if (scope.kind === 'branches') {
    params.push(scope.branchIds);
    conds.push(`b.id = ANY($${params.length}::uuid[])`);
  }
  if (filter.cityId) {
    params.push(filter.cityId);
    conds.push(`b.city_id = $${params.length}`);
  }
  if (filter.branchIds?.length) {
    params.push(filter.branchIds);
    conds.push(`b.id = ANY($${params.length}::uuid[])`);
  }
  const r = await db.query<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM ${BRANCH_FROM} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY b.id`, params);
  const branches = r.rows.map(toBranchInfo);
  if (filter.branchIds?.length && branches.length !== new Set(filter.branchIds).size) throw notFound();
  if (filter.cityId && branches.length === 0) throw notFound();
  return branches;
}

export interface BranchWindow {
  /** null – записи без филиала (ручная корректировка баллов): только сетевая область, spec.nullableBranch. */
  branchId: string | null;
  start: Date;
  end: Date;
}

/** Интервалы UTC периода по суткам каждого филиала (K8, Q-83). */
export function windowsOf(branches: readonly BranchInfo[], p: Period): BranchWindow[] {
  return branches.map((b) => ({ branchId: b.id, start: branchDay(p.from, b.timezone).start, end: branchDay(p.to, b.timezone).end }));
}

// ---- единый построитель условия

export interface MetricSpec {
  view: string; // только app.rpt_*
  branchCol?: string; // по умолчанию branch_id
  date?: string; // колонка периода; нет – показатель на момент запроса (только филиалы)
  nullableBranch?: boolean; // в источнике бывают строки без филиала
  /** Условие сегмента: SQL с ? на место значений. */
  conds?: Array<{ sql: string; values?: unknown[] }>;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const VIEW_RE = /^app\.rpt_[a-z_]+$/;

/** Итог и детализация одного показателя – всегда отсюда. Алиас строки – t. */
export function where(spec: MetricSpec, windows: readonly BranchWindow[]): { sql: string; params: unknown[] } {
  if (!VIEW_RE.test(spec.view)) throw new Error(`reports: источник только rpt_*: ${spec.view}`);
  const branchCol = spec.branchCol ?? 'branch_id';
  if (!IDENT_RE.test(branchCol) || (spec.date && !IDENT_RE.test(spec.date))) throw new Error('reports: недопустимое имя столбца');
  const params: unknown[] = [windows.map((w) => w.branchId), windows.map((w) => w.start), windows.map((w) => w.end)];
  const on = [spec.nullableBranch ? `(w.branch_id = t.${branchCol} OR (w.branch_id IS NULL AND t.${branchCol} IS NULL))` : `w.branch_id = t.${branchCol}`];
  if (spec.date) on.push(`t.${spec.date} >= w.s`, `t.${spec.date} < w.e`);
  // Те же границы ещё раз – филиалы списком и общий охват окон (S4-131): следуют из соединения с w и строк не меняют, но дают
  // планировщику условие по индексу (филиал, дата). Без них соединение с unnest – полный просмотр источника на каждый показатель.
  const hull: string[] = [];
  if (!spec.nullableBranch) hull.push(`t.${branchCol} = ANY($1::uuid[])`);
  if (spec.date && windows.length > 0) {
    params.push(new Date(Math.min(...windows.map((x) => x.start.getTime()))), new Date(Math.max(...windows.map((x) => x.end.getTime()))));
    hull.push(`t.${spec.date} >= $${params.length - 1}::timestamptz`, `t.${spec.date} < $${params.length}::timestamptz`);
  }
  const conds = (spec.conds ?? []).map((c) => {
    let i = 0;
    return `(${c.sql.replace(/\?/g, () => {
      params.push(c.values?.[i++]);
      return `$${params.length}`;
    })})`;
  });
  return {
    sql: `${spec.view} t JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e) ON ${on.join(' AND ')} WHERE ${[...hull, ...conds].join(' AND ') || 'true'}`,
    params,
  };
}

// ---- показатели

export interface MetricDef {
  spec: MetricSpec;
  agg: 'count' | 'sum' | 'avg' | 'count_distinct';
  col?: string; // sum, avg, count_distinct
  unit: MetricUnit;
  dateBasis: string;
  idCol: string; // ключ строки детализации (курсор)
  subtitle?: string;
}

function aggSql(d: MetricDef): string {
  const col = d.col ?? '';
  if (d.agg !== 'count' && !IDENT_RE.test(col)) throw new Error('reports: недопустимое имя столбца');
  switch (d.agg) {
    case 'count':
      return 'count(*)';
    case 'sum':
      return `coalesce(sum(t.${col}), 0)`;
    case 'avg':
      return `avg(t.${col})`;
    case 'count_distinct':
      return `count(DISTINCT t.${col})`;
  }
}

export interface RawValue {
  rows: number;
  value: number;
}

/** Итог одного показателя в окнах. */
export async function aggregate(db: Db | Tx, def: MetricDef, windows: readonly BranchWindow[]): Promise<RawValue> {
  if (windows.length === 0) return { rows: 0, value: 0 };
  const w = where(def.spec, windows);
  const r = await db.query<{ n: string; v: string | null }>(`SELECT count(*) AS n, ${aggSql(def)} AS v FROM ${w.sql}`, w.params);
  return { rows: Number(r.rows[0]!.n), value: Number(r.rows[0]!.v ?? 0) };
}

/** Показатели отчёта с прошлым периодом. Нет записей: у всего отчёта – no_data, у отдельного показателя при живом отчёте – 0 (K24 §2). */
export async function computeMetrics<K extends string>(
  db: Db | Tx,
  defs: Record<K, MetricDef>,
  cur: readonly BranchWindow[],
  prev: readonly BranchWindow[],
): Promise<Record<K, Metric>> {
  const keys = Object.keys(defs) as K[];
  const curs: RawValue[] = [];
  const prevs: RawValue[] = [];
  for (const k of keys) {
    curs.push(await aggregate(db, defs[k], cur));
    prevs.push(await aggregate(db, defs[k], prev));
  }
  const anyCur = curs.some((v) => v.rows > 0);
  const anyPrev = prevs.some((v) => v.rows > 0);
  const out = {} as Record<K, Metric>;
  keys.forEach((k, i) => {
    const isAvg = defs[k].agg === 'avg'; // среднее по пустому множеству – не 0
    if (!anyCur || (isAvg && curs[i]!.rows === 0)) {
      out[k] = noData;
      return;
    }
    // показатель «на момент запроса» (без колонки периода) прошлого значения не имеет
    const hasPrev = anyPrev && defs[k].spec.date !== undefined && !(isAvg && prevs[i]!.rows === 0);
    out[k] = okMetric(curs[i]!.value, defs[k].unit, hasPrev ? prevs[i]!.value : null);
  });
  return out;
}

// ---- детализация: курсор по ключу, тот же where

export interface PageOpts {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export const pageLimit = (opts: PageOpts): number => Math.min(Math.max(opts.limit ?? DETAIL_PAGE, 1), DETAIL_MAX_LIMIT);

/** Курсор детализации по клиенту или сертификату – сам ключ; чужая строка – ошибка фильтра, а не 500 от базы. */
export function uuidCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  if (!UUID_RE.test(cursor)) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверный курсор', { field: 'cursor' });
  return cursor.toLowerCase();
}

/** Страница уже посчитанных строк, упорядоченных по ключу: итог считает вызывающий по всем строкам, в ответ – только страница. */
export function pageByKey<T>(rows: readonly T[], key: (row: T) => string, opts: PageOpts): { slice: T[]; nextCursor: string | null } {
  const after = uuidCursor(opts.cursor);
  const limit = pageLimit(opts);
  const from = after === null ? 0 : rows.findIndex((r) => key(r) > after);
  const start = from < 0 ? rows.length : from;
  const slice = rows.slice(start, start + limit);
  return { slice, nextCursor: start + limit < rows.length ? key(slice[slice.length - 1]!) : null };
}

export interface DetailPage<R> {
  rows: R[];
  total: RawValue;
  nextCursor: string | null;
}

const encodeCursor = (date: string | null, id: string): string => Buffer.from(JSON.stringify([date, id])).toString('base64url');
const badCursor = () => new AppError('REPORT_FILTER_INVALID', 422, 'Неверный курсор', { field: 'cursor' });
// дата курсора – текст timestamptz из базы; JS Date его микросекунды не понимает, поэтому форма – здесь, значения (13-й месяц) – база, см. detailPage
const CURSOR_DATE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

function decodeCursor(c: string, withDate: boolean): [string | null, string] {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(c, 'base64url').toString());
  } catch {
    throw badCursor();
  }
  if (!Array.isArray(v) || v.length !== 2 || typeof v[1] !== 'string') throw badCursor();
  if (withDate && (typeof v[0] !== 'string' || !CURSOR_DATE_RE.test(v[0]))) throw badCursor();
  return [v[0] as string | null, v[1]];
}

/** Страница строк показателя. count_distinct – по строке на значение col. Сумма всех страниц = aggregate (одно условие). */
/** Итог показателя в снимке отчёта (withReportTx): снимок REPEATABLE READ READ ONLY не меняется, поэтому итог одного условия
 *  считается один раз на снимок – экспорт листает сотни страниц и не пересчитывает итог на каждой (S4-131). Вне снимка – без кэша. */
const snapshotTotals = new WeakMap<object, Map<string, RawValue>>();

async function totalOf(db: Db | Tx, def: MetricDef, windows: readonly BranchWindow[]): Promise<RawValue> {
  const cache = snapshotTotals.get(db);
  if (!cache || windows.length === 0) return aggregate(db, def, windows);
  const w = where(def.spec, windows);
  const key = JSON.stringify([aggSql(def), w.sql, w.params]);
  const hit = cache.get(key);
  if (hit) return hit;
  const v = await aggregate(db, def, windows);
  cache.set(key, v);
  return v;
}

/** Значение, вычисляемое один раз на снимок отчёта по ключу (тот же снимок и ключ – тот же результат): детализация, которая
 *  считает все строки в памяти и режет страницу, не перечитывает их на каждой странице. Вне снимка – вычисляется каждый раз. */
const snapshotMemo = new WeakMap<object, Map<string, Promise<unknown>>>();

export function oncePerSnapshot<T>(db: Db | Tx, key: string, compute: () => Promise<T>): Promise<T> {
  const memo = snapshotMemo.get(db);
  if (!memo) return compute();
  const hit = memo.get(key);
  if (hit) return hit as Promise<T>;
  const p = compute();
  memo.set(key, p);
  p.catch(() => memo.delete(key));
  return p;
}

export async function detailPage<R extends pg.QueryResultRow>(
  db: Db | Tx,
  def: MetricDef,
  windows: readonly BranchWindow[],
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<DetailPage<R>> {
  const total = await totalOf(db, def, windows);
  const limit = pageLimit(opts);
  if (windows.length === 0) return { rows: [], total, nextCursor: null };
  if (!IDENT_RE.test(def.idCol)) throw new Error('reports: недопустимое имя столбца');
  const w = where(def.spec, windows);
  const params = [...w.params];
  const date = def.agg === 'count_distinct' ? undefined : def.spec.date;
  const id = def.agg === 'count_distinct' ? def.col! : def.idCol;
  const orderExpr = date ? `t.${date}, t.${id}::text` : `t.${id}::text`;
  let cursorSql = '';
  if (opts.cursor) {
    const [d, i] = decodeCursor(opts.cursor, Boolean(date));
    params.push(i);
    if (date) {
      params.push(d);
      // первое условие следует из второго и строк не меняет: даёт индексу дату, с которой листать (S4-131)
      cursorSql = `t.${date} >= $${params.length}::timestamptz AND (t.${date}, t.${id}::text) > ($${params.length}::timestamptz, $${params.length - 1})`;
    } else {
      cursorSql = `t.${id}::text > $${params.length}`;
    }
  }
  const inner = def.agg === 'count_distinct' ? `SELECT DISTINCT ON (t.${id}) t.* FROM ${w.sql} ORDER BY t.${id}` : `SELECT t.* FROM ${w.sql}`;
  params.push(limit + 1);
  // дата курсора – текстом из базы: в JS Date микросекунды now() теряются, и строка вернулась бы на следующей странице
  const r = await db.query<R & { cursor_date?: string }>(
    `SELECT t.*${date ? `, t.${date}::text AS cursor_date` : ''} FROM (${inner}) t ${cursorSql ? `WHERE ${cursorSql}` : ''} ORDER BY ${orderExpr} LIMIT $${params.length}`,
    params,
  ).catch((err: { code?: string }) => {
    // 22xxx – значение даты курсора не приняла база (2026-13-45): это плохой курсор, а не сбой сервера
    if (opts.cursor && err.code?.startsWith('22')) throw badCursor();
    throw err;
  });
  const rows = r.rows.slice(0, limit);
  const last = rows[rows.length - 1] as (Record<string, unknown> & { cursor_date?: string }) | undefined;
  const nextCursor = r.rows.length > limit && last ? encodeCursor(last.cursor_date ?? null, String(last[id])) : null;
  for (const row of rows) delete row.cursor_date;
  return { rows, total, nextCursor };
}

// ---- запуск отчёта: область + показатели + детализация (K24 §10)

/** tx – снимок под yu_reports (withReportTx); main – основной пул, только для ПДн через clients/index.ts. */
export interface ReportEnv {
  tx: Tx;
  main: Db;
  ctx: AccessContext;
  clock: Clock;
  /** Экспорт: даты строк – 'ГГГГ-ММ-ДД ЧЧ:ММ' в зоне филиала (в файле это дата, а не текст), на экране – '15 ноября, 14:00'. */
  fileDates?: boolean | undefined;
}

/** Момент строки детализации в зоне филиала: подпись для экрана или дата для файла (K24 §7). */
export function localAt(env: Pick<ReportEnv, 'fileDates'>, at: Date, tz: TimeZone): string {
  if (!env.fileDates) return formatLocal(at, tz, 'datetime');
  const l = instantToLocal(at, tz);
  return `${l.date} ${l.time}`;
}

export interface ReportParams extends ReportFilter {
  period: Period;
}

export interface ReportResult<K extends string = string> {
  metrics: Record<K, Metric>;
  dateBasis: Record<K, string>;
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

export async function runMetrics<K extends string>(env: ReportEnv, action: string, params: ReportParams, defs: Record<K, MetricDef>): Promise<ReportResult<K>> {
  const branches = await resolveBranches(env.tx, env.ctx, action, params);
  const prev = prevPeriod(params.period);
  const metrics = await computeMetrics(env.tx, defs, windowsOf(branches, params.period), windowsOf(branches, prev));
  const dateBasis = Object.fromEntries((Object.keys(defs) as K[]).map((k) => [k, defs[k].dateBasis])) as Record<K, string>;
  return { metrics, dateBasis, period: params.period, prevPeriod: prev, computedAt: env.clock.now().toISOString(), dayRule: DAY_RULE };
}

/** Страница строк одного показателя с тем же условием; total – как итог на экране (Metric без прошлого периода). */
export async function runDetail<R extends pg.QueryResultRow>(
  env: ReportEnv,
  action: string,
  params: ReportParams,
  def: MetricDef,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: R[]; total: Metric; nextCursor: string | null; branches: BranchInfo[] }> {
  const branches = await resolveBranches(env.tx, env.ctx, action, params);
  const page = await detailPage<R>(env.tx, def, windowsOf(branches, params.period), opts);
  const noRows = page.total.rows === 0;
  return { rows: page.rows, total: noRows ? noData : okMetric(page.total.value, def.unit), nextCursor: page.nextCursor, branches };
}

/** Неизвестный показатель детализации – ошибка фильтра (K24 §10). */
export function metricDef<K extends string>(defs: Record<K, MetricDef>, key: unknown): MetricDef {
  const def = typeof key === 'string' && Object.hasOwn(defs, key) ? defs[key as K] : undefined;
  if (!def) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неизвестный показатель', { field: 'metric' });
  return def;
}

// ---- маска ПДн (K24 §6)

export interface MaskedClient {
  id: string;
  kind: 'profile' | 'guest';
  name: string | null;
  phone: string;
}

/** Без client.view.full на филиале строки: «Иван П.» и маска телефона; с правом – полное имя и телефон. */
export function maskClient(ref: ClientRef, ctx: AccessContext, branchId: string, fullPhone?: string): MaskedClient {
  const full = can(ctx, 'client.view.full', { branchId });
  const first = ref.firstName?.trim() ?? '';
  const last = ref.lastName?.trim() ?? '';
  const name = full ? `${first} ${last}`.trim() : `${first}${last ? ` ${last[0]}.` : ''}`.trim();
  return {
    id: ref.id,
    kind: ref.status === 'guest' ? 'guest' : 'profile',
    name: name === '' ? null : name,
    phone: full && fullPhone ? fullPhone : ref.phoneMasked,
  };
}

/** Клиенты строк детализации: основной пул (yu_reports таблицу клиентов не видит), маска – по филиалу строки. */
export async function loadMaskedClients(main: Db, ctx: AccessContext, rows: ReadonlyArray<{ clientId: string; branchId: string }>): Promise<Map<string, MaskedClient>> {
  const refs = await getClientRefs(main, rows.map((r) => r.clientId));
  const fullIds = rows.filter((r) => can(ctx, 'client.view.full', { branchId: r.branchId })).map((r) => r.clientId);
  const phones = fullIds.length ? await getClientPhones(main, fullIds) : new Map<string, string>();
  const out = new Map<string, MaskedClient>();
  for (const r of rows) {
    const ref = refs.get(r.clientId);
    if (ref) out.set(`${r.clientId}:${r.branchId}`, maskClient(ref, ctx, r.branchId, phones.get(r.clientId)));
  }
  return out;
}

// ---- пул и снимок (K24 §9)

export interface ReportsPool {
  connect(): Promise<pg.PoolClient>;
  end(): Promise<void>;
  /** Есть у pg.Pool: отмена идёт отдельным соединением, мимо занятого пула. */
  options?: { connectionString?: string | undefined };
}

/** Полоса отчёта: экран (дашборд, отчёты, детализация, календарь), экспорт (worker), поиск – свой предел в search.ts (K24 §5). */
export type ReportLane = 'screen' | 'export' | 'search';

export interface ReportTxOpts {
  timeoutMs?: number | undefined;
  /** Общий бюджет на весь отчёт. По умолчанию: экран – SCREEN_BUDGET_MS, длинные запросы (экспорт) – их timeoutMs. */
  budgetMs?: number | undefined;
  /** Клиент закрыл запрос: идущий запрос отменяется в базе (K24 §9); ждущий места – выходит из очереди. */
  signal?: AbortSignal | undefined;
  /** По умолчанию – экран. */
  lane?: ReportLane | undefined;
}

const reportTimeout = () => new AppError('REPORT_TIMEOUT', 504, 'Отчёт не уложился – сузьте период или сформируйте файл');
const reportCancelled = () => new AppError('REPORT_CANCELLED', 409, 'Запрос отчёта отменён');

// ---- предел одновременных отчётов на процесс (D5-10)

export interface ReportLimits {
  /** Экранных отчётов одновременно. */
  screen: number;
  /** Экспортов одновременно. */
  export: number;
  /** Сколько ждать свободного места, затем REPORT_BUSY. */
  waitMs: number;
}

/** Умолчания: экран 2 + экспорт 1 = пул yu_reports из 3 соединений; env – REPORTS_SCREEN_MAX, REPORTS_EXPORT_MAX, REPORTS_BUSY_WAIT_MS (config.ts). */
export const DEFAULT_REPORT_LIMITS: ReportLimits = { screen: 2, export: 1, waitMs: 10_000 };
const BUSY_RETRY_AFTER_SEC = 5;

interface Waiter {
  grant(): void;
  drop(err: AppError): void;
}
interface Lane {
  running: number;
  queue: Waiter[];
}
interface Gate {
  limits: ReportLimits;
  lanes: Record<Exclude<ReportLane, 'search'>, Lane>;
}

/** Предел – на пул (один пул на процесс API, свой у worker); пул без настройки – умолчания. */
const gates = new WeakMap<object, Gate>();

function gateOf(pool: ReportsPool): Gate {
  let g = gates.get(pool);
  if (!g) {
    g = { limits: DEFAULT_REPORT_LIMITS, lanes: { screen: { running: 0, queue: [] }, export: { running: 0, queue: [] } } };
    gates.set(pool, g);
  }
  return g;
}

export function setReportLimits(pool: ReportsPool, limits: Partial<ReportLimits>): void {
  const g = gateOf(pool);
  g.limits = { ...g.limits, ...limits };
}

const reportBusy = () => new AppError('REPORT_BUSY', 503, 'Отчёты заняты – повторите через несколько секунд', { retryAfterSec: BUSY_RETRY_AFTER_SEC });

/** Место в полосе: свободно – сразу; нет – ждать до waitMs (закрытый запрос – REPORT_CANCELLED), не дождались – REPORT_BUSY. Возвращает освобождение. */
async function acquire(pool: ReportsPool, lane: Exclude<ReportLane, 'search'>, signal: AbortSignal | undefined): Promise<() => void> {
  const g = gateOf(pool);
  const l = g.lanes[lane];
  const release = () => {
    const next = l.queue.shift();
    if (next) next.grant(); // место переходит ждущему: running не меняется
    else l.running -= 1;
  };
  if (l.running < g.limits[lane]) {
    l.running += 1;
    return release;
  }
  await new Promise<void>((resolve, reject) => {
    const w: Waiter = { grant: () => (cleanup(), resolve()), drop: (err) => (cleanup(), reject(err)) };
    const leave = (err: AppError) => {
      const i = l.queue.indexOf(w);
      if (i >= 0) {
        l.queue.splice(i, 1);
        w.drop(err);
      }
    };
    const timer = setTimeout(() => leave(reportBusy()), g.limits.waitMs);
    const onAbort = () => leave(reportCancelled());
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    l.queue.push(w);
  });
  return release;
}

/** pg_cancel_backend своей роли (K24 §9). Ошибка отмены не важнее ответа: дальше сработает statement_timeout. */
async function cancelBackend(pool: ReportsPool, pid: number): Promise<void> {
  const url = pool.options?.connectionString;
  try {
    if (url) {
      const direct = new pg.Client({ connectionString: url });
      await direct.connect();
      try {
        await direct.query('SELECT pg_cancel_backend($1)', [pid]);
      } finally {
        await direct.end();
      }
      return;
    }
    const c = await pool.connect();
    try {
      await c.query('SELECT pg_cancel_backend($1)', [pid]);
    } finally {
      c.release();
    }
  } catch {
    // см. выше
  }
}

/** Отдельный пул под ролью yu_reports: исчерпание не задевает основной (17 §6). limits – предел одновременных отчётов на этот пул (D5-10). */
export function createReportsPool(url: string, max = 3, limits: Partial<ReportLimits> = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app', max, connectionTimeoutMillis: POOL_WAIT_MS });
  // без обработчика ошибка простаивающего соединения роняет процесс API (как в worker.ts)
  pool.on('error', (err) => console.error('пул yu_reports: ошибка простаивающего соединения', err.message));
  setReportLimits(pool, limits);
  return pool;
}

/** Один снимок на отчёт: место в полосе (D5-10), REPEATABLE READ READ ONLY, statement_timeout (экран 15 с, экспорт 300 с), work_mem 16 МБ,
 *  общий бюджет времени и отмена по закрытию запроса. */
export async function withReportTx<T>(pool: ReportsPool, fn: (tx: Tx) => Promise<T>, opts: ReportTxOpts = {}): Promise<T> {
  if (opts.signal?.aborted) throw reportCancelled();
  const lane = opts.lane ?? 'screen';
  const release = lane === 'search' ? () => {} : await acquire(pool, lane, opts.signal);
  try {
    return await reportSnapshot(pool, fn, opts);
  } finally {
    release();
  }
}

async function reportSnapshot<T>(pool: ReportsPool, fn: (tx: Tx) => Promise<T>, opts: ReportTxOpts): Promise<T> {
  if (opts.signal?.aborted) throw reportCancelled(); // закрыли, пока ждали места
  const c = await pool.connect().catch((err: unknown) => {
    if (err instanceof Error && /timeout/i.test(err.message)) throw reportTimeout();
    throw err;
  });
  const timeoutMs = opts.timeoutMs ?? SCREEN_TIMEOUT_MS;
  let stopped: 'budget' | 'abort' | null = opts.signal?.aborted ? 'abort' : null;
  let cancelling: Promise<void> = Promise.resolve();
  const interrupt = (why: 'budget' | 'abort') => {
    if (stopped) return;
    stopped = why;
    const pid = (c as unknown as { processID: number | null }).processID;
    if (pid !== null) cancelling = cancelBackend(pool, pid);
  };
  const onAbort = () => interrupt('abort');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const budget = setTimeout(() => interrupt('budget'), opts.budgetMs ?? Math.max(timeoutMs, SCREEN_BUDGET_MS));
  const stopError = () => (stopped === 'abort' ? reportCancelled() : reportTimeout());
  // запрос между двумя запросами отчёта тоже не начнётся: pg_cancel_backend отменяет только идущий
  const tx: Tx = {
    query: <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => (stopped ? Promise.reject(stopError()) : c.query<R>(text, values)),
  };
  snapshotTotals.set(tx, new Map());
  snapshotMemo.set(tx, new Map());
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
    await tx.query(`SET LOCAL work_mem = '16MB'`);
    // без параллельных процессов: отчёт занимает одно ядро базы, а не три – подтверждение брони и оплата не ждут процессор (17 §6, S4-131)
    await tx.query(`SET LOCAL max_parallel_workers_per_gather = 0`);
    const out = await fn(tx);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    if (stopped) throw stopError();
    if ((err as { code?: string }).code === '57014') throw reportTimeout();
    throw err;
  } finally {
    clearTimeout(budget);
    opts.signal?.removeEventListener('abort', onAbort);
    await cancelling; // соединение в пул – только когда отмена дошла: она не должна задеть чужой отчёт
    c.release();
  }
}
