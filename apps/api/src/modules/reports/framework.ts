// S4-62. Каркас отчётов (K24 §2, §6, §9). Период – локальные даты; у каждого филиала свои сутки (K8 branchDay), сеть и город –
// сумма по филиалам (Q-83). Итог и детализация показателя строятся ОДНИМ построителем where(spec), поэтому Σ detail = aggregate
// (TC-20). Чтение – только представления rpt_* под ролью yu_reports в READ ONLY-снимке REPEATABLE READ (withReportTx);
// ПДн – через clients/index.ts основным пулом, маска на сервере (maskClient). Кэша результатов нет: computedAt – момент расчёта.
import pg from 'pg';
import type { Db, Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, roleAllows, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { addDays, branchDay, parseLocalDate, type Clock, type LocalDate } from '../../core/time.ts';
import { getClientPhones, getClientRefs, type ClientRef } from '../clients/index.ts';
import { BRANCH_COLUMNS, BRANCH_FROM, toBranchInfo, type BranchInfo, type BranchRow } from '../network/index.ts';

export const DAY_RULE = 'Сутки – по времени каждого филиала';
export const SCREEN_TIMEOUT_MS = 15_000;
export const EXPORT_TIMEOUT_MS = 300_000;
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
  const conds = (spec.conds ?? []).map((c) => {
    let i = 0;
    return `(${c.sql.replace(/\?/g, () => {
      params.push(c.values?.[i++]);
      return `$${params.length}`;
    })})`;
  });
  return {
    sql: `${spec.view} t JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e) ON ${on.join(' AND ')}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`,
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

export interface DetailPage<R> {
  rows: R[];
  total: RawValue;
  nextCursor: string | null;
}

const encodeCursor = (date: string | null, id: string): string => Buffer.from(JSON.stringify([date, id])).toString('base64url');
function decodeCursor(c: string): [string | null, string] {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString()) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string') return [v[0] as string | null, v[1]];
  } catch {
    // ниже – ошибка
  }
  throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверный курсор', { field: 'cursor' });
}

/** Страница строк показателя. count_distinct – по строке на значение col. Сумма всех страниц = aggregate (одно условие). */
export async function detailPage<R extends pg.QueryResultRow>(
  db: Db | Tx,
  def: MetricDef,
  windows: readonly BranchWindow[],
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<DetailPage<R>> {
  const total = await aggregate(db, def, windows);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), DETAIL_MAX_LIMIT);
  if (windows.length === 0) return { rows: [], total, nextCursor: null };
  if (!IDENT_RE.test(def.idCol)) throw new Error('reports: недопустимое имя столбца');
  const w = where(def.spec, windows);
  const params = [...w.params];
  const date = def.agg === 'count_distinct' ? undefined : def.spec.date;
  const id = def.agg === 'count_distinct' ? def.col! : def.idCol;
  const orderExpr = date ? `t.${date}, t.${id}::text` : `t.${id}::text`;
  let cursorSql = '';
  if (opts.cursor) {
    const [d, i] = decodeCursor(opts.cursor);
    params.push(i);
    if (date) {
      params.push(d);
      cursorSql = `(t.${date}, t.${id}::text) > ($${params.length}::timestamptz, $${params.length - 1})`;
    } else {
      cursorSql = `t.${id}::text > $${params.length}`;
    }
  }
  const inner = def.agg === 'count_distinct' ? `SELECT DISTINCT ON (t.${id}) t.* FROM ${w.sql} ORDER BY t.${id}` : `SELECT t.* FROM ${w.sql}`;
  params.push(limit + 1);
  const r = await db.query<R>(
    `SELECT t.* FROM (${inner}) t ${cursorSql ? `WHERE ${cursorSql}` : ''} ORDER BY ${orderExpr} LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
  const nextCursor =
    r.rows.length > limit && last
      ? encodeCursor(date ? (last[date] as Date).toISOString() : null, String(last[id]))
      : null;
  return { rows, total, nextCursor };
}

// ---- запуск отчёта: область + показатели + детализация (K24 §10)

/** tx – снимок под yu_reports (withReportTx); main – основной пул, только для ПДн через clients/index.ts. */
export interface ReportEnv {
  tx: Tx;
  main: Db;
  ctx: AccessContext;
  clock: Clock;
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
}

/** Отдельный пул под ролью yu_reports: исчерпание не задевает основной (17 §6). */
export function createReportsPool(url: string, max = 3): pg.Pool {
  return new pg.Pool({ connectionString: url, options: '-c search_path=app', max, connectionTimeoutMillis: POOL_WAIT_MS });
}

/** Один снимок на отчёт: REPEATABLE READ READ ONLY, statement_timeout (экран 15 с, экспорт 300 с), work_mem 16 МБ. */
export async function withReportTx<T>(pool: ReportsPool, fn: (tx: Tx) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const c = await pool.connect().catch((err: unknown) => {
    if (err instanceof Error && /timeout/i.test(err.message)) throw new AppError('REPORT_TIMEOUT', 504, 'Отчёт не уложился – сузьте период или сформируйте файл');
    throw err;
  });
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query(`SET LOCAL statement_timeout = ${Math.trunc(opts.timeoutMs ?? SCREEN_TIMEOUT_MS)}`);
    await c.query(`SET LOCAL work_mem = '16MB'`);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    if ((err as { code?: string }).code === '57014') {
      throw new AppError('REPORT_TIMEOUT', 504, 'Отчёт не уложился – сузьте период или сформируйте файл');
    }
    throw err;
  } finally {
    c.release();
  }
}
