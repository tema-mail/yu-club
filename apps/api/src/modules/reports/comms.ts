// S4-74. Отчёт «Уведомления и публикации» (K24 §3.11, 14 §14). Уведомления – rpt_notifications раздельно по категориям service, reminder, marketing:
// передано провайдеру – это «передано в браузер, показ не подтверждён», а не доставка; прочтение в центре – отдельный показатель «открыто в кабинете».
// Отказы от рекламы – журнал согласий (rpt_consent_changes); материалы – первая публикация в периоде (rpt_content_versions, version_no = 1).
// Просмотры и переходы с сайта – source_not_ready, пока нет веб-аналитики (Q-144). Строка уведомления без филиала видна только в сетевой области.
// Область директора (TC-16): отказы – клиенты с бронью в его филиалах (у клиента нет филиала, как новые профили 3.6); материалы – его филиалов и всей сети.
import type { Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { BranchInfo } from '../network/index.ts';
import {
  computeMetrics, DAY_RULE, detailPage, loadMaskedClients, localAt, metricDef, noData, okMetric, pageLimit, prevPeriod, resolveBranches, unavailable, windowsOf,
  type BranchWindow, type MaskedClient, type Metric, type MetricDef, type Period, type ReportEnv, type ReportParams,
} from './framework.ts';
import { noBranchWindow } from './series.ts';

export const COMMS_ACTION = 'reports.comms.view';

export const COMMS_CATEGORIES = ['service', 'reminder', 'marketing'] as const;
export type CommsCategory = (typeof COMMS_CATEGORIES)[number];

/** Показатель одной категории → условие по строке уведомления. */
const NOTIFICATION_PARTS = {
  Created: null,
  SentToProvider: `t.status = 'sent_to_provider'`,
  InboxOnly: `t.status IN ('no_channel', 'inbox_only')`,
  SkippedByPrefs: `t.status = 'skipped_by_prefs'`,
  SkippedByFrequency: `t.status = 'skipped_by_frequency'`,
  SkippedBookingChanged: `t.status = 'skipped_booking_changed'`,
  Errors: `t.status = 'error'`,
  OpenedInCabinet: 't.read_at IS NOT NULL',
} as const;

export const PUBLISHED_TYPES = { news: 'publishedNews', promotion: 'publishedPromotion', giveaway: 'publishedGiveaway', tournament: 'publishedTournament', game: 'publishedGame', room_page: 'publishedRoomPage', branch_page: 'publishedBranchPage', content_page: 'publishedPage', home_block: 'publishedHomeBlock' } as const;
type PublishedMetric = (typeof PUBLISHED_TYPES)[keyof typeof PUBLISHED_TYPES];

const REACH_STATUSES = `('sent_to_provider', 'no_channel', 'inbox_only')`;

export const COMMS_LABELS = {
  sentToProvider: 'Передано в браузер, показ не подтверждён',
  openedInCabinet: 'Открыто в кабинете – достоверное событие нашего канала',
  campaignsReach: 'Охват – получатели, которым сообщение передано в браузер или показано в центре уведомлений',
  optOuts: 'Отказы от рекламы из журнала согласий',
  siteViews: 'Появится после веб-аналитики',
};

export function commsDefs(): Record<string, MetricDef> {
  const base = (conds: Array<{ sql: string; values?: unknown[] }>): MetricDef => ({
    spec: { view: 'app.rpt_notifications', date: 'created_at', nullableBranch: true, conds },
    agg: 'count', unit: 'count', dateBasis: 'created_at', idCol: 'notification_id',
  });
  const defs: Record<string, MetricDef> = {};
  for (const category of COMMS_CATEGORIES) {
    for (const [part, sql] of Object.entries(NOTIFICATION_PARTS)) {
      defs[`${category}${part}`] = base([{ sql: 't.category = ?', values: [category] }, ...(sql ? [{ sql }] : [])]);
    }
  }
  const marketing = { sql: `t.category = 'marketing' AND t.campaign_id IS NOT NULL` };
  defs.campaignsCount = { ...base([marketing]), agg: 'count_distinct', col: 'campaign_id' };
  defs.campaignsReach = base([marketing, { sql: `t.status IN ${REACH_STATUSES}` }]);
  return defs;
}

/** Окна уведомлений: строка без филиала – только в сетевой области без фильтра, сутки UTC периода (series.ts noBranchWindow). */
function noticeWindows(env: ReportEnv, p: ReportParams, branches: readonly BranchInfo[], period: Period): BranchWindow[] {
  const w = windowsOf(branches, period);
  if (networkWide(env, p) && w.length > 0) w.push(noBranchWindow(period));
  return w;
}

const networkWide = (env: ReportEnv, p: ReportParams): boolean => env.ctx.network && !p.cityId && !p.branchIds?.length;

/** Без филиала (согласия, материалы) период – от самых ранних суток области до самых поздних. */
function span(w: readonly BranchWindow[]): { start: Date; end: Date } {
  return { start: new Date(Math.min(...w.map((x) => x.start.getTime()))), end: new Date(Math.max(...w.map((x) => x.end.getTime()))) };
}

// ---- отказы от рекламы

function optOutFrom(wide: boolean, windows: readonly BranchWindow[]): { sql: string; params: unknown[] } {
  if (wide) {
    const s = span(windows);
    return { sql: `app.rpt_consent_changes t WHERE NOT t.granted AND t.at >= $1 AND t.at < $2`, params: [s.start, s.end] };
  }
  return {
    sql: `app.rpt_consent_changes t WHERE NOT t.granted AND EXISTS (
            SELECT 1 FROM app.rpt_bookings b JOIN unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e) ON w.branch_id = b.branch_id
            WHERE b.client_id = t.client_id AND t.at >= w.s AND t.at < w.e)`,
    params: [windows.map((w) => w.branchId), windows.map((w) => w.start), windows.map((w) => w.end)],
  };
}

async function countOptOuts(tx: Tx, wide: boolean, windows: readonly BranchWindow[]): Promise<number> {
  if (windows.length === 0) return 0;
  const f = optOutFrom(wide, windows);
  return Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${f.sql}`, f.params)).rows[0]!.n);
}

// ---- опубликованные материалы

function publishedFrom(wide: boolean, windows: readonly BranchWindow[], extra = ''): { sql: string; params: unknown[] } {
  const s = span(windows);
  const area = wide ? '' : ` AND (t.branch_ids IS NULL OR t.branch_ids && $3::uuid[])`;
  return {
    sql: `app.rpt_content_versions t WHERE t.version_no = 1 AND t.published_at >= $1 AND t.published_at < $2${area}${extra}`,
    params: [s.start, s.end, ...(wide ? [] : [windows.map((w) => w.branchId)])],
  };
}

async function countPublished(tx: Tx, wide: boolean, windows: readonly BranchWindow[]): Promise<Record<string, number>> {
  if (windows.length === 0) return {};
  const f = publishedFrom(wide, windows);
  const r = await tx.query<{ type: string; n: string }>(`SELECT t.type, count(*) AS n FROM ${f.sql} GROUP BY t.type`, f.params);
  return Object.fromEntries(r.rows.map((x) => [x.type, Number(x.n)]));
}

const delta = (cur: number, prev: number, any: boolean, anyPrev: boolean): Metric => (any ? okMetric(cur, 'count', anyPrev ? prev : null) : noData);

export interface CommsResult {
  metrics: Record<string, Metric>;
  labels: typeof COMMS_LABELS;
  dateBasis: Record<string, string>;
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

export async function commsReport(env: ReportEnv, p: ReportParams): Promise<CommsResult> {
  const branches = await resolveBranches(env.tx, env.ctx, COMMS_ACTION, p);
  const prevP = prevPeriod(p.period);
  const defs = commsDefs();
  const notices = await computeMetrics(env.tx, defs, noticeWindows(env, p, branches, p.period), noticeWindows(env, p, branches, prevP));
  const wide = networkWide(env, p);
  const cur = windowsOf(branches, p.period);
  const prev = windowsOf(branches, prevP);
  const [optCur, optPrev] = [await countOptOuts(env.tx, wide, cur), await countOptOuts(env.tx, wide, prev)];
  const [pubCur, pubPrev] = [await countPublished(env.tx, wide, cur), await countPublished(env.tx, wide, prev)];
  const anyPub = Object.keys(pubCur).length > 0;
  const anyPubPrev = Object.keys(pubPrev).length > 0;
  const live = anyPub || optCur > 0 || Object.values(notices).some((m) => m.state === 'ok');
  const livePrev = anyPubPrev || optPrev > 0 || Object.values(notices).some((m) => m.state === 'ok' && m.prev !== null && m.prev !== undefined);
  const metrics: Record<string, Metric> = { ...notices, optOuts: delta(optCur, optPrev, live, livePrev) };
  const dateBasis: Record<string, string> = { optOuts: 'at', siteViews: 'at', siteClicks: 'at' };
  for (const k of Object.keys(defs)) dateBasis[k] = 'created_at';
  for (const [type, key] of Object.entries(PUBLISHED_TYPES) as Array<[string, PublishedMetric]>) {
    metrics[key] = delta(pubCur[type] ?? 0, pubPrev[type] ?? 0, live, livePrev);
    dateBasis[key] = 'at';
  }
  metrics.siteViews = unavailable('source_not_ready');
  metrics.siteClicks = unavailable('source_not_ready');
  return { metrics, labels: COMMS_LABELS, dateBasis, period: p.period, prevPeriod: prevP, computedAt: env.clock.now().toISOString(), dayRule: DAY_RULE };
}

// ---- детализация

export interface CommsNoticeRow {
  notificationId: string;
  branchId: string | null;
  category: string;
  kind: string;
  source: string;
  campaignId: string | null;
  status: string;
  createdLocal: string | null;
  sentLocal: string | null;
  readLocal: string | null;
}

export interface CommsOptOutRow {
  consentId: string;
  clientId: string;
  client: MaskedClient | null;
  atLocal: string | null;
  source: string;
}

export interface CommsPublishedRow {
  versionId: string;
  entityType: string;
  entityId: string;
  type: string;
  scopeType: string;
  atLocal: string | null;
}

interface NoticeSource {
  notification_id: string;
  branch_id: string | null;
  category: string;
  kind: string;
  source: string;
  campaign_id: string | null;
  status: string;
  created_at: Date;
  sent_at: Date | null;
  read_at: Date | null;
}

/** Курсор строк журнала – сам id (bigint). */
function idCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  if (!/^\d{1,18}$/.test(cursor)) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверный курсор', { field: 'cursor' });
  return cursor;
}

export async function commsDetail(
  env: ReportEnv,
  p: ReportParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: Array<CommsNoticeRow | CommsOptOutRow | CommsPublishedRow>; total: Metric; nextCursor: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, COMMS_ACTION, p);
  const fallback = branches[0];
  const wide = networkWide(env, p);
  const windows = windowsOf(branches, p.period);
  const limit = pageLimit(opts);
  const zone = (id: string | null) => branches.find((b) => b.id === id)?.timezone ?? fallback?.timezone;
  const at = (d: Date | null, branchId: string | null): string | null => {
    if (!d) return null;
    const tz = zone(branchId);
    return tz ? localAt(env, d, tz) : d.toISOString();
  };
  if (metric === 'siteViews' || metric === 'siteClicks') return { rows: [], total: unavailable('source_not_ready'), nextCursor: null };
  if (metric === 'optOuts') {
    if (windows.length === 0) return { rows: [], total: noData, nextCursor: null };
    const f = optOutFrom(wide, windows);
    const total = await countOptOuts(env.tx, wide, windows);
    const after = idCursor(opts.cursor);
    const params = [...f.params, after, limit + 1];
    const r = await env.tx.query<{ consent_id: string; client_id: string; at: Date; source: string }>(
      `SELECT t.consent_id, t.client_id, t.at, t.source FROM ${f.sql} AND ($${params.length - 1}::bigint IS NULL OR t.consent_id > $${params.length - 1}::bigint) ORDER BY t.consent_id LIMIT $${params.length}`,
      params,
    );
    const page = r.rows.slice(0, limit);
    const masked = await loadMaskedClients(env.main, env.ctx, page.map((x) => ({ clientId: x.client_id, branchId: fallback!.id })));
    return {
      rows: page.map((x) => ({ consentId: x.consent_id, clientId: x.client_id, client: masked.get(`${x.client_id}:${fallback!.id}`) ?? null, atLocal: at(x.at, null), source: x.source })),
      total: total === 0 ? noData : okMetric(total, 'count'),
      nextCursor: r.rows.length > limit ? page[page.length - 1]!.consent_id : null,
    };
  }
  const pubType = Object.entries(PUBLISHED_TYPES).find(([, key]) => key === metric)?.[0];
  if (pubType) {
    if (windows.length === 0) return { rows: [], total: noData, nextCursor: null };
    const base = publishedFrom(wide, windows);
    const params = [...base.params, pubType];
    const typeSql = `${base.sql} AND t.type = $${params.length}`;
    const total = Number((await env.tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${typeSql}`, params)).rows[0]!.n);
    const after = idCursor(opts.cursor);
    const pageParams = [...params, after, limit + 1];
    const r = await env.tx.query<{ version_id: string; entity_type: string; entity_id: string; type: string; scope_type: string; published_at: Date }>(
      `SELECT t.version_id, t.entity_type, t.entity_id, t.type, t.scope_type, t.published_at FROM ${typeSql} AND ($${pageParams.length - 1}::bigint IS NULL OR t.version_id > $${pageParams.length - 1}::bigint) ORDER BY t.version_id LIMIT $${pageParams.length}`,
      pageParams,
    );
    const page = r.rows.slice(0, limit);
    return {
      rows: page.map((x) => ({ versionId: x.version_id, entityType: x.entity_type, entityId: x.entity_id, type: x.type, scopeType: x.scope_type, atLocal: at(x.published_at, null) })),
      total: total === 0 ? noData : okMetric(total, 'count'),
      nextCursor: r.rows.length > limit ? page[page.length - 1]!.version_id : null,
    };
  }
  const def = metricDef(commsDefs(), metric);
  const page = await detailPage<NoticeSource & { campaign_id: string | null }>(env.tx, def, noticeWindows(env, p, branches, p.period), opts);
  return {
    rows: page.rows.map((r) => ({
      notificationId: r.notification_id, branchId: r.branch_id, category: r.category, kind: r.kind, source: r.source, campaignId: r.campaign_id, status: r.status,
      createdLocal: at(r.created_at, r.branch_id), sentLocal: at(r.sent_at, r.branch_id), readLocal: at(r.read_at, r.branch_id),
    })),
    total: page.total.rows === 0 ? noData : okMetric(page.total.value, def.unit),
    nextCursor: page.nextCursor,
  };
}
