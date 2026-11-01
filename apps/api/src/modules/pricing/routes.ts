// K11 №18: тарифы в CRM (S1-14) – список филиала, создание, изменение (имя, конец действия, включение черновика), архив.
// Тонкий слой (ADR 0002 п.7): разбор пути → команда tariff.ts в транзакции → ответ. Изменяющие – с Idempotency-Key
// (ADR 0004); отказ по правам – в аудит отдельной транзакцией (ADR 0005 п.8). Вход сотрудника передаёт server.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeDenied, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { archiveTariff, createTariff, listTariffs, tariffDenialOf, updateTariff } from './tariff.ts';

export interface PricingDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type Command = (tx: Tx, ctx: AccessContext, params: Record<string, string>, body: unknown, meta: AuditRequestMeta, clock: Clock) => Promise<unknown>;

export async function pricingRoutes(app: FastifyInstance, deps: PricingDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  function command(operation: string, run: Command, status = 200) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const client = await deps.pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await runIdempotent(
          client,
          {
            scope: idempotencyScope('staff', access.actor.staffId, `pricing.${operation}`),
            key,
            request: { route: `${request.method} ${request.routeOptions.url}`, params, body: request.body ?? null },
            clock,
          },
          async () => ({ status, body: await run(client, access, params, request.body, meta, clock) }),
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const d = tariffDenialOf(err);
        if (d) await writeDenied(deps.pool, meta, { ...d, result: 'denied' }, clock);
        throw err;
      } finally {
        client.release();
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }

  app.get('/branches/:branchId/tariffs', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    if (!roleAllows(access.role, 'schedule.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав');
    return listTariffs(deps.pool, access, (request.params as { branchId: string }).branchId, request.query);
  });
  app.post(
    '/branches/:branchId/tariffs',
    command(
      'tariff.create',
      (tx, ctx, p, body, meta, c) => createTariff(tx, ctx, { ...(body && typeof body === 'object' ? body : {}), branchId: p.branchId }, meta, c),
      201,
    ),
  );
  app.patch('/tariffs/:tariffId', command('tariff.update', (tx, ctx, p, body, meta, c) => updateTariff(tx, ctx, p.tariffId!, body, meta, c)));
  app.post('/tariffs/:tariffId/archive', command('tariff.archive', (tx, ctx, p, _body, meta, c) => archiveTariff(tx, ctx, p.tariffId!, meta, c)));
}
