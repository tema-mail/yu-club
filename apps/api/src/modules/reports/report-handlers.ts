// Разбор фильтров и таблица отчётов – общие для экрана (routes.crm.ts) и экспорта (export.ts): файл считается теми же функциями,
// с теми же фильтрами и сегментом, что и экран (K24 §7). Сегмент сужает фильтры (segment.ts), дальше тот же where(spec), что у итога.
// График (K11 №240 series) – только по запросу series=day, в том же снимке (series.ts); по часам – только загрузка (3.3).
import { z } from 'zod';
import { AppError } from '../../core/errors.ts';
import { BOOKINGS_ACTION, bookingsDefs, bookingsDetail, bookingsReport, type BookingsParams } from './bookings.ts';
import { CERTIFICATES_ACTION, certificateDefs, certificatesDetail, certificatesReport, giftDefs } from './certificates.ts';
import { CLIENTS_ACTION, clientsDetail, clientsReport } from './clients.ts';
import { COMMS_ACTION, commsDefs, commsDetail, commsReport } from './comms.ts';
import { EQUIPMENT_ACTION, equipmentDefs, equipmentDetail, equipmentReport } from './equipment.ts';
import { EVENTS_ACTION, eventsDefs, eventsDetail, eventsReport } from './events.ts';
import { FINANCE_ACTION, financeDefs, financeDetail, financeReport, type FinanceParams } from './finance.ts';
import type { MetricDef, ReportEnv, ReportParams } from './framework.ts';
import { LOYALTY_ACTION, loyaltyDefs, loyaltyDetail, loyaltyReport } from './loyalty.ts';
import { applySegment } from './segment.ts';
import { clientsSeriesDefs, daySeries, type DaySeries, type DaySeriesOpts } from './series.ts';
import { staffDetail, staffReport } from './staff.ts';
import { utilizationDetail, utilizationReport, utilizationSeries, type UtilizationParams } from './utilization.ts';

const UUID = z.string().uuid();
const list = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item))
    .optional();

const QUERY = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  cityId: z.string().optional(),
  branchIds: list(z.string()),
  status: list(z.string().max(40)),
  resourceType: list(z.string().max(40)),
  clientId: UUID.optional(),
  cancelledBy: z.enum(['client', 'club']).optional(),
  adminId: UUID.optional(),
  paid: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  method: list(z.enum(['cash', 'card', 'transfer'])),
  categoryId: UUID.optional(),
  series: z.enum(['day', 'hour']).optional(),
  metric: z.string().max(60).optional(),
  segment: z.string().max(60).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type Query = z.infer<typeof QUERY> & { segmentSource?: string | undefined; segmentPlace?: 'cash' | 'noncash' | undefined; segmentHour?: string | undefined };

