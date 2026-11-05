// S4-70. API CRM отчётов K24 §10, K11 №239–242, №248; S4-75 – глобальный поиск №250. Тонкий слой (ADR 0002 п.7): разбор запроса → функция
// отчёта в READ ONLY-снимке пула yu_reports → ответ. Права и область – внутри отчётов (resolveBranches): вне зоны 404, без права 403.
// Период длиннее reports.interactive_max_days – REPORT_PERIOD_TOO_LONG с useExport. Чужой фильтр – REPORT_FILTER_INVALID, не 400.
// Журнал сверки (свои таблицы reports) читается основным пулом: у yu_reports на них прав нет.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditRequestMeta, Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { bookingsDetail, bookingsReport, type BookingsParams } from './bookings.ts';
import { certificatesDetail, certificatesReport } from './certificates.ts';
import { clientsDetail, clientsReport } from './clients.ts';
import { dashboard } from './dashboard.ts';
import { financeDetail, financeReport, type FinanceParams } from './finance.ts';
import { parsePeriod, unavailable, withReportTx, DAY_RULE, type ReportEnv, type ReportParams, type ReportsPool } from './framework.ts';
import { loyaltyDetail, loyaltyReport } from './loyalty.ts';
import { globalSearch } from './search.ts';
import { utilizationCalendar, utilizationDetail, utilizationReport, utilizationSeries, type UtilizationParams } from './utilization.ts';

export interface ReportsCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  reports: ReportsPool;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

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
type Query = z.infer<typeof QUERY>;

