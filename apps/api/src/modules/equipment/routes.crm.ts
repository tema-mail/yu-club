// S3-33. K19 №331–337: оборудование по HTTP на /api/crm/v1 – список, карточка, статус, перемещение, история мест, учётки, категории.
// Тонкий слой (ADR 0002 п.7): разбор → команда в транзакции под Idempotency-Key (ADR 0004) → ответ. Вне зоны – 404, в зоне без
// права – 403 и запись отказа в аудит отдельной транзакцией (ADR 0005 п.8). Учётки в карточке – только с equipment.view.accounts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeDenied, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { branchScopeSql, can, roleAllows, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { EQUIPMENT_STATUSES } from '../../../../../packages/contracts/src/events-e3.ts';
import { bindAccount, listAccounts, rebindAccount } from './accounts.ts';
import {
  createCategory,
  createEquipment,
  equipmentDenialOf,
  forbidden,
  getEquipment,
  ITEM_SELECT,
  listCategories,
  parseInput,
  setEquipmentStatus,
  toEquipmentDto,
  updateCategory,
  updateEquipment,
  UUID_RE,
  type EquipmentDto,
  type ItemRow,
} from './items.ts';
import { listPlacements, moveEquipment } from './placement.ts';

export interface EquipmentCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type Run = (tx: Tx, ctx: AccessContext, id: string, body: unknown, meta: AuditRequestMeta, clock: Clock) => Promise<unknown>;

const uuid = z.string().regex(UUID_RE);
const listQuery = z.object({
  cityId: uuid.optional(),
  branchId: uuid.optional(),
  categoryId: uuid.optional(),
  status: z.enum(EQUIPMENT_STATUSES).optional(),
  roomId: uuid.optional(),
  unitId: uuid.optional(),
  serial: z.string().trim().min(1).max(200).optional(),
  warrantyExpiresBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasOpenRepair: z.enum(['true', 'false']).optional(),
  cursor: z.string().regex(/^INV-\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const accountsQuery = z.object({ equipmentId: uuid.optional(), branchId: uuid.optional() });

/** №331: порядок – inventory_number, курсор – последний номер; зона – в SQL (K1 scopeFilter). */
async function listEquipment(db: Db, ctx: AccessContext, raw: unknown): Promise<{ items: EquipmentDto[]; nextCursor: string | null }> {
  const q = parseInput(listQuery, raw);
  const params: unknown[] = [];
  const where = [branchScopeSql('i.branch_id', scopeFilter(ctx, 'equipment.view'), params)];
  const eq = (sql: string, value: unknown) => {
    if (value === undefined) return;
    params.push(value);
    where.push(`${sql} = $${params.length}`);
  };
  eq('i.branch_id', q.branchId);
  eq('i.category_id', q.categoryId);
  eq('i.status', q.status);
  eq('p.room_id', q.roomId);
  eq('p.unit_id', q.unitId);
  eq('i.serial_number', q.serial);
  if (q.cityId) {
    params.push(q.cityId);
    where.push(`i.branch_id IN (SELECT id FROM app.branches WHERE city_id = $${params.length})`);
  }
  if (q.warrantyExpiresBefore) {
    params.push(q.warrantyExpiresBefore);
    where.push(`EXISTS (SELECT 1 FROM app.equipment_warranties w WHERE w.equipment_id = i.id AND w.status = 'active' AND w.ends_on >= CURRENT_DATE AND w.ends_on < $${params.length}::date)`);
  }
  if (q.hasOpenRepair) {
    const open = `EXISTS (SELECT 1 FROM app.repairs r WHERE r.equipment_id = i.id AND r.status NOT IN ('closed','cancelled'))`;
    where.push(q.hasOpenRepair === 'true' ? open : `NOT ${open}`);
  }
  if (q.cursor) {
    params.push(q.cursor);
    where.push(`i.inventory_number > $${params.length}`);
  }
  params.push(q.limit + 1);
  const r = await db.query<ItemRow>(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.inventory_number LIMIT $${params.length}`, params);
  const page = r.rows.slice(0, q.limit);
  return { items: page.map(toEquipmentDto), nextCursor: r.rows.length > q.limit ? page[page.length - 1]!.inventory_number : null };
}

export async function equipmentCrmRoutes(app: FastifyInstance, deps: EquipmentCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  const command = (operation: string, status: number, run: Run) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const params = request.params as Record<string, string>;
    const client = await deps.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await runIdempotent(
        client,
        { scope: idempotencyScope('staff', access.actor.staffId, `equipment.${operation}`), key, request: { route: `${request.method} ${request.routeOptions.url}`, params, body: request.body ?? null }, clock },
        async () => ({ status, body: await run(client, access, params.id ?? '', request.body, meta, clock) }),
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const d = err instanceof AppError ? equipmentDenialOf(err) : undefined;
      if (d) await writeDenied(deps.pool, meta, { action: d.action, object: d.object, branchId: d.branchId, reason: d.reason, result: 'denied' }, clock);
      throw err;
    } finally {
      client.release();
    }
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  };

  // №331
  app.get('/equipment', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    if (!roleAllows(access.role, 'equipment.view')) throw forbidden('equipment.view');
    return listEquipment(deps.pool, access, request.query);
  });
  // №332
  app.post('/equipment', command('create', 201, (tx, ctx, _id, body, meta, c) => createEquipment(tx, ctx, body, meta, c)));
  app.get('/equipment/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const id = (request.params as { id: string }).id;
    const equipment = await getEquipment(deps.pool, access, id);
    // Администратор не получает учётки ни полем, ни пустым списком (Q-54): ключа нет вовсе
    if (!can(access, 'equipment.view.accounts', { branchId: equipment.placement.branchId })) return equipment;
    return { ...equipment, accounts: await listAccounts(deps.pool, access, { equipmentId: id }) };
  });
  app.patch('/equipment/:id', command('update', 200, (tx, ctx, id, body, meta, c) => updateEquipment(tx, ctx, id, body, meta, c)));
  // №333
  app.post('/equipment/:id/status', command('status', 200, (tx, ctx, id, body, meta, c) => setEquipmentStatus(tx, ctx, id, body, meta, c)));
  // №334
  app.post('/equipment/:id/move', command('move', 200, (tx, ctx, id, body, meta, c) => moveEquipment(tx, ctx, id, body, meta, c)));
  // №335
  app.get('/equipment/:id/placements', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return { items: await listPlacements(deps.pool, access, (request.params as { id: string }).id) };
  });
  // №336 (чтение – для вкладки «Учётки», право equipment.view.accounts)
  app.get('/equipment-accounts', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return { items: await listAccounts(deps.pool, access, parseInput(accountsQuery, request.query)) };
  });
  app.post('/equipment-accounts', command('account.bind', 201, (tx, ctx, _id, body, meta, c) => bindAccount(tx, ctx, body, meta, c)));
  app.post('/equipment-accounts/:id/rebind', command('account.rebind', 200, (tx, ctx, id, body, meta, c) => rebindAccount(tx, ctx, id, body, meta, c)));
  // №337
  app.get('/equipment-categories', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return { items: await listCategories(deps.pool, access) };
  });
  app.post('/equipment-categories', command('category.create', 201, (tx, ctx, _id, body, meta, c) => createCategory(tx, ctx, body, meta, c)));
  app.patch('/equipment-categories/:id', command('category.update', 200, (tx, ctx, id, body, meta, c) => updateCategory(tx, ctx, id, body, meta, c)));
}
