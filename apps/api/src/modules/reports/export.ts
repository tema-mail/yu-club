// S4-72. Задачи экспорта (K24 §7, §8; 14 §16, 17 §4.3). queued → running → ready → expired; queued|running → failed, cancelled.
// Очередь – сама строка report_exports (как кампании K21 §6, таймером worker), а не pg-boss: постановка атомарна с аудитом и ключом идемпотентности,
// ограничение «одна на сотрудника, всего 2» считается по строкам и переживает перезапуск.
// Повтор того же запроса, пока задача queued/running, – та же задача (частичный UNIQUE, 0449); после ready – новая задача и новый расчёт
// (K24 §2 «Актуальность», D5-13), прежний файл живёт до срока. Файл считается теми же функциями, что экран, в одном снимке под yu_reports, по правам постановщика на момент расчёта.
// Права проверяются при постановке, при расчёте и при скачивании. Зона: у сотрудника без сети фильтр при постановке заменяется списком его филиалов,
// поэтому файл никогда не шире зоны на момент постановки, а сужение зоны закрывает скачивание (EXPORT_FORBIDDEN).
// Телефон в файле – маска, если нет export.pd, даже при client.view.full (K24 §6). Комментарии – только с reports.export.detail. Файл живёт reports.export_ttl_hours, уборка – reports:export-gc.
import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { FileStore } from '../../core/files.ts';
import { can, loadAccess, roleAllows, type AccessContext, type NetworkLookup } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import { instantToLocal, systemClock, type Clock, type TimeZone } from '../../core/time.ts';
import { maskPhone, withTx, type Pool } from '../clients/index.ts';
import type { BranchInfo } from '../network/index.ts';
import { dashboard } from './dashboard.ts';
import { EXPORT_MIME, exportStream, type CellValue, type ColumnKind, type ExportColumn, type ExportDocument, type ExportFormat, type HeaderLine, type WriteProgress } from './export-files.ts';
import { COLUMN_TITLES, DATE_BASIS_TITLES, METRIC_TITLES, REPORT_TITLES, UNIT_TITLES, UNITS_NOTE } from './export-labels.ts';
import { DAY_RULE, EXPORT_TIMEOUT_MS, parsePeriod, reportLimits, resolveBranches, withReportTx, type Metric, type MetricUnit, type ReportEnv, type ReportParams, type ReportsPool } from './framework.ts';
import { defined, HANDLERS, parseQuery, segmented, type Query } from './report-handlers.ts';

export const REQUEST_ROUTE = 'POST /api/crm/v1/reports/exports';
export const EXPORT_MAX_RUNNING = 2; // K24 §9: всего ≤ 2, одна на сотрудника
const DETAIL_PAGE = 500;
const STALE_RUNNING_MS = EXPORT_TIMEOUT_MS + 60_000; // процесс умер посреди записи: задача не висит вечно и не занимает очередь
const ORPHAN_AGE_MS = 3_600_000;
const TMP_AGE_MS = 86_400_000;
const NETWORK_ZONE: TimeZone = 'Europe/Moscow' as TimeZone;
const LIST_LIMIT = 50;

/** Право на просмотр отчёта (K24 §8). */
const VIEW_ACTION: Record<string, string> = {
  bookings: 'reports.ops.view',
  utilization: 'reports.ops.view',
  finance: 'reports.finance.view',
  certificates: 'reports.finance.view',
  clients: 'reports.clients.view',
  loyalty: 'reports.loyalty.view',
  comms: 'reports.comms.view',
  events: 'reports.events.view',
  staff: 'reports.staff.view',
  equipment: 'reports.equipment.view',
};
/** Детальные финансы – отдельное право (K24 §8; 14 §16). */
const DETAIL_ACTION: Record<string, string> = { finance: 'reports.export.detail', certificates: 'reports.export.detail' };

export type ExportStatus = 'queued' | 'running' | 'ready' | 'expired' | 'failed' | 'cancelled';

export interface ExportJob {
  id: string;
  report: string;
  format: ExportFormat;
  params: Record<string, unknown>;
  detail: boolean;
  masked: boolean;
  status: ExportStatus;
  errorCode: string | null;
  rows: number | null;
  bytes: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  downloadedAt: string | null;
}

interface ExportRow {
  id: string;
  staff_id: string;
  report: string;
  format: ExportFormat;
  params: Record<string, unknown>;
  detail: boolean;
  masked: boolean;
  status: ExportStatus;
  error_code: string | null;
  rows: number | null;
  bytes: string | null;
  file_key: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date | null;
  downloaded_at: Date | null;
}

