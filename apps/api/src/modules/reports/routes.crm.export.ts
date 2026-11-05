// S4-73. API экспорта K24 §10, K11 №243–247. Тонкий слой (ADR 0002 п.7): вход сотрудника → функции export.ts → ответ.
// Чужая задача – 404 (K1); отказ по правам пишется в аудит отдельной транзакцией (ADR 0005 п.8). Файл – только автору, attachment, no-store, nosniff: браузер не откроет его как страницу.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeDenied, type AuditAction, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { FileStore } from '../../core/files.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent, type IdempotentResult } from '../../core/idempotency.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { withTx } from '../clients/index.ts';
import { cancelExport, downloadExport, getExport, listExports, requestExport, REQUEST_ROUTE } from './export.ts';

export interface ReportsExportDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  store: FileStore;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

const CANCEL_ROUTE = 'POST /api/crm/v1/reports/exports/:id/cancel';
const uuid = z.uuid();
const LIST_QUERY = z.object({ cursor: z.string().max(400).optional() });

/** Id из пути: не UUID – как несуществующий (K1). */
function idOf(request: FastifyRequest): string {
  const id = (request.params as { id?: string }).id ?? '';
  if (!uuid.safeParse(id).success) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  return id.toLowerCase();
}

const staffIdOf = (ctx: AccessContext): string => (ctx.actor.kind === 'staff' ? ctx.actor.staffId : '');

function send(reply: FastifyReply, r: IdempotentResult) {
  if (r.replayed) reply.header('idempotent-replay', 'true');
  return reply.code(r.status).send(r.body);
}

export async function reportsExportRoutes(app: FastifyInstance, deps: ReportsExportDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  /** 403 команды → запись отказа в аудит, ответ остаётся 403. */
  const audited = async <T>(meta: AuditRequestMeta, action: AuditAction, id: string | null, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError && (err.code === 'FORBIDDEN' || err.code === 'EXPORT_FORBIDDEN')) {
        await writeDenied(deps.pool, meta, { action, object: { type: 'export', id }, reason: `${err.code}: ${String(err.details?.action ?? '')}`, result: 'denied' }, clock);
      }
      throw err;
    }
  };

  // №243
  app.post('/reports/exports', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const result = await audited(meta, 'export.requested', null, () =>
      withTx(deps.pool, (tx) =>
        runIdempotent(tx, { scope: idempotencyScope('staff', staffIdOf(access), REQUEST_ROUTE), key, request: { route: REQUEST_ROUTE, body: request.body }, clock }, async () => {
          const { job } = await requestExport(tx, access, request.body, meta, clock);
          return { status: 202, body: job };
        }),
      ),
    );
    return send(reply, result);
  });

  // №244
  app.get('/reports/exports', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = LIST_QUERY.safeParse(request.query ?? {});
    if (!q.success) throw new AppError('REPORT_FILTER_INVALID', 422, 'Неверный курсор', { field: 'cursor' });
    return listExports(deps.pool, access, { cursor: q.data.cursor });
  });

  // №245
  app.get('/reports/exports/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return getExport(deps.pool, access, idOf(request));
  });

  // №246
  app.get('/reports/exports/:id/file', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const id = idOf(request);
    const file = await audited(meta, 'export.downloaded', id, () => downloadExport({ pool: deps.pool, clock, store: deps.store }, access, id, meta));
    reply.header('Content-Type', file.mime);
    reply.header('Content-Disposition', `attachment; filename="${file.fileName}"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (file.bytes !== null) reply.header('Content-Length', String(file.bytes));
    return reply.send(file.stream);
  });

  // №247
  app.post('/reports/exports/:id/cancel', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = idOf(request);
    const result = await withTx(deps.pool, (tx) =>
      runIdempotent(tx, { scope: idempotencyScope('staff', staffIdOf(access), CANCEL_ROUTE), key, request: { route: CANCEL_ROUTE, params: { id } }, clock }, async () => ({
        status: 200,
        body: await cancelExport(tx, access, id, meta, clock),
      })),
    );
    return send(reply, result);
  });
}
