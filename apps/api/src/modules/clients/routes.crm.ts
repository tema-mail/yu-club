// K11 №15–16: поиск и карточка клиента в CRM (/api/crm/v1/clients). Тонкий слой (ADR 0002 п.7):
// Zod-разбор → функции модуля (index.ts) → AppError в ответ. Вход сотрудника (authenticate) передаёт server.ts.
// Телефон в списке всегда маскирован (03 §14); полный – только в карточке с правом client.view.full.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditRequestMeta, Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { CLIENT_STATUSES, getClientCard, noBranchLinks, searchClients, type ClientBranchLinks, type ClientStatus } from './index.ts';

export interface ClientsCrmDeps {
  pool: Db;
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
    return getClientCard(deps.pool, access, clientId, links);
  });
}