const toJob = (r: ExportRow): ExportJob => ({
  id: r.id,
  report: r.report,
  format: r.format,
  params: r.params,
  detail: r.detail,
  masked: r.masked,
  status: r.status,
  errorCode: r.error_code,
  rows: r.rows,
  bytes: r.bytes === null ? null : Number(r.bytes),
  createdAt: r.created_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null,
  expiresAt: r.expires_at?.toISOString() ?? null,
  downloadedAt: r.downloaded_at?.toISOString() ?? null,
});

export interface ExportDeps {
  pool: Pool;
  clock?: Clock | undefined;
}

export interface ExportRunDeps extends ExportDeps {
  reports: ReportsPool;
  store: FileStore;
  network: NetworkLookup;
  log?: ((err: unknown) => void) | undefined;
}

const forbidden = (action: string) => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const systemMeta = (process: string): AuditRequestMeta => ({ actor: { kind: 'system', process }, source: 'system', requestId: randomUUID() });
const staffIdOf = (ctx: AccessContext): string => {
  if (ctx.actor.kind !== 'staff') throw forbidden('reports.export');
  return ctx.actor.staffId;
};
const exportable = (report: string): boolean => report === 'dashboard' || Object.hasOwn(HANDLERS, report);

/** Состав файла требует права (K24 §8). Зона – отдельно, resolveBranches. */
function assertRights(ctx: AccessContext, report: string, detail: boolean): void {
  if (!roleAllows(ctx.role, 'reports.export')) throw forbidden('reports.export');
  const view = Object.hasOwn(VIEW_ACTION, report) ? VIEW_ACTION[report] : undefined;
  if (view && !roleAllows(ctx.role, view)) throw forbidden(view);
  const extra = detail && Object.hasOwn(DETAIL_ACTION, report) ? DETAIL_ACTION[report] : undefined;
  if (extra && !roleAllows(ctx.role, extra)) throw forbidden(extra);
}

// ---- постановка

