// S4-63. Отчёт «Бронирования и посещаемость» (K24 §3.2, 14 §5). Источники – rpt_bookings, rpt_booking_reschedules, rpt_visits,
// rpt_no_shows; у каждого показателя своя дата (dateBasis): создание, сеанс, перенос. Отмена относится к дате сеанса (решение K24),
// неявка – только явно отмеченная; «ожидают решения» – на момент запроса (K11 №3). Гость – в «состоялось», не в «уникальных» (приёмка 12).
import { loadMaskedClients, localAt, metricDef, runDetail, runMetrics, type MaskedClient, type Metric, type MetricDef, type MetricSpec, type ReportEnv, type ReportParams, type ReportResult } from './framework.ts';

export const BOOKINGS_ACTION = 'reports.ops.view';

export interface BookingsParams extends ReportParams {
  status?: string[] | undefined;
  resourceType?: string[] | undefined;
  clientId?: string | undefined;
  cancelledBy?: 'client' | 'club' | undefined;
  adminId?: string | undefined;
  paid?: boolean | undefined;
}

export type BookingsMetric =
  | 'created' | 'planned' | 'visited' | 'cancelledByClient' | 'cancelledByClub' | 'rescheduled' | 'noShows' | 'awaitingDecision' | 'avgMinutes' | 'uniqueVisitors';

type Conds = NonNullable<MetricSpec['conds']>;

/** Условия фильтров по строке брони (alias – b или t). Один источник правды для итога и детализации. */
function bookingConds(p: BookingsParams, alias: string): Conds {
  const c: Conds = [];
  if (p.status?.length) c.push({ sql: `${alias}.status = ANY(?::text[])`, values: [p.status] });
  if (p.resourceType?.length) c.push({ sql: `${alias}.resource_type = ANY(?::text[])`, values: [p.resourceType] });
  if (p.clientId) c.push({ sql: `${alias}.client_id = ?::uuid`, values: [p.clientId] });
  if (p.cancelledBy) c.push({ sql: `${alias}.cancelled_by = ?`, values: [p.cancelledBy] });
  if (p.paid !== undefined) {
    c.push({ sql: `${p.paid ? '' : 'NOT '}EXISTS (SELECT 1 FROM app.rpt_payments pay WHERE pay.booking_id = ${alias}.booking_id AND pay.status <> 'refunded')` });
  }
  return c;
}

/** То же для представлений со ссылкой на бронь: подзапрос по rpt_bookings – только если фильтр задан. */
function linkedConds(p: BookingsParams): Conds {
  const inner = bookingConds(p, 'b');
  if (inner.length === 0) return [];
  return [{ sql: `t.booking_id IN (SELECT b.booking_id FROM app.rpt_bookings b WHERE ${inner.map((c) => c.sql).join(' AND ')})`, values: inner.flatMap((c) => c.values ?? []) }];
}

export function bookingsDefs(p: BookingsParams): Record<BookingsMetric, MetricDef> {
  const own = bookingConds(p, 't');
  const byCreator: Conds = p.adminId ? [{ sql: 't.created_by_id = ?::uuid', values: [p.adminId] }] : [];
  const byMarker: Conds = p.adminId ? [{ sql: 't.marked_by = ?::uuid', values: [p.adminId] }] : [];
  const linked = linkedConds(p);
  const bookings = (date: string | undefined, dateBasis: string, conds: Conds = []): MetricDef => ({
    spec: { view: 'app.rpt_bookings', ...(date ? { date } : {}), conds: [...own, ...byCreator, ...conds] },
    agg: 'count', unit: 'count', dateBasis, idCol: 'booking_id',
  });
  const visits = (extra: Partial<MetricDef> = {}, conds: Conds = []): MetricDef => ({
    spec: { view: 'app.rpt_visits', date: 'planned_start', conds: [...linked, ...byMarker, ...conds] },
    agg: 'count', unit: 'count', dateBasis: 'session_start', idCol: 'booking_id', ...extra,
  });
  return {
    created: bookings('created_at', 'created_at'),
    planned: bookings('start_at', 'session_start', [{ sql: `t.status NOT IN ('cancelled_by_client', 'cancelled_by_club')` }]),
    visited: visits(),
    cancelledByClient: bookings('start_at', 'session_start', [{ sql: `t.status = 'cancelled_by_client'` }]),
    cancelledByClub: bookings('start_at', 'session_start', [{ sql: `t.status = 'cancelled_by_club'` }]),
    rescheduled: {
      spec: { view: 'app.rpt_booking_reschedules', date: 'rescheduled_at', conds: linked },
      agg: 'count_distinct', col: 'booking_id', unit: 'count', dateBasis: 'rescheduled_at', idCol: 'booking_id',
    },
    noShows: { spec: { view: 'app.rpt_no_shows', date: 'planned_start', conds: [...linked, ...byMarker] }, agg: 'count', unit: 'count', dateBasis: 'session_start', idCol: 'booking_id' },
    awaitingDecision: bookings(undefined, 'now', [{ sql: 't.needs_decision' }]),
    avgMinutes: visits({ agg: 'avg', col: 'planned_minutes', unit: 'minutes', subtitle: 'по расписанию' }),
    uniqueVisitors: visits({ agg: 'count_distinct', col: 'client_id' }, [{ sql: `t.client_kind = 'profile'` }]),
  };
}

