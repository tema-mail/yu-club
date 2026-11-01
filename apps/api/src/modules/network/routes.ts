// K11 №18: сеть в CRM – города и филиалы (список с курсором, карточка, создание, изменение, статус, архив, зона).
// Тонкий слой (ADR 0002 п.7): разбор пути → команда modules/network/commands.ts в транзакции → ответ.
// Изменяющие маршруты – только с Idempotency-Key (ADR 0004); отказ по правам – в аудит отдельной транзакцией (ADR 0005 п.8).
// Модуль staff не импортируется: вход сотрудника (authenticate) передаёт server.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeDenied, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import {
  archiveBranch,
  archiveCity,
  changeBranchTimezone,
  createBranch,
  createCity,
  denialOf,
  getBranchCard,
  getCity,
  listBranches,
  listCities,
  setBranchStatus,
  updateBranch,
  updateCity,
} from './commands.ts';

export interface NetworkDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type Command = (tx: Tx, ctx: AccessContext, id: string, body: unknown, meta: AuditRequestMeta, clock: Clock) => Promise<unknown>;

export async function networkRoutes(app: FastifyInstance, deps: NetworkDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  async function viewer(request: FastifyRequest, reply: FastifyReply): Promise<AccessContext> {
    const { access } = await deps.authenticate(request, reply);
    if (!roleAllows(access.role, 'network.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав');
    return access;
  }

  /** Команда: ключ → транзакция → runIdempotent; отказ по правам после отката – writeDenied. */
  function command(operation: string, run: Command, status = 200) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const id = params.branchId ?? params.cityId ?? '';
      const client = await deps.pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await runIdempotent(
          client,
          {
            scope: idempotencyScope('staff', access.actor.staffId, `network.${operation}`),
            key,
            request: { route: `${request.method} ${request.routeOptions.url}`, params, body: request.body ?? null },
            clock,
          },
          async () => ({ status, body: await run(client, access, id, request.body, meta, clock) }),
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const d = denialOf(err);
        if (d) await writeDenied(deps.pool, meta, { ...d, result: 'denied' }, clock);
        throw err;
      } finally {
        client.release();
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }

  // ---- филиалы

  app.get('/branches', async (request, reply) => listBranches(deps.pool, await viewer(request, reply), request.query));
  app.get('/branches/:branchId', async (request, reply) =>
    getBranchCard(deps.pool, await viewer(request, reply), (request.params as { branchId: string }).branchId),
  );
  app.post('/branches', command('branch.create', (tx, ctx, _id, body, meta, c) => createBranch(tx, ctx, body, meta, c), 201));
  app.patch('/branches/:branchId', command('branch.update', updateBranch));
  app.post('/branches/:branchId/status', command('branch.status', setBranchStatus));
  app.post('/branches/:branchId/archive', command('branch.archive', archiveBranch));
  app.post('/branches/:branchId/timezone', command('branch.timezone', changeBranchTimezone));

  // ---- города

  app.get('/cities', async (request, reply) => listCities(deps.pool, await viewer(request, reply), request.query));
  app.get('/cities/:cityId', async (request, reply) =>
    getCity(deps.pool, await viewer(request, reply), (request.params as { cityId: string }).cityId),
  );
  app.post('/cities', command('city.create', (tx, ctx, _id, body, meta, c) => createCity(tx, ctx, body, meta, c), 201));
  app.patch('/cities/:cityId', command('city.update', updateCity));
  app.post('/cities/:cityId/archive', command('city.archive', archiveCity));
}