export function parseQuery(raw: unknown): Query {
  const r = QUERY.safeParse(raw ?? {});
  if (!r.success) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверный фильтр', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

export const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export interface ReportHandler {
  metrics(env: ReportEnv, q: Query, p: ReportParams): Promise<Record<string, unknown>>;
  detail(env: ReportEnv, q: Query, p: ReportParams): Promise<{ rows: object[]; total: unknown; nextCursor: string | null; columns?: readonly string[] }>;
}

const page = (q: Query) => defined({ cursor: q.cursor, limit: q.limit });
const bookingsP = (q: Query, p: ReportParams): BookingsParams => defined({ ...p, status: q.status, resourceType: q.resourceType, clientId: q.clientId, cancelledBy: q.cancelledBy, adminId: q.adminId, paid: q.paid });
const financeP = (q: Query, p: ReportParams): FinanceParams => defined({ ...p, method: q.method, categoryId: q.categoryId });
const utilizationP = (q: Query, p: ReportParams): UtilizationParams => defined({ ...p, resourceType: q.resourceType });

/** Сегмент сужает фильтры (K24 §10, segment.ts) – дальше тот же where(spec), что и у итога. */
export function segmented(report: string, q: Query, p: ReportParams): { q: Query; p: ReportParams } {
  const s = applySegment(report, q.segment, {
    period: p.period, branchIds: p.branchIds, resourceType: q.resourceType, status: q.status, method: q.method, categoryId: q.categoryId,
  });
  return {
    q: { ...q, resourceType: s.resourceType, status: s.status, method: s.method as Query['method'], categoryId: s.categoryId, segmentSource: s.source, segmentPlace: s.place, segmentHour: s.hour },
    p: { ...p, period: s.period, branchIds: s.branchIds },
  };
}

/** Точки по дням к ответу отчёта – только по series=day; series=hour есть у одной загрузки (чужой фильтр – REPORT_FILTER_INVALID, K24 §10). */
async function withSeries(env: ReportEnv, q: Query, result: object, action: string, p: ReportParams, defs: Record<string, MetricDef>, opts?: DaySeriesOpts): Promise<Record<string, unknown>> {
  if (q.series === undefined) return result as Record<string, unknown>;
  if (q.series !== 'day') throw new AppError('REPORT_FILTER_INVALID', 422, 'График по часам есть только у загрузки ресурсов', { field: 'series' });
  const series: DaySeries = await daySeries(env, action, p, defs, opts);
  return { ...result, series };
}

export const HANDLERS: Record<string, ReportHandler> = {
  bookings: {
    metrics: async (env, q, p) => withSeries(env, q, await bookingsReport(env, bookingsP(q, p)), BOOKINGS_ACTION, bookingsP(q, p), bookingsDefs(bookingsP(q, p))),
    detail: (env, q, p) => bookingsDetail(env, bookingsP(q, p), q.metric, page(q)),
  },
  utilization: {
    metrics: async (env, q, p) => {
      const r = await utilizationReport(env, utilizationP(q, p));
      return { ...r, ...(q.series ? { series: await utilizationSeries(env, utilizationP(q, p), q.series) } : {}) };
    },
    detail: (env, q, p) => utilizationDetail(env, defined({ ...utilizationP(q, p), hour: q.segmentHour }), q.metric, page(q)),
  },
  finance: {
    metrics: async (env, q, p) => withSeries(env, q, await financeReport(env, financeP(q, p)), FINANCE_ACTION, financeP(q, p), financeDefs(financeP(q, p))),
    detail: (env, q, p) => financeDetail(env, defined({ ...financeP(q, p), source: q.segmentSource, place: q.segmentPlace }), q.metric, page(q)),
  },
  clients: {
    metrics: async (env, q, p) => withSeries(env, q, await clientsReport(env, p), CLIENTS_ACTION, p, clientsSeriesDefs()),
    detail: (env, q, p) => clientsDetail(env, p, q.metric, page(q)),
  },
  loyalty: {
    metrics: async (env, q, p) => withSeries(env, q, await loyaltyReport(env, p), LOYALTY_ACTION, p, loyaltyDefs(), { networkRows: true }),
    detail: (env, q, p) => loyaltyDetail(env, p, q.metric, page(q)),
  },
  certificates: {
    metrics: async (env, q, p) => withSeries(env, q, await certificatesReport(env, p), CERTIFICATES_ACTION, p, { ...certificateDefs(), ...giftDefs() }),
    detail: (env, q, p) => certificatesDetail(env, p, q.metric, page(q)),
  },
  comms: {
    metrics: async (env, q, p) => withSeries(env, q, await commsReport(env, p), COMMS_ACTION, p, commsDefs(), { networkRows: true }),
    detail: (env, q, p) => commsDetail(env, p, q.metric, page(q)),
  },
  events: {
    metrics: async (env, q, p) => withSeries(env, q, await eventsReport(env, p), EVENTS_ACTION, p, eventsDefs()),
    detail: (env, q, p) => eventsDetail(env, p, q.metric, page(q)),
  },
  equipment: {
    metrics: async (env, q, p) => withSeries(env, q, await equipmentReport(env, p), EQUIPMENT_ACTION, p, equipmentDefs()),
    detail: (env, q, p) => equipmentDetail(env, p, q.metric, page(q)),
  },
  staff: {
    metrics: (env, _q, p) => staffReport(env, p) as unknown as Promise<Record<string, unknown>>,
    detail: (env, q, p) => staffDetail(env, p, q.metric, page(q)),
  },
};