export function bookingsReport(env: ReportEnv, p: BookingsParams): Promise<ReportResult<BookingsMetric>> {
  return runMetrics(env, BOOKINGS_ACTION, p, bookingsDefs(p));
}

export interface BookingDetailRow {
  bookingId: string;
  number: number;
  startLocal: string;
  branchId: string;
  branchName: string;
  client: MaskedClient | null;
  resourceType: string;
  resourceName: string;
  minutes: number;
  status: string;
  priceKop: number;
  payment: { state: 'paid' | 'unpaid'; methods: string[]; paidKop: number };
  reasonCode: string | null;
  cancelledAt: string | null;
  metricValue: number | null;
}

export const BOOKING_DETAIL_COLUMNS = ['number', 'startLocal', 'branchName', 'client', 'resourceName', 'minutes', 'status', 'priceKop', 'payment', 'reasonCode', 'cancelledAt'] as const;

interface BookingRow {
  booking_id: string;
  number: string;
  branch_id: string;
  client_id: string;
  resource_type: string;
  resource_name: string;
  start_at: Date;
  minutes: number;
  status: string;
  price_kop: string;
  cancel_reason_code: string | null;
  cancelled_at: Date | null;
}

/** Детализация показателя (14 §5.3): строка = бронь; условие – то же where, что у итога. */
export async function bookingsDetail(
  env: ReportEnv,
  p: BookingsParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ columns: typeof BOOKING_DETAIL_COLUMNS; rows: BookingDetailRow[]; total: Metric; nextCursor: string | null }> {
  const def = metricDef(bookingsDefs(p), metric);
  const page = await runDetail<{ booking_id: string; planned_minutes?: number }>(env, BOOKINGS_ACTION, p, def, opts);
  const ids = page.rows.map((r) => r.booking_id);
  const rows = (await env.tx.query<BookingRow>(`SELECT * FROM app.rpt_bookings WHERE booking_id = ANY($1::uuid[])`, [ids])).rows;
  const byId = new Map(rows.map((r) => [r.booking_id, r]));
  const pays = (await env.tx.query<{ booking_id: string; method: string; amount_kop: string; status: string }>(`SELECT booking_id, method, amount_kop, status FROM app.rpt_payments WHERE booking_id = ANY($1::uuid[])`, [ids])).rows;
  const noShow = new Map((await env.tx.query<{ booking_id: string; reason_code: string | null }>(`SELECT booking_id, reason_code FROM app.rpt_no_shows WHERE booking_id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.booking_id, r.reason_code]));
  const clients = await loadMaskedClients(env.main, env.ctx, rows.map((r) => ({ clientId: r.client_id, branchId: r.branch_id })));
  const branches = new Map(page.branches.map((b) => [b.id, b]));
  const out: BookingDetailRow[] = [];
  for (const src of page.rows) {
    const r = byId.get(src.booking_id);
    const branch = r && branches.get(r.branch_id);
    if (!r || !branch) continue;
    const live = pays.filter((x) => x.booking_id === r.booking_id && x.status !== 'refunded');
    out.push({
      bookingId: r.booking_id,
      number: Number(r.number),
      startLocal: localAt(env, r.start_at, branch.timezone),
      branchId: r.branch_id,
      branchName: branch.name,
      client: clients.get(`${r.client_id}:${r.branch_id}`) ?? null,
      resourceType: r.resource_type,
      resourceName: r.resource_name,
      minutes: r.minutes,
      status: r.status,
      priceKop: Number(r.price_kop),
      payment: { state: live.length ? 'paid' : 'unpaid', methods: live.map((x) => x.method), paidKop: live.reduce((s, x) => s + Number(x.amount_kop), 0) },
      reasonCode: r.cancel_reason_code ?? noShow.get(r.booking_id) ?? null,
      cancelledAt: r.cancelled_at ? (env.fileDates ? localAt(env, r.cancelled_at, branch.timezone) : r.cancelled_at.toISOString()) : null,
      metricValue: src.planned_minutes ?? null,
    });
  }
  return { columns: BOOKING_DETAIL_COLUMNS, rows: out, total: page.total, nextCursor: page.nextCursor };
}