const REQUEST = z.strictObject({
  report: z.string().max(40),
  format: z.enum(['xlsx', 'csv']),
  detail: z.boolean().default(false),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** Канонический вид: ключи по алфавиту, списки отсортированы, служебные поля страницы и серии убраны. */
function canonical(q: Query, detail: boolean): Record<string, unknown> {
  const skip = new Set(['cursor', 'limit', 'series', 'segmentSource', 'segmentPlace', 'segmentHour', ...(detail ? [] : ['metric', 'segment'])]);
  const base = q as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(base).sort()) {
    const v = base[k];
    if (skip.has(k) || v === undefined) continue;
    out[k] = Array.isArray(v) ? [...(v as string[])].sort() : v;
  }
  return out;
}

export function paramsHash(staffId: string, input: { report: string; format: string; detail: boolean; params: Record<string, unknown> }): string {
  return createHash('sha256').update(JSON.stringify([input.report, input.detail, input.params, staffId, input.format])).digest('hex');
}

/** Заявка → нормализованные параметры: период и фильтры по схеме экрана, зона заморожена у сотрудника без сети. */
async function normalize(db: Db, ctx: AccessContext, raw: unknown, clock: Clock): Promise<{ report: string; format: ExportFormat; detail: boolean; params: Record<string, unknown> }> {
  const r = REQUEST.safeParse(raw ?? {});
  if (!r.success) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверный запрос экспорта', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const { report, format, detail } = r.data;
  if (!exportable(report)) throw new AppError('REPORT_UNKNOWN', 404, 'Нет такого отчёта', { report });
  assertRights(ctx, report, detail);
  if (detail && report === 'dashboard') throw new AppError('REPORT_FILTER_INVALID', 422, 'У сводки нет детализации', { field: 'detail' });
  // JSON отдаёт логическое значение paid как есть, экран – строкой: схема одна
  const q = parseQuery(r.data.params.paid === undefined ? r.data.params : { ...r.data.params, paid: String(r.data.params.paid) });
  if (detail && !q.metric) throw new AppError('REPORT_FILTER_INVALID', 422, 'Для детализации нужен показатель', { field: 'metric' });
  const period = parsePeriod({ from: q.from, to: q.to }, { clock }); // длиннее экранных 92 дней – можно, для этого файл и нужен
  const branches = await resolveBranches(db, ctx, 'reports.export', defined({ cityId: q.cityId, branchIds: q.branchIds }));
  if (branches.length === 0) throw notFound();
  const params = canonical({ ...q, from: period.from, to: period.to }, detail);
  if (!ctx.network) {
    delete params.cityId;
    params.branchIds = branches.map((b) => b.id).sort();
  }
  return { report, format, detail, params };
}

/** K11 №243 внутри транзакции и обвязки идемпотентности. Тот же запрос, пока прежний в работе, – та же задача, аудит только у новой. */
export async function requestExport(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<{ job: ExportJob; created: boolean }> {
  const staffId = staffIdOf(ctx);
  const n = await normalize(tx, ctx, raw, clock);
  const now = clock.now();
  const hash = paramsHash(staffId, n);
  const masked = !can(ctx, 'export.pd', { network: true });
  // срок прошёл, а уборка ещё не дошла: строка сразу expired (скачивание – 410), файл заберёт уборка как осиротевший
  await tx.query(`UPDATE app.report_exports SET status = 'expired', file_key = NULL WHERE staff_id = $1 AND params_hash = $2 AND status = 'ready' AND expires_at <= $3`, [staffId, hash, now]);
  let row: ExportRow | undefined;
  for (let attempt = 0; attempt < 3 && !row; attempt++) {
    const inserted = await tx.query<ExportRow>(
      `INSERT INTO app.report_exports (staff_id, report, format, params, params_hash, detail, masked, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (staff_id, params_hash) WHERE status IN ('queued','running') DO NOTHING RETURNING *`,
      [staffId, n.report, n.format, JSON.stringify(n.params), hash, n.detail, masked, now],
    );
    row = inserted.rows[0];
    if (row) break;
    // Конфликтная задача – самая новая строка этого запроса. Она могла успеть стать ready между вставкой и чтением –
    // это всё ещё она. Если она успела стать cancelled/failed, старую ready не отдаём (прежний файл – K24 §2), вставляем снова.
    const newest = await tx.query<ExportRow>(
      `SELECT * FROM app.report_exports WHERE staff_id = $1 AND params_hash = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [staffId, hash],
    );
    const same = newest.rows[0];
    if (same && ['queued', 'running', 'ready'].includes(same.status)) return { job: toJob(same), created: false };
  }
  if (!row) throw new Error('report_exports: не удалось поставить экспорт за 3 попытки');
  await writeAudit(tx, meta, { action: 'export.requested', object: { type: 'export', id: row.id }, after: { report: n.report, params: n.params, format: n.format, detail: n.detail, masked } }, clock);
  return { job: toJob(row), created: true };
}

// ---- чтение автором

async function ownRow(db: Db, ctx: AccessContext, id: string): Promise<ExportRow> {
  const r = await db.query<ExportRow>(`SELECT * FROM app.report_exports WHERE id = $1 AND staff_id = $2`, [id, staffIdOf(ctx)]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

export async function getExport(db: Db, ctx: AccessContext, id: string): Promise<ExportJob> {
  return toJob(await ownRow(db, ctx, id));
}

const badCursor = () => new AppError('REPORT_FILTER_INVALID', 422, 'Неверный курсор', { field: 'cursor' });

/** K11 №244: свои задачи, новые сверху. Курсор – время создания текстом базы и id. */
export async function listExports(db: Db, ctx: AccessContext, opts: { cursor?: string | undefined } = {}): Promise<{ items: ExportJob[]; nextCursor: string | null }> {
  if (!roleAllows(ctx.role, 'reports.export')) throw forbidden('reports.export');
  let at: string | null = null;
  let id: string | null = null;
  if (opts.cursor) {
    try {
      [at, id] = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString()) as [string, string];
    } catch {
      throw badCursor();
    }
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !z.uuid().safeParse(id).success) throw badCursor();
  }
  const r = await db.query<ExportRow & { cursor_at: string }>(
    `SELECT *, created_at::text AS cursor_at FROM app.report_exports WHERE staff_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
     ORDER BY created_at DESC, id DESC LIMIT $4`,
    [staffIdOf(ctx), at, id, LIST_LIMIT + 1],
  );
  const rows = r.rows.slice(0, LIST_LIMIT);
  const last = rows[rows.length - 1];
  return { items: rows.map(toJob), nextCursor: r.rows.length > LIST_LIMIT && last ? Buffer.from(JSON.stringify([last.cursor_at, last.id])).toString('base64url') : null };
}

/** K11 №247: отмена автором. Идущая задача увидит статус на следующем проходе и оборвёт запрос. Завершённую отменять незачем – ответ без изменений. */
export async function cancelExport(tx: Tx, ctx: AccessContext, id: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ExportJob> {
  await ownRow(tx, ctx, id);
  const now = clock.now();
  const r = await tx.query<ExportRow>(`UPDATE app.report_exports SET status = 'cancelled', finished_at = $3 WHERE id = $1 AND staff_id = $2 AND status IN ('queued','running') RETURNING *`, [id, staffIdOf(ctx), now]);
  if (!r.rows[0]) return toJob(await ownRow(tx, ctx, id));
  await writeAudit(tx, meta, { action: 'export.cancelled', object: { type: 'export', id } }, clock);
  return toJob(r.rows[0]);
}

export interface ExportDownload {
  stream: NodeJS.ReadableStream;
  fileName: string;
  mime: string;
  bytes: number | null;
}

/** Права на момент скачивания: роль, состав файла, маска, зона. Потеря – EXPORT_FORBIDDEN, а не 404: задача своя. */
async function assertStillAllowed(db: Db, ctx: AccessContext, row: ExportRow): Promise<void> {
  const lost = () => new AppError('EXPORT_FORBIDDEN', 403, 'Право на этот файл потеряно');
  try {
    assertRights(ctx, row.report, row.detail);
  } catch {
    throw lost();
  }
  if (!row.masked && !can(ctx, 'export.pd', { network: true })) throw lost();
  const branchIds = row.params.branchIds as string[] | undefined;
  if (ctx.network) return;
  if (!branchIds?.length) throw lost(); // файл на всю сеть, а сети уже нет
  await resolveBranches(db, ctx, 'reports.export', { branchIds }).catch(() => {
    throw lost();
  });
}

/** K11 №246: только автор; не готов – 409, срок вышел – 410. Аудит и отметка – в транзакции, поток открывается после неё. */
export async function downloadExport(deps: ExportDeps & { store: FileStore }, ctx: AccessContext, id: string, meta: AuditRequestMeta): Promise<ExportDownload> {
  const clock = deps.clock ?? systemClock;
  const row = await ownRow(deps.pool, ctx, id);
  const now = clock.now();
  if (row.status === 'expired' || (row.status === 'ready' && row.expires_at! <= now)) throw new AppError('EXPORT_EXPIRED', 410, 'Срок хранения файла истёк – сформируйте заново');
  if (row.status !== 'ready') throw new AppError('EXPORT_NOT_READY', 409, 'Файл ещё не готов', { status: row.status });
  await assertStillAllowed(deps.pool, ctx, row);
  if (!(await deps.store.exists(row.file_key!))) {
    // Файл пропал при ready (диск, ручная чистка): строка → expired, как у уборки, иначе 410 до конца срока и повтор запроса вернёт её же.
    await withTx(deps.pool, async (tx) => {
      const r = await tx.query(`UPDATE app.report_exports SET status = 'expired', file_key = NULL WHERE id = $1 AND status = 'ready'`, [id]);
      if ((r.rowCount ?? 0) > 0) await writeAudit(tx, meta, { action: 'export.expired', object: { type: 'export', id }, after: { report: row.report, reason: 'file_missing' } }, clock);
    });
    throw new AppError('EXPORT_EXPIRED', 410, 'Файла больше нет – сформируйте заново');
  }
  await withTx(deps.pool, async (tx) => {
    await tx.query(`UPDATE app.report_exports SET downloaded_at = $2 WHERE id = $1`, [id, now]);
    await writeAudit(tx, meta, { action: 'export.downloaded', object: { type: 'export', id }, after: { report: row.report, masked: row.masked } }, clock);
  });
  const fileName = `yu-club-${row.report}-${String(row.params.from)}-${String(row.params.to)}.${row.format}`;
  return { stream: deps.store.openRead(row.file_key!), fileName, mime: EXPORT_MIME[row.format], bytes: row.bytes === null ? null : Number(row.bytes) };
}

// ---- содержимое файла

const metricCell = (m: Metric): { value: CellValue; unit: string } => {
  if (m.state === 'no_data') return { value: 'нет данных', unit: '' };
  if (m.state === 'unavailable') return { value: 'недоступно', unit: '' };
  return { value: toDisplay(m.value, m.unit), unit: UNIT_TITLES[m.unit] ?? '' };
};

/** Копейки и сотые → единицы показа; проценты – до 0,1 (K24 §2). */
function toDisplay(value: number, unit: MetricUnit): number {
  if (unit === 'kop' || unit === 'centi') return value / 100;
  if (unit === 'pct') return Math.round(value * 10) / 10;
  return value;
}

const titleOf = (key: string): string => METRIC_TITLES[key] ?? key;

/** Вложенная строка детализации → плоские поля. Клиент: id, имя, вид, телефон (маска – по праву на файл); списки – через запятую; да/нет словами. */
export function flattenRow(row: object, opts: { masked: boolean; comments: boolean }): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'comment' && !opts.comments) continue;
    if (k === 'client') {
      const c = v as { id: string; kind: string; name: string | null; phone: string } | null;
      out.clientId = c?.id ?? (out.clientId ?? null);
      out.clientName = c?.name ?? null;
      out.clientPhone = c ? (opts.masked && /^\+\d+$/.test(c.phone) ? maskPhone(c.phone) : c.phone) : null;
      continue;
    }
    if (k === 'payment') {
      const p = v as { state: string; methods: string[]; paidKop: number };
      out.paymentState = p.state;
      out.paymentMethods = p.methods.join(', ');
      out.paymentPaidKop = p.paidKop;
      continue;
    }
    if (k === 'ref') {
      const r = v as { type: string; id: string } | null;
      out.refType = r?.type ?? null;
      out.refId = r?.id ?? null;
      continue;
    }
    if (typeof v === 'boolean') out[k] = v ? 'да' : 'нет';
    else if (Array.isArray(v)) out[k] = v.join(', ');
    else if (typeof v === 'number' || typeof v === 'string' || v === null) out[k] = v;
    else if (v !== undefined) out[k] = JSON.stringify(v);
  }
  return out;
}

function kindOf(key: string, sample: CellValue, totalUnit: MetricUnit | null): ColumnKind {
  if (key === 'value' || key === 'metricValue') return totalUnit === 'kop' ? 'kop' : totalUnit === 'centi' ? 'centi' : 'number';
  if (/Kop$/.test(key)) return 'kop';
  if (/Centi$/.test(key)) return 'centi';
  if (/Local$/.test(key) || key === 'cancelledAt') return 'datetime';
  return typeof sample === 'number' ? 'number' : 'text';
}

function localNow(at: Date, branches: readonly BranchInfo[]): string {
  const single = branches.length === 1 ? branches[0] : undefined;
  const l = instantToLocal(at, single?.timezone ?? NETWORK_ZONE);
  return `${l.date} ${l.time} ${single ? `(${single.timezone})` : '(Москва)'}`;
}

const FILTER_TITLES: Record<string, string> = {
  status: 'статус', resourceType: 'тип ресурса', clientId: 'клиент', cancelledBy: 'кем отменено', adminId: 'сотрудник', paid: 'оплата', method: 'способ оплаты', categoryId: 'статья', metric: 'показатель', segment: 'сегмент',
};

function filterWords(params: Record<string, unknown>): string {
  const parts = Object.entries(params).filter(([k]) => Object.hasOwn(FILTER_TITLES, k)).map(([k, v]) => `${FILTER_TITLES[k]}: ${Array.isArray(v) ? v.join(', ') : k === 'metric' ? titleOf(String(v)) : String(v)}`);
  return parts.length ? parts.join('; ') : 'нет';
}

interface MetricsLike {
  metrics?: Record<string, Metric>;
  dateBasis?: Record<string, string>;
  cards?: Array<{ key: string; title: string; metric: Metric }>;
}

function baseHeader(row: ExportRow, branches: readonly BranchInfo[], now: Date, netWide: boolean): HeaderLine[] {
  return [
    { label: 'Отчёт', value: REPORT_TITLES[row.report] ?? row.report },
    { label: 'Период', value: `${String(row.params.from)} – ${String(row.params.to)}` },
    { label: 'Правило суток', value: DAY_RULE },
    { label: 'Сформирован', value: localNow(now, branches) },
    { label: 'Фильтры', value: filterWords(row.params) },
    { label: 'Область', value: netWide ? 'Вся сеть' : branches.map((b) => b.name).join(', ') },
    { label: 'Телефоны в файле', value: row.masked ? 'маской (нет права на ПДн)' : 'полностью' },
    { label: 'Единицы', value: UNITS_NOTE },
  ];
}

/** Документ файла: итоги в шапке, строки детализации подгружаются страницами в том же снимке. Агрегатный отчёт – показатели строками. */
async function buildDocument(env: ReportEnv, row: ExportRow, p: ReportParams, q: Query, branches: readonly BranchInfo[]): Promise<ExportDocument> {
  const now = env.clock.now();
  const netWide = env.ctx.network && !q.cityId && !q.branchIds?.length;
  const header = baseHeader(row, branches, now, netWide);
  const result: MetricsLike = row.report === 'dashboard' ? ((await dashboard(env, p)) as unknown as MetricsLike) : ((await HANDLERS[row.report]!.metrics(env, q, p)) as MetricsLike);
  const entries: Array<{ title: string; metric: Metric; basis?: string | undefined }> =
    result.cards?.map((c) => ({ title: c.title, metric: c.metric })) ??
    Object.entries(result.metrics ?? {}).map(([k, m]) => ({ title: titleOf(k), metric: m, basis: result.dateBasis?.[k] }));
  if (!row.detail) {
    const columns: ExportColumn[] = [
      { title: 'Показатель', kind: 'text' }, { title: 'Значение', kind: 'number' }, { title: 'Единица', kind: 'text' },
      { title: 'Прошлый период', kind: 'number' }, { title: 'Изменение, %', kind: 'number' }, { title: 'Основа даты', kind: 'text' },
    ];
    async function* rows(): AsyncGenerator<readonly CellValue[]> {
      for (const e of entries) {
        const c = metricCell(e.metric);
        const ok = e.metric.state === 'ok' ? e.metric : null;
        yield [
          e.title, c.value, c.unit, ok && ok.prev !== null && ok.prev !== undefined ? toDisplay(ok.prev, ok.unit) : null,
          ok && ok.deltaPct !== null && ok.deltaPct !== undefined ? Math.round(ok.deltaPct * 10) / 10 : null, e.basis ? (DATE_BASIS_TITLES[e.basis] ?? e.basis) : null,
        ];
      }
    }
    return { header, columns, rows: rows() };
  }
  const handler = HANDLERS[row.report]!;
  const s = segmented(row.report, q, p);
  const first = await handler.detail(env, { ...s.q, limit: DETAIL_PAGE }, s.p);
  const total = first.total as Metric;
  const metricKey = String(q.metric);
  header.push({ label: `Итого: ${titleOf(metricKey)}`, ...totalLine(total) });
  const flat = { masked: row.masked, comments: roleAllows(env.ctx.role, 'reports.export.detail') };
  const sample = first.rows.map((r) => flattenRow(r, flat));
  const keys = [...new Set(sample.flatMap((r) => Object.keys(r)))];
  const unit = total.state === 'ok' ? total.unit : null;
  const firstRow = sample[0] ?? {};
  const kinds = keys.map((k) => kindOf(k, firstRow[k] ?? null, unit));
  const columns: ExportColumn[] = keys.map((k, i) => ({ title: COLUMN_TITLES[k] ?? k, kind: kinds[i]! }));
  const cells = (r: Record<string, CellValue>): CellValue[] => keys.map((k) => r[k] ?? null);
  async function* rows(): AsyncGenerator<readonly CellValue[]> {
    for (const r of sample) yield cells(r);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await handler.detail(env, { ...s.q, cursor, limit: DETAIL_PAGE }, s.p);
      for (const r of next.rows) yield cells(flattenRow(r, flat));
      cursor = next.nextCursor;
    }
  }
  return { header, columns, rows: rows() };
}

function totalLine(m: Metric): { value: CellValue; kind?: ColumnKind } {
  if (m.state !== 'ok') return { value: metricCell(m).value };
  if (m.unit === 'kop') return { value: m.value, kind: 'kop' };
  if (m.unit === 'centi') return { value: m.value, kind: 'centi' };
  return { value: toDisplay(m.value, m.unit), kind: 'number' };
}

// ---- выполнение

async function fail(deps: ExportDeps, row: ExportRow, code: string): Promise<void> {
  const clock = deps.clock ?? systemClock;
  await withTx(deps.pool, async (tx) => {
    const r = await tx.query(`UPDATE app.report_exports SET status = 'failed', error_code = $2, finished_at = $3 WHERE id = $1 AND status IN ('queued','running')`, [row.id, code, clock.now()]);
    if ((r.rowCount ?? 0) > 0) await writeAudit(tx, systemMeta('reports:export'), { action: 'export.failed', object: { type: 'export', id: row.id }, after: { report: row.report, errorCode: code } }, clock);
  });
}

const errorCode = (err: unknown): string => (err instanceof AppError ? err.code : 'EXPORT_FAILED');

/** Одна задача: права на сейчас → снимок → файл (атомарно) → ready. Статус проверяется при завершении: отменённая не оживает, её файл стирается. */
export async function runExportJob(deps: ExportRunDeps, row: ExportRow, signal?: AbortSignal): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const fileKey = randomUUID();
  const progress: WriteProgress = { rows: 0 };
  try {
    const ctx = await loadAccess(deps.pool, { kind: 'staff', staffId: row.staff_id, sessionId: `export:${row.id}` }, clock.now(), deps.network).catch(() => {
      throw new AppError('EXPORT_FORBIDDEN', 403, 'Сотрудник больше не действует');
    });
    try {
      assertRights(ctx, row.report, row.detail);
    } catch {
      throw new AppError('EXPORT_FORBIDDEN', 403, 'Право потеряно');
    }
    const masked = row.masked || !can(ctx, 'export.pd', { network: true });
    const q = parseQuery(row.params.paid === undefined ? row.params : { ...row.params, paid: String(row.params.paid) });
    const p: ReportParams = defined({ period: { from: q.from, to: q.to } as ReportParams['period'], cityId: q.cityId, branchIds: q.branchIds });
    await withReportTx(
      deps.reports,
      async (tx) => {
        const env: ReportEnv = { tx, main: deps.pool, ctx, clock, fileDates: true };
        const branches = await resolveBranches(tx, ctx, 'reports.export', { cityId: q.cityId, branchIds: q.branchIds });
        const doc = await buildDocument(env, { ...row, masked }, p, q, branches);
        return deps.store.writeAtomic(fileKey, exportStream(row.format, doc, progress, clock.now()));
      },
      { timeoutMs: EXPORT_TIMEOUT_MS, budgetMs: EXPORT_TIMEOUT_MS, signal, lane: 'export' },
    ).then(async (written) => {
      const ttl = await resolveSettings(deps.pool, ['reports.export_ttl_hours'], { network: true }, clock.now());
      const now = clock.now();
      const done = await deps.pool.query(
        `UPDATE app.report_exports SET status = 'ready', file_key = $2, rows = $3, bytes = $4, masked = $5, finished_at = $6, expires_at = $7 WHERE id = $1 AND status = 'running'`,
        [row.id, fileKey, progress.rows, written.sizeBytes, masked, now, new Date(now.getTime() + ttl['reports.export_ttl_hours'].value * 3_600_000)],
      );
      if ((done.rowCount ?? 0) === 0) await deps.store.remove(fileKey);
    });
  } catch (err) {
    await deps.store.remove(fileKey).catch(() => {});
    if (err instanceof AppError && (err.code === 'REPORT_CANCELLED' || err.code === 'REPORT_BUSY')) {
      // оборвал не сбой: автор отменил (статус уже cancelled), worker останавливается или в этом процессе уже идёт экспорт
      // (полоса «экспорт ≤ 1», D5-10) – задача вернётся в очередь и пойдёт следующим проходом
      // сбой базы здесь не должен уйти необработанным отказом: строку подберёт failStale
      await deps.pool
        .query(`UPDATE app.report_exports SET status = 'queued', started_at = NULL WHERE id = $1 AND status = 'running'`, [row.id])
        .catch((e: unknown) => deps.log?.(e));
      return;
    }
    if (!(err instanceof AppError)) deps.log?.(err);
    await failLogged(deps, row, errorCode(err));
  }
}

/** fail() из catch и фонового прохода: сбой БД в нём не уходит необработанным отказом промиса (ронял worker) – только в лог.
 *  Строка останется running, её подберёт failStale следующего прохода. */
function failLogged(deps: ExportDeps & { log?: ((err: unknown) => void) | undefined }, row: ExportRow, code: string): Promise<void> {
  return fail(deps, row, code).catch((err: unknown) => (deps.log ?? ((e) => console.error('reports:export: fail()', e)))(err));
}

const CLAIM_LOCK = 72_401_408; // постоянный ключ: проверка «одна на сотрудника, всего 2» и захват – одним шагом

/** Следующая задача, если есть место (K24 §9). Параллельные worker не превысят предел: совет-блокировка на время проверки. */
async function claim(pool: Pool, now: Date, maxRunning: number): Promise<ExportRow | null> {
  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_LOCK]);
    const r = await tx.query<ExportRow>(
      `UPDATE app.report_exports SET status = 'running', started_at = $1
       WHERE id = (SELECT q.id FROM app.report_exports q
                   WHERE q.status = 'queued' AND NOT EXISTS (SELECT 1 FROM app.report_exports x WHERE x.status = 'running' AND x.staff_id = q.staff_id)
                   ORDER BY q.created_at, q.id LIMIT 1)
         AND (SELECT count(*) FROM app.report_exports x WHERE x.status = 'running') < $2
       RETURNING *`,
      [now, maxRunning],
    );
    return r.rows[0] ?? null;
  });
}

/** Процесс умер посреди записи: задача не занимает очередь вечно, пользователь видит ошибку и может повторить. */
async function failStale(deps: ExportRunDeps, active: ReadonlySet<string>, now: Date): Promise<void> {
  const stale = await deps.pool.query<ExportRow>(`SELECT * FROM app.report_exports WHERE status = 'running' AND started_at < $1`, [new Date(now.getTime() - STALE_RUNNING_MS)]);
  for (const row of stale.rows) if (!active.has(row.id)) await failLogged(deps, row, 'EXPORT_INTERRUPTED');
}

export interface ExportRunner {
  /** Один проход: отмены, зависшие, новые задачи. Промис – когда начатые в этом проходе задачи закончатся (тесты). */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export function startExportRunner(deps: ExportRunDeps, opts: { intervalMs?: number; maxRunning?: number; start?: boolean } = {}): ExportRunner {
  const clock = deps.clock ?? systemClock;
  const maxRunning = opts.maxRunning ?? EXPORT_MAX_RUNNING; // K24 §9: всего по всем worker (claim)
  const active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let stopping = false;
  /** Отмены, зависшие, новые задачи. Начатые задачи не ждёт: иначе отмена и вторая задача встанут до конца первой. */
  const pass = async (): Promise<Array<Promise<void>>> => {
    const started: Array<Promise<void>> = [];
    if (stopping) return started;
    const ids = [...active.keys()];
    if (ids.length > 0) {
      const live = await deps.pool.query<{ id: string }>(`SELECT id FROM app.report_exports WHERE id = ANY($1::uuid[]) AND status = 'running'`, [ids]);
      const alive = new Set(live.rows.map((r) => r.id));
      for (const [id, job] of active) if (!alive.has(id)) job.abort.abort();
    }
    await failStale(deps, new Set(active.keys()), clock.now());
    // в этом процессе – не больше полосы экспорта (D5-10): лишняя задача ждала бы 10 с, уходила в очередь и снова (running ↔ queued)
    while (!stopping && active.size < Math.min(maxRunning, reportLimits(deps.reports).export)) {
      const row = await claim(deps.pool, clock.now(), maxRunning);
      if (!row) break;
      const abort = new AbortController();
      const done = runExportJob(deps, row, abort.signal).finally(() => {
        active.delete(row.id);
      });
      active.set(row.id, { abort, done });
      started.push(done);
    }
    return started;
  };
  const tick = async (): Promise<void> => {
    await Promise.all(await pass());
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.start !== false) {
    let running = false;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      pass()
        .catch((err: unknown) => (deps.log ?? ((e) => console.error('reports:export', e)))(err))
        .finally(() => {
          running = false;
        });
    }, opts.intervalMs ?? 5_000);
    timer.unref();
  }
  return {
    tick,
    stop: async () => {
      stopping = true;
      if (timer) clearInterval(timer);
      for (const job of active.values()) job.abort.abort();
      await Promise.allSettled([...active.values()].map((j) => j.done));
    },
  };
}

// ---- уборка reports:export-gc

/** Срок вышел → строка expired, файл стёрт. Файлы без живой строки (упавшая запись) и временные – по возрасту. Строка не удаляется. */
export async function runExportGc(deps: ExportDeps & { store: FileStore }): Promise<{ expired: number; orphans: number }> {
  const now = (deps.clock ?? systemClock).now();
  const due = await deps.pool.query<{ file_key: string | null; old_key?: string }>(
    `WITH due AS (SELECT id, file_key FROM app.report_exports WHERE status = 'ready' AND expires_at <= $1 FOR UPDATE)
     UPDATE app.report_exports r SET status = 'expired', file_key = NULL FROM due WHERE r.id = due.id RETURNING due.file_key`,
    [now],
  );
  for (const r of due.rows) if (r.file_key) await deps.store.remove(r.file_key);
  const live = new Set((await deps.pool.query<{ file_key: string }>(`SELECT file_key FROM app.report_exports WHERE status = 'ready'`)).rows.map((r) => r.file_key));
  let orphans = 0;
  for await (const e of deps.store.list()) {
    if (!live.has(e.relative) && now.getTime() - e.modifiedAt.getTime() > ORPHAN_AGE_MS) {
      await deps.store.remove(e.relative);
      orphans += 1;
    }
  }
  await sweepTmp(deps.store.root, now);
  return { expired: due.rows.length, orphans };
}

/** Временный файл упавшей записи – это ПДн: не лежит дольше суток (бэкап каталог не берёт, но диск – тоже место). */
async function sweepTmp(root: string, now: Date): Promise<void> {
  const dir = path.join(root, '.tmp');
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const full = path.join(dir, name);
    const st = await stat(full).catch(() => null);
    if (st && now.getTime() - st.mtime.getTime() > TMP_AGE_MS) await rm(full, { force: true });
  }
}

export function startExportGc(deps: ExportDeps & { store: FileStore; intervalMs?: number; onError?: (err: unknown) => void }): { stop(): void } {
  const timer = setInterval(() => {
    runExportGc(deps).catch((err: unknown) => (deps.onError ?? ((e) => console.error('reports:export-gc', e)))(err));
  }, deps.intervalMs ?? 15 * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
