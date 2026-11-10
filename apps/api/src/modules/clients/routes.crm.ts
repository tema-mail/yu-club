// K11 №15–16: поиск и карточка клиента в CRM (/api/crm/v1/clients); №249 – обезличивание (K9, только Владелец);
// №253–254 – предпросмотр и слияние дублей (K9 «Слияние», право client.merge: Владелец по сети или делегированное право
// в его зоне – обе карточки в зоне права). Объединённая карточка – 200 с фактом объединения без ПДн. Тонкий слой (ADR 0002 п.7):
// Zod-разбор → функции модуля (index.ts) → AppError в ответ. Вход сотрудника (authenticate) передаёт server.ts.
// Телефон в списке всегда маскирован (03 §14); полный – только в карточке с правом client.view.full.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { assertCanAudited, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { ANONYMIZE_REASONS, anonymizeClient } from './anonymize.ts';
import { MERGE_REASONS, mergeClients, mergePreview } from './merge.ts';
import { CLIENT_STATUSES, getClientCard, noBranchLinks, searchClients, withTx, type ClientBranchLinks, type ClientStatus, type Pool } from './index.ts';

export interface ClientsCrmDeps {
  pool: Pool;
  clock?: Clock;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  /** Связь клиент – филиал (брони). До S1-07 – noBranchLinks. */
  links?: ClientBranchLinks;
}

const listQuery = z.object({
  q: z.string().max(100).optional(),
  branchId: z.uuid().optional(),
  status: z
    .string()
    .max(200)
    .transform((s) => s.split(',').filter((x) => x !== ''))
    .pipe(z.array(z.enum(CLIENT_STATUSES)))
    .optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const cardParams = z.object({ clientId: z.string().max(64) });
const anonymizeBody = z.object({ reason: z.enum(ANONYMIZE_REASONS) });
const previewQuery = z.object({ with: z.uuid() });
const mergeBody = z.object({ secondaryId: z.uuid(), reason: z.enum(MERGE_REASONS) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

function assertBasic(access: AccessContext): void {
  if (!roleAllows(access.role, 'client.view.basic')) {
    throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'client.view.basic' });
  }
}

export async function clientCrmRoutes(app: FastifyInstance, deps: ClientsCrmDeps): Promise<void> {
  const links = deps.links ?? noBranchLinks;

  app.get('/', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertBasic(access);
    const query = parse(listQuery, request.query);
    const status: ClientStatus[] | undefined = query.status;
    return searchClients(deps.pool, access, { text: query.q ?? '', branchId: query.branchId, status }, { cursor: query.cursor, limit: query.limit }, links);
  });

  app.get('/:clientId', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertBasic(access);
    const { clientId } = parse(cardParams, request.params);
    const card = await getClientCard(deps.pool, access, clientId, links);
    // 03 §11.2 «ссылки на старую карточку показывают факт объединения»: минимум полей, без ПДн и без блока full.
    return card.status === 'merged' ? { ...card, full: null } : card;
  });

  /** client.merge: Владелец – вся сеть; делегированное право (K1 «Делегирование») – только клиенты зоны права:
   *  контекст сужается до её филиалов, и карточка вне зоны – 404, как несуществующая. Отказ – в аудит. */
  const mergeContext = async (access: AccessContext, meta: AuditRequestMeta, clientId: string): Promise<AccessContext> => {
    if (roleAllows(access.role, 'client.merge') && access.network) return access;
    const zone = access.grants?.get('client.merge');
    if (!zone) {
      await assertCanAudited(deps.pool, meta, access, 'client.merge', { network: true }, { action: 'client.merged', object: { type: 'client', id: clientId } });
    }
    return { ...access, network: false, cityIds: new Set(), branchIds: new Set(zone!.branchIds), grants: new Map() };
  };

  // №253: обе карточки, данные модулей, конфликтующие поля (03 §11.2) – до подтверждения.
  app.get('/:clientId/merge-preview', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const { clientId } = parse(cardParams, request.params);
    const ctx = await mergeContext(access, meta, clientId);
    const q = parse(previewQuery, request.query);
    return mergePreview(deps.pool, ctx, { primaryId: clientId, secondaryId: q.with }, links, deps.clock ?? systemClock);
  });

  // №254: одна транзакция; Idempotency-Key обязателен – повтор с тем же ключом отдаёт тот же ответ без второго слияния.
  app.post('/:clientId/merge', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const { clientId } = parse(cardParams, request.params);
    const ctx = await mergeContext(access, meta, clientId);
    const body = parse(mergeBody, request.body);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const clock = deps.clock ?? systemClock;
    const result = await withTx(deps.pool, (tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('staff', access.actor.staffId, 'client.merge'), key, request: { route: 'POST /clients/:clientId/merge', params: { clientId }, body }, clock },
        async () => ({ status: 200, body: await mergeClients(tx, ctx, { primaryId: clientId, secondaryId: body.secondaryId, reason: body.reason }, meta, links, clock) }),
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });

  // №249: необратимо; право client.anonymize (только Владелец, D4-60), отказ – в аудит отдельной транзакцией.
  app.post('/:clientId/anonymize', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const { clientId } = parse(cardParams, request.params);
    await assertCanAudited(deps.pool, meta, access, 'client.anonymize', { network: true }, {
      action: 'client.status_changed',
      object: { type: 'client', id: clientId },
    });
    const body = parse(anonymizeBody, request.body);
    return withTx(deps.pool, (tx) => anonymizeClient(tx, clientId, body, meta, deps.clock ?? systemClock));
  });
}