function parseQuery(raw: unknown): Query {
  const r = QUERY.safeParse(raw ?? {});
  if (!r.success) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверный фильтр', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

async function periodParams(deps: ReportsCrmDeps, clock: Clock, q: Query): Promise<ReportParams> {
  const s = await resolveSettings(deps.pool, ['reports.interactive_max_days'], { network: true }, clock.now());
  return defined({ period: parsePeriod({ from: q.from, to: q.to }, { clock, maxDays: s['reports.interactive_max_days'].value }), cityId: q.cityId, branchIds: q.branchIds });
}

interface ReportHandler {
  metrics(env: ReportEnv, q: Query, p: ReportParams): Promise<Record<string, unknown>>;
  detail(env: ReportEnv, q: Query, p: ReportParams): Promise<{ rows: object[]; total: unknown; nextCursor: string | null; columns?: readonly string[] }>;
}

const page = (q: Query) => defined({ cursor: q.cursor, limit: q.limit });
const bookingsP = (q: Query, p: ReportParams): BookingsParams => defined({ ...p, status: q.status, resourceType: q.resourceType, clientId: q.clientId, cancelledBy: q.cancelledBy, adminId: q.adminId, paid: q.paid });
const financeP = (q: Query, p: ReportParams): FinanceParams => defined({ ...p, method: q.method, categoryId: q.categoryId });
const utilizationP = (q: Query, p: ReportParams): UtilizationParams => defined({ ...p, resourceType: q.resourceType });

const HANDLERS: Record<string, ReportHandler> = {
  bookings: {
    metrics: (env, q, p) => bookingsReport(env, bookingsP(q, p)) as unknown as Promise<Record<string, unknown>>,
    detail: (env, q, p) => bookingsDetail(env, bookingsP(q, p), q.metric, page(q)),
  },
  utilization: {
    metrics: async (env, q, p) => {
      const r = await utilizationReport(env, utilizationP(q, p));
      return { ...r, ...(q.series ? { series: await utilizationSeries(env, utilizationP(q, p), q.series) } : {}) };
    },
    detail: async (env, q, p) => ({ ...(await utilizationDetail(env, utilizationP(q, p), q.metric)), nextCursor: null }),
  },
  finance: {
    metrics: (env, q, p) => financeReport(env, financeP(q, p)) as unknown as Promise<Record<string, unknown>>,
    detail: (env, q, p) => financeDetail(env, financeP(q, p), q.metric, page(q)),
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

/** Отчёты, источник которых ещё не выпущен (Э3; 3.11 – S4-74): 200 с source_not_ready и проверкой права, а не «нет такого». */
const NOT_READY: Record<string, string> = { events: 'reports.events.view', staff: 'reports.staff.view', equipment: 'reports.equipment.view', comms: 'reports.comms.view' };

function assertKnown(report: string, ctx: AccessContext): ReportHandler | null {
  const h = Object.hasOwn(HANDLERS, report) ? HANDLERS[report] : undefined;
  if (h) return h;
  const action = Object.hasOwn(NOT_READY, report) ? NOT_READY[report] : undefined;
  if (!action) throw new AppError('REPORT_UNKNOWN', 404, 'Нет такого отчёта', { report });
  if (!roleAllows(ctx.role, action)) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });
  return null;
}

const RUNS_LIMIT = 50;

export async function reportsCrmRoutes(app: FastifyInstance, deps: ReportsCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const run = async <T>(request: FastifyRequest, reply: FastifyReply, fn: (env: ReportEnv, q: Query) => Promise<T>): Promise<T> => {
    const { access } = await deps.authenticate(request, reply);
    const q = parseQuery(request.query);
    return withReportTx(deps.reports, (tx) => fn({ tx, main: deps.pool, ctx: access, clock }, q));
  };

  // №239
  app.get('/reports/dashboard', (request, reply) =>
    run(request, reply, async (env, q) => dashboard(env, await periodParams(deps, clock, q))),
  );

  // №248: журнал ночной сверки (audit.view). Директор видит расхождения только своей зоны и без объектов сети.
  app.get('/reports/reconcile/runs', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    if (!roleAllows(access.role, 'audit.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'audit.view' });
    const cursor = parseQuery(request.query).cursor ?? null;
    if (cursor !== null && Number.isNaN(Date.parse(cursor))) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверный курсор', { field: 'cursor' });
    const runs = await deps.pool.query<{ id: string; trigger: string; scheduled_for: string | null; started_at: Date; finished_at: Date | null; status: string; checked: unknown; discrepancy_count: number; error: string | null }>(
      `SELECT id, trigger, scheduled_for::text AS scheduled_for, started_at, finished_at, status, checked, discrepancy_count, error
       FROM app.reconcile_runs WHERE ($1::timestamptz IS NULL OR started_at < $1) ORDER BY started_at DESC LIMIT $2`,
      [cursor, RUNS_LIMIT + 1],
    );
    const rows = runs.rows.slice(0, RUNS_LIMIT);
    const zone = access.network ? null : [...access.branchIds];
    const found = await deps.pool.query<{ run_id: string; check_name: string; object_type: string; object_id: string; branch_id: string | null; expected: string; actual: string; details: unknown; created_at: Date }>(
      `SELECT run_id, check_name, object_type, object_id, branch_id, expected, actual, details, created_at FROM journal.reconcile_discrepancies
       WHERE run_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[])) ORDER BY id`,
      [rows.map((r) => r.id), zone],
    );
    return {
      items: rows.map((r) => ({
        id: r.id, trigger: r.trigger, scheduledFor: r.scheduled_for, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
        status: r.status, checked: r.checked, discrepancyCount: access.network ? r.discrepancy_count : undefined, error: access.network ? r.error : undefined,
        discrepancies: found.rows.filter((d) => d.run_id === r.id).map((d) => ({
          check: d.check_name, objectType: d.object_type, objectId: d.object_id, branchId: d.branch_id, expected: Number(d.expected), actual: Number(d.actual), details: d.details, createdAt: d.created_at.toISOString(),
        })),
      })),
      nextCursor: runs.rows.length > RUNS_LIMIT ? rows[rows.length - 1]!.started_at.toISOString() : null,
    };
  });

  // №250: глобальный поиск (права типов и аудит телефонов – в search.ts)
  app.get('/search', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    return globalSearch({ pool: deps.pool, clock }, access, meta, (request.query as { q?: unknown } | undefined)?.q);
  });

  // №242
  app.get('/reports/utilization/calendar', (request, reply) => {
    const raw = (request.query ?? {}) as { unitId?: unknown; date?: unknown };
    return run(request, reply, async (env) => {
      if (!roleAllows(env.ctx.role, 'reports.ops.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'reports.ops.view' });
      return utilizationCalendar(env, { unitId: raw.unitId, date: raw.date });
    });
  });

  // №241
  app.get<{ Params: { report: string } }>('/reports/:report/detail', (request, reply) =>
    run(request, reply, async (env, q) => {
      const h = assertKnown(request.params.report, env.ctx);
      const p = await periodParams(deps, clock, q);
      if (!h) return { columns: [], rows: [], total: unavailable('source_not_ready'), nextCursor: null };
      const d = await h.detail(env, q, p);
      return { columns: d.columns ?? (d.rows[0] ? Object.keys(d.rows[0]) : []), rows: d.rows, total: d.total, nextCursor: d.nextCursor };
    }),
  );

  // №240
  app.get<{ Params: { report: string } }>('/reports/:report', (request, reply) =>
    run(request, reply, async (env, q) => {
      const h = assertKnown(request.params.report, env.ctx);
      const p = await periodParams(deps, clock, q);
      if (!h) return { metrics: { report: unavailable('source_not_ready') }, dateBasis: {}, dayRule: DAY_RULE, computedAt: clock.now().toISOString() };
      return h.metrics(env, q, p);
    }),
  );
}
