// S2-14. K17 №37–47: CRM-маршруты кассы на /api/crm/v1 – журнал операций, предпросмотр остатка, начальный остаток,
// доход, расход, изъятие, перевод между местами, сторно, исправление, справочник категорий, закрытие месяца.
// Тонкий слой (ADR 0002 п.7): разбор пути → команда cashbox/corrections/categories в транзакции под Idempotency-Key
// (ADR 0004) → ответ. Права – K1 по филиалу: вне зоны – 404 с телом несуществующего, в зоне без права – 403 и запись
// отказа в аудит отдельной транзакцией (ADR 0005 п.8). Без finance.view (Администратор) – только текущие сутки
// филиала и никаких остатков: ни в журнале, ни в ответах команд, ни в предпросмотре (06 §14).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeDenied, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import type { Tx } from '../../core/ledger.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { addDays, branchDay, parseLocalDate, systemClock, todayIn, type Clock, type LocalDate } from '../../core/time.ts';
import { getBranch } from '../network/index.ts';
import {
  financeDenialOf,
  OPERATION_SELECT,
  previewBalance,
  recordExpense,
  recordIncome,
  recordOpeningBalance,
  recordWithdrawal,
  toOperationDto,
  transferBetweenPlaces,
  type FinanceOperationDto,
  type OperationRow,
} from './cashbox.ts';
import { categoryDenialOf, createCategory, listCategories, updateCategory } from './categories.ts';
import { closeMonth, correctOperation, reverseOperation } from './corrections.ts';
import { branchSummary, networkSummary } from './summary.ts';

export interface FinanceCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type Command = (tx: Tx, ctx: AccessContext, params: Record<string, string>, body: Record<string, unknown>, meta: AuditRequestMeta, key: string, clock: Clock) => Promise<unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DAYS = 366;
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}
const objectBody = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

/** Остатки – только с finance.view на филиал (06 §14); иначе поле убирается. */
function shape(ctx: AccessContext, dto: FinanceOperationDto): FinanceOperationDto | Omit<FinanceOperationDto, 'balanceAfterKop'> {
  if (can(ctx, 'finance.view', { branchId: dto.branchId })) return dto;
  const { balanceAfterKop: _b, ...rest } = dto;
  void _b;
  return rest;
}

/** CASH_INSUFFICIENT несёт остаток места (K17 §6); без finance.view на филиал числа срезаются (06 §14, K17 §8). */
function hideBalances(err: unknown, ctx: AccessContext, branchId: string | undefined): unknown {
  if (!(err instanceof AppError) || err.code !== 'CASH_INSUFFICIENT') return err;
  if (ctx.network || (branchId !== undefined && can(ctx, 'finance.view', { branchId }))) return err;
  return new AppError(err.code, err.httpStatus, err.message, { place: err.details?.place });
}

const listSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  kind: z.enum(['opening_balance', 'income', 'expense', 'withdrawal', 'place_transfer', 'refund', 'correction', 'reversal']).optional(),
  categoryId: z.string().regex(UUID_RE).optional(),
  authorId: z.string().regex(UUID_RE).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().regex(/^\d{1,16}:\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** K17 №37: журнал кассы филиала, порядок (occurred_at, number) – стабильный при совпадении времени (06 §10). */
async function listOperations(db: Db, ctx: AccessContext, branchId: string, raw: unknown, clock: Clock) {
  const b = await getBranch(db, branchId);
  if (!b || !can(ctx, 'finance.view.day', { branchId: b.id })) throw notFound();
  const full = can(ctx, 'finance.view', { branchId: b.id });
  const q = parse(listSchema, raw);
  const today = todayIn(clock, b.timezone);
  let from: LocalDate = q.from ? parseLocalDate(q.from) : today;
  let to: LocalDate = q.to ? parseLocalDate(q.to) : from;
  if (!full) {
    if ((q.from && q.from !== today) || (q.to && q.to !== today)) throw new AppError('FORBIDDEN', 403, 'Доступны только текущие сутки', { action: 'finance.view' });
    from = today;
    to = today;
  }
  if (to < from || addDays(from, MAX_DAYS) <= to) throw new AppError('VALIDATION_FAILED', 400, `Период – от 1 до ${MAX_DAYS} дней`, { field: 'to' });
  const params: unknown[] = [b.id, branchDay(from, b.timezone).start, branchDay(to, b.timezone).end];
  let where = 'fo.branch_id = $1 AND fo.occurred_at >= $2 AND fo.occurred_at < $3';
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where += ` AND ${sql.replace('?', `$${params.length}`)}`;
  };
  if (q.kind) add('fo.kind = ?', q.kind);
  if (q.categoryId) {
    params.push(q.categoryId);
    where += ` AND (fo.category_id = $${params.length}::uuid OR fo.subcategory_id = $${params.length}::uuid)`;
  }
  if (q.authorId) add('fo.author_id = ?', q.authorId);
  if (q.q) {
    if (/^\d{1,18}$/.test(q.q)) add('fo.number = ?', q.q);
    else add(`fo.comment ILIKE ?`, `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (q.cursor) {
    const [ms, num] = q.cursor.split(':');
    params.push(new Date(Number(ms)), num);
    where += ` AND (fo.occurred_at, fo.number) > ($${params.length - 1}, $${params.length}::bigint)`;
  }
  params.push(q.limit + 1);
  const r = await db.query<OperationRow>(`${OPERATION_SELECT} WHERE ${where} ORDER BY fo.occurred_at, fo.number LIMIT $${params.length}`, params);
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => shape(ctx, toOperationDto(row))),
    nextCursor: r.rows.length > q.limit && last ? `${last.occurred_at.getTime()}:${last.number}` : null,
    from,
    to,
  };
}

export async function financeCrmRoutes(app: FastifyInstance, deps: FinanceCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  function command(operation: string, run: Command, status = 201) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const body = objectBody(request.body);
      const client = await deps.pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await runIdempotent(
          client,
          {
            scope: idempotencyScope('staff', access.actor.staffId, `finance.${operation}`),
            key,
            request: { route: `${request.method} ${request.routeOptions.url}`, params, body },
            clock,
          },
          async () => ({ status, body: await run(client, access, params, body, meta, key, clock) }),
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const d = financeDenialOf(err) ?? categoryDenialOf(err);
        if (d) await writeDenied(deps.pool, meta, { ...d, result: 'denied' }, clock);
        throw hideBalances(err, access, params.branchId);
      } finally {
        client.release();
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }

  type Cmd = typeof recordIncome;
  const branchCommand = (cmd: Cmd): Command => async (tx, ctx, p, body, meta, key, c) =>
    shape(ctx, await cmd(tx, ctx, { ...body, branchId: p.branchId }, meta, { idempotencyKey: key, clock: c }));

  // №37 журнал
  app.get('/branches/:branchId/finance/operations', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return listOperations(deps.pool, access, (request.params as { branchId: string }).branchId, request.query, clock);
  });

  // №38 предпросмотр: только с finance.view (Администратору – 403 и отказ в аудит, решение 02.11 внизу K17)
  app.post('/branches/:branchId/finance/preview', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const branchId = (request.params as { branchId: string }).branchId;
    try {
      return await previewBalance(deps.pool, access, { ...objectBody(request.body), branchId }, clock);
    } catch (err) {
      const d = financeDenialOf(err);
      if (d) await writeDenied(deps.pool, meta, { ...d, result: 'denied' }, clock);
      throw err;
    }
  });

  // №39–43 команды филиала
  app.post('/branches/:branchId/finance/opening-balance', command('opening_balance', branchCommand(recordOpeningBalance)));
  app.post('/branches/:branchId/finance/income', command('income', branchCommand(recordIncome)));
  app.post('/branches/:branchId/finance/expense', command('expense', branchCommand(recordExpense)));
  app.post('/branches/:branchId/finance/withdrawal', command('withdrawal', branchCommand(recordWithdrawal)));
  app.post('/branches/:branchId/finance/place-transfer', command('place_transfer', branchCommand(transferBetweenPlaces)));

  // №44–45 сторно и исправление
  app.post(
    '/finance/operations/:id/reverse',
    command('reverse', async (tx, ctx, p, body, meta, key, c) => shape(ctx, await reverseOperation(tx, ctx, { ...body, operationId: p.id }, meta, { idempotencyKey: key, clock: c }))),
  );
  app.post(
    '/finance/operations/:id/correct',
    command('correct', async (tx, ctx, p, body, meta, key, c) => {
      const r = await correctOperation(tx, ctx, { ...body, operationId: p.id }, meta, { idempotencyKey: key, clock: c });
      return { reversal: shape(ctx, r.reversal), replacement: shape(ctx, r.replacement) };
    }),
  );

  // №46 справочник категорий
  app.get('/finance/categories', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return listCategories(deps.pool, access, request.query);
  });
  app.post('/finance/categories', command('category.create', async (tx, ctx, _p, body, meta, _k, c) => createCategory(tx, ctx, body, meta, c)));
  app.patch('/finance/categories/:id', command('category.update', async (tx, ctx, p, body, meta, _k, c) => updateCategory(tx, ctx, p.id!, body, meta, c), 200));

  // №48 сводка кассы филиала и сети (только finance.view)
  app.get('/branches/:branchId/finance/summary', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = objectBody(request.query);
    return branchSummary(deps.pool, access, { branchId: (request.params as { branchId: string }).branchId, from: q.from, to: q.to });
  });
  app.get('/finance/summary', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = objectBody(request.query);
    return networkSummary(deps.pool, access, { from: q.from, to: q.to });
  });

  // №47 закрытие месяца
  app.post(
    '/branches/:branchId/finance/periods/:month/close',
    command('period.close', async (tx, ctx, p, _body, meta, _k, c) => closeMonth(tx, ctx, { branchId: p.branchId, month: p.month }, meta, { clock: c }), 200),
  );
}
