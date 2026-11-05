// S3-20, S3-21. K18 №311–318: CRM-маршруты зарплаты на /api/crm/v1 – тонкий слой над payroll.ts, penalties.ts, payout-expense.ts, под Idempotency-Key.
// Администратору (без payroll.view) закрыто всё: 403 до чтения объекта. Вне зоны – 404, в зоне без права – 403 и запись отказа в аудит.
// ПДн зарплаты (K18 §10): журнал /payroll/audit отдаёт записи payroll.* и staff.rate_set только при payroll.view в зоне записи, записи без филиала
// (в том числе все ставки) – только Владельцу. timeline смены показывает факт любого события, а суммы и ставки без права заменяет маской.
// /audit/timeline (modules/staff) объекты зарплаты и смены не-Владельцу не отдаёт – там просачиваться нечему (проверено тестом).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeDenied, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import type { Tx } from '../../core/ledger.ts';
import { can, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { calculateStatements, closePeriod, createPeriod, getStatement, listPeriods, markPaid, postCorrection, setStatementStatus } from './payroll.ts';
import { createPayoutExpense, linkPayoutExpense } from './payout-expense.ts';
import { amendPenalty, cancelPenalty, createBonus, createPenalty, listPenalties } from './penalties.ts';
import { getShift } from './plan.ts';
import { isUuid, notFound } from './rates.ts';
import { payrollReport } from './report.ts';

export interface PayrollCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type Command = (tx: Tx, ctx: AccessContext, params: Record<string, string>, body: Record<string, unknown>, meta: AuditRequestMeta, key: string, clock: Clock) => Promise<unknown>;

const objectBody = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
const forbidden = (action: string) => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });

// ---- ПДн зарплаты

export const MONEY_MASK = 'сумма скрыта';
const MONEY_KEY = /kop$|^toPay|^accrued|^rate$|^rates$|^totals$|^parts$/i;

/** Суммы и ставки на любой глубине → маска; остальные поля как есть (K18 §10). */
export function maskMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskMoney);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, MONEY_KEY.test(k) ? MONEY_MASK : maskMoney(v)]));
}

export const isPayrollAction = (action: string): boolean => action.startsWith('payroll.') || action === 'staff.rate_set';

/** Запись аудита зарплаты: филиал – payroll.view в его зоне; без филиала – только Владелец. */
export const canReadPayrollAudit = (ctx: AccessContext, branchId: string | null): boolean => (branchId === null ? ctx.network : can(ctx, 'payroll.view', { branchId }));

interface AuditRow {
  id: string;
  occurred_at: Date;
  action: string;
  object_type: string;
  object_id: string | null;
  actor_type: string;
  actor_id: string | null;
  branch_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  result: string;
}
const AUDIT_SELECT = `SELECT id::text AS id, occurred_at, action, object_type, object_id, actor_type, actor_id, branch_id, before, after, reason, result FROM journal.audit_events`;
const toEvent = (e: AuditRow) => ({ id: e.id, at: e.occurred_at.toISOString(), action: e.action, objectType: e.object_type, objectId: e.object_id, actorType: e.actor_type, actorId: e.actor_id, branchId: e.branch_id, before: e.before, after: e.after, reason: e.reason, result: e.result });

