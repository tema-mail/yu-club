// Разбор фильтров и таблица отчётов – общие для экрана (routes.crm.ts) и экспорта (export.ts): файл считается теми же функциями,
// с теми же фильтрами и сегментом, что и экран (K24 §7). Сегмент сужает фильтры (segment.ts), дальше тот же where(spec), что у итога.
import { z } from 'zod';
import { AppError } from '../../core/errors.ts';
import { bookingsDetail, bookingsReport, type BookingsParams } from './bookings.ts';
import { certificatesDetail, certificatesReport } from './certificates.ts';
import { clientsDetail, clientsReport } from './clients.ts';
import { financeDetail, financeReport, type FinanceParams } from './finance.ts';
import type { ReportEnv, ReportParams } from './framework.ts';
import { loyaltyDetail, loyaltyReport } from './loyalty.ts';
import { applySegment } from './segment.ts';
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

export const HANDLERS: Record<string, ReportHandler> = {
  bookings: {
    metrics: (env, q, p) => bookingsReport(env, bookingsP(q, p)) as unknown as Promise<Record<string, unknown>>,
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
    metrics: (env, q, p) => financeReport(env, financeP(q, p)) as unknown as Promise<Record<string, unknown>>,
    detail: (env, q, p) => financeDetail(env, defined({ ...financeP(q, p), source: q.segmentSource, place: q.segmentPlace }), q.metric, page(q)),
  },
  clients: {
    metrics: (env, _q, p) => clientsReport(env, p) as unknown as Promise<Record<string, unknown>>,
    detail: (env, q, p) => clientsDetail(env, p, q.metric, page(q)),
  },
  loyalty: {
    metrics: (env, _q, p) => loyaltyReport(env, p) as unknown as Promise<Record<string, unknown>>,
    detail: (env, q, p) => loyaltyDetail(env, p, q.metric, page(q)),
  },
  certificates: {
    metrics: (env, _q, p) => certificatesReport(env, p) as unknown as Promise<Record<string, unknown>>,
    detail: (env, q, p) => certificatesDetail(env, p, q.metric, page(q)),
  },
};