const auditQuery = z.object({
  objectType: z.enum(['staff_rate', 'payroll_period', 'payroll_statement', 'payroll_penalty', 'shift']).optional(),
  objectId: z.string().optional(),
  cursor: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Журнал событий зарплаты: условие зоны – в SQL, не после выборки. */
async function payrollAudit(db: Db, ctx: AccessContext, raw: unknown) {
  const parsed = auditQuery.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса');
  const q = parsed.data;
  const params: unknown[] = [];
  const where = [`(action LIKE 'payroll.%' OR action = 'staff.rate_set')`];
  if (!ctx.network) {
    params.push([...ctx.branchIds]);
    where.push(`branch_id = ANY($${params.length}::uuid[])`);
  }
  if (q.objectType) {
    params.push(q.objectType);
    where.push(`object_type = $${params.length}`);
  }
  if (q.objectId) {
    if (!isUuid(q.objectId)) throw notFound();
    params.push(q.objectId);
    where.push(`object_id = $${params.length}`);
  }
  if (q.cursor) {
    params.push(q.cursor);
    where.push(`id < $${params.length}::bigint`);
  }
  params.push(q.limit);
  const r = await db.query<AuditRow>(`${AUDIT_SELECT} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`, params);
  return { items: r.rows.map(toEvent), nextCursor: r.rows.length === q.limit ? r.rows.at(-1)!.id : null };
}

/** timeline смены (K11 «Э3»): все события; суммы – только с payroll.view в зоне записи, а без филиала – Владельцу; иначе маска. */
async function shiftTimeline(db: Db, ctx: AccessContext, shiftId: string) {
  const r = await db.query<AuditRow>(`${AUDIT_SELECT} WHERE object_type = 'shift' AND object_id = $1 ORDER BY id DESC LIMIT 100`, [shiftId]);
  return {
    items: r.rows.map((e) => {
      const ev = toEvent(e);
      return canReadPayrollAudit(ctx, e.branch_id) ? ev : { ...ev, before: maskMoney(e.before), after: maskMoney(e.after) };
    }),
  };
}

// ---- маршруты

export async function payrollCrmRoutes(app: FastifyInstance, deps: PayrollCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  /** Вход в раздел: Администратору закрыто всё, что про деньги, ещё до чтения объекта. */
  const viewer = async (request: FastifyRequest, reply: FastifyReply): Promise<AccessContext> => {
    const { access } = await deps.authenticate(request, reply);
    if (!roleAllows(access.role, 'payroll.view')) throw forbidden('payroll.view');
    return access;
  };

  function command(operation: string, denied: { action: AuditAction; type: AuditObjectType }, run: Command, status = 200) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const params = request.params as Record<string, string>;
      const logDenied = (err: AppError) => writeDenied(deps.pool, meta, { action: denied.action, object: { type: denied.type, id: params.id ?? null }, reason: `FORBIDDEN: ${String(err.details?.action ?? '')}`, result: 'denied' }, clock);
      if (!roleAllows(access.role, 'payroll.view')) {
        const err = forbidden('payroll.view');
        await logDenied(err);
        throw err;
      }
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = objectBody(request.body);
      const client = await deps.pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await runIdempotent(
          client,
          {
            scope: idempotencyScope('staff', access.actor.staffId, `payroll.${operation}`),
            key,
            request: { route: `${request.method} ${request.routeOptions.url}`, params, body },
            clock,
          },
          async () => ({ status, body: await run(client, access, params, body, meta, key, clock) }),
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof AppError && err.code === 'FORBIDDEN') await logDenied(err);
        throw err;
      } finally {
        client.release();
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }
  const period = { action: 'payroll.period.closed' as AuditAction, type: 'payroll_period' as const };
  const statement = { action: 'payroll.statement.status_changed' as AuditAction, type: 'payroll_statement' as const };
  const penalty = { action: 'payroll.penalty.created' as AuditAction, type: 'payroll_penalty' as const };

  // №311
  app.get('/payroll/periods', async (request, reply) => {
    await viewer(request, reply);
    return reply.send({ items: await listPeriods(deps.pool) });
  });
  app.post('/payroll/periods', command('period.create', { action: 'payroll.period.created', type: 'payroll_period' }, async (tx, ctx, _p, body, meta, _k, c) => createPeriod(tx, ctx, body, meta, c), 201));
  app.post('/payroll/periods/:id/close', command('period.close', period, async (tx, ctx, p, body, meta, _k, c) => closePeriod(tx, ctx, p.id!, { reason: body.reason as string | null | undefined }, meta, c)));
  // №312
  app.post('/payroll/periods/:id/calculate', command('calculate', { action: 'payroll.statement.calculated', type: 'payroll_period' }, async (tx, ctx, p, _b, meta, _k, c) => calculateStatements(tx, ctx, p.id!, meta, c)));
  // Ведомости периода в зоне: для списка в CRM; без пересчёта и без записи
  app.get('/payroll/periods/:id/statements', async (request, reply) => {
    const ctx = await viewer(request, reply);
    const id = (request.params as { id: string }).id;
    if (!isUuid(id)) throw notFound();
    const rows = await deps.pool.query<{ id: string }>(`SELECT id FROM app.payroll_statements WHERE period_id = $1 ORDER BY staff_id`, [id]);
    const items = await Promise.all(rows.rows.map((r) => getStatement(deps.pool, ctx, r.id, clock).catch((err: unknown) => {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return null;
      throw err;
    })));
    return reply.send({ items: items.filter((x) => x !== null) });
  });
  // №313
  app.get('/payroll/statements/:id', async (request, reply) => {
    const ctx = await viewer(request, reply);
    return reply.send(await getStatement(deps.pool, ctx, (request.params as { id: string }).id, clock));
  });
  app.post('/payroll/statements/:id/status', command('statement.status', statement, async (tx, ctx, p, body, meta, _k, c) => setStatementStatus(tx, ctx, p.id!, body, meta, c)));
  // №314
  app.post('/payroll/statements/:id/paid', command('paid', { action: 'payroll.paid', type: 'payroll_statement' }, async (tx, ctx, p, body, meta, _k, c) => markPaid(tx, ctx, p.id!, body, meta, c)));
  // №315
  app.post(
    '/payroll/statements/:id/payout-expense',
    command('payout_expense', { action: 'payroll.payout_expense.created', type: 'payroll_statement' }, async (tx, ctx, p, body, meta, key, c) => createPayoutExpense(tx, ctx, p.id!, body, meta, { idempotencyKey: key, clock: c }), 201),
  );
  app.post(
    '/payroll/statements/:id/payout-expense/link',
    command('payout_expense.link', { action: 'payroll.payout_expense.linked', type: 'payroll_statement' }, async (tx, ctx, p, body, meta, _k, c) => linkPayoutExpense(tx, ctx, p.id!, body, meta, c), 201),
  );
  // №316: kind='bonus' в теле – премия за своим флагом и правом (K18 §8)
  app.get('/payroll/penalties', async (request, reply) => {
    const ctx = await viewer(request, reply);
    const q = request.query as { staffId?: string; periodId?: string };
    return reply.send(await listPenalties(deps.pool, ctx, { ...(q.staffId ? { staffId: q.staffId } : {}), ...(q.periodId ? { periodId: q.periodId } : {}) }));
  });
  app.post('/payroll/penalties', command('penalty.create', penalty, async (tx, ctx, _p, body, meta, _k, c) => (body.kind === 'bonus' ? createBonus(tx, ctx, body, meta, c) : createPenalty(tx, ctx, body, meta, c)), 201));
  app.post('/payroll/penalties/:id/cancel', command('penalty.cancel', { action: 'payroll.penalty.cancelled', type: 'payroll_penalty' }, async (tx, ctx, p, body, meta, _k, c) => cancelPenalty(tx, ctx, p.id!, { reason: body.reason as string | null | undefined }, meta, c)));
  app.post('/payroll/penalties/:id/amend', command('penalty.amend', { action: 'payroll.penalty.amended', type: 'payroll_penalty' }, async (tx, ctx, p, body, meta, _k, c) => amendPenalty(tx, ctx, p.id!, body, meta, c)));
  // №317
  app.post('/payroll/corrections', command('correction', { action: 'payroll.correction.posted', type: 'payroll_statement' }, async (tx, ctx, _p, body, meta, key, c) => postCorrection(tx, ctx, body, meta, { idempotencyKey: key, clock: c }), 201));

  // №318: отчёт и детализация (S3-21)
  app.get('/payroll/report', async (request, reply) => {
    const ctx = await viewer(request, reply);
    reply.header('cache-control', 'no-store');
    return reply.send(await payrollReport(deps.pool, ctx, request.query, clock));
  });

  // ПДн зарплаты: журнал и timeline смены (K18 §10)
  app.get('/payroll/audit', async (request, reply) => {
    const ctx = await viewer(request, reply);
    reply.header('cache-control', 'no-store');
    return reply.send(await payrollAudit(deps.pool, ctx, request.query));
  });
  app.get('/shifts/:id/timeline', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const dto = await getShift(deps.pool, (request.params as { id: string }).id, clock);
    if (!dto || !(dto.staffId === access.actor.staffId || can(access, 'shift.view', { branchId: dto.branchId }))) throw notFound();
    reply.header('cache-control', 'no-store');
    return reply.send(await shiftTimeline(deps.pool, access, dto.id));
  });
}
