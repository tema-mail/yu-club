// S3-39. K19 №341–349: ремонт по HTTP на /api/crm/v1 – список, регистрация, карточка с timeline из аудита, статусы и согласование,
// блокировки, закрытие, расход, гарантии, исполнители. Тонкий слой: разбор → команда в транзакции под Idempotency-Key → ответ. Вне зоны –
// 404, в зоне без права – 403 и запись отказа (ADR 0005 п.8). Здесь же типы владельца вложений equipment и repair (K19 №350): права – у объекта.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { objectTimeline, writeDenied, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { registerAttachmentOwner } from '../../core/files.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import type { Tx } from '../../core/ledger.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { bookingRowsByIds } from '../booking/providers.ts';
import { financeDenialOf } from '../finance/cashbox.ts';
import { createExecutor, listExecutors, updateExecutor } from './executors.ts';
import { equipmentDenialOf, guard, itemRow, notFound, parseInput, UUID_RE } from './items.ts';
import { confirmBlock, proposeBlock, repairDowntime } from './repair-blocks.ts';
import { closeRepair, createWarranty, invalidateWarranty, listWarranties } from './repair-close.ts';
import { createRepairExpense, linkRepairExpense } from './repair-expense.ts';
import { approveRepair, changeRepairStatus, getRepair, listRepairs, registerRepair, repairRow, updateRepair } from './repairs.ts';

export interface RepairCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type Run = (tx: Tx, ctx: AccessContext, id: string, body: unknown, meta: AuditRequestMeta, key: string, clock: Clock) => Promise<unknown>;

const uuid = z.string().regex(UUID_RE);
const iso = z.iso.datetime({ offset: true });
const proposalQuery = z.object({
  targetType: z.enum(['unit', 'room']).optional(),
  targetId: uuid.optional(),
  start: iso.optional(),
  end: iso.optional(),
});
const executorsQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() });

/** Типы владельца вложений (K19 §9): чтение – equipment.view, запись – repair.attach (Администратор прикладывает фото, 10 §14).
 *  Списанное оборудование принимает документы: EQUIPMENT_WRITTEN_OFF запрещает всё, кроме них (K19 §15). */
export function registerEquipmentAttachmentOwners(): void {
  const denied = { action: 'attachment.added', object: { type: 'attachment', id: null } } as const;
  const check = (ctx: AccessContext, branchId: string | null, action: string) => {
    if (!branchId || !can(ctx, 'equipment.view', { branchId })) throw notFound();
    guard(ctx, branchId, action, denied);
  };
  registerAttachmentOwner('equipment', {
    canRead: async (db, ctx, id) => check(ctx, (await itemRow(db, id))?.branch_id ?? null, 'equipment.view'),
    canWrite: async (db, ctx, id) => check(ctx, (await itemRow(db, id))?.branch_id ?? null, 'repair.attach'),
  });
  registerAttachmentOwner('repair', {
    canRead: async (db, ctx, id) => check(ctx, (await repairRow(db, id))?.branch_id ?? null, 'equipment.view'),
    canWrite: async (db, ctx, id) => check(ctx, (await repairRow(db, id))?.branch_id ?? null, 'repair.attach'),
  });
}

export async function repairCrmRoutes(app: FastifyInstance, deps: RepairCrmDeps): Promise<void> {
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
        { scope: idempotencyScope('staff', access.actor.staffId, `repair.${operation}`), key, request: { route: `${request.method} ${request.routeOptions.url}`, params, body: request.body ?? null }, clock },
        async () => ({ status, body: (await run(client, access, params.id ?? '', request.body, meta, key, clock)) ?? {} }),
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof AppError) {
        const d = equipmentDenialOf(err) ?? financeDenialOf(err);
        if (d) await writeDenied(deps.pool, meta, { action: d.action, object: d.object, branchId: d.branchId, reason: d.reason, result: 'denied' }, clock);
      }
      throw err;
    } finally {
      client.release();
    }
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  };

  // №341
  app.get('/repairs', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return listRepairs(deps.pool, access, request.query, clock);
  });
  // №342
  app.post('/repairs', command('register', 201, (tx, ctx, _id, body, meta, _key, c) => registerRepair(tx, ctx, body, meta, c)));
  // №343: карточка + timeline из аудита (K2) + простой (10 §15)
  app.get('/repairs/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const id = (request.params as { id: string }).id;
    const repair = await getRepair(deps.pool, access, id);
    const timeline = await objectTimeline(deps.pool, { objectType: 'repair', objectId: id }, { limit: 100 });
    return { ...repair, downtime: await repairDowntime(deps.pool, access, id, clock), timeline: timeline.items };
  });
  app.patch('/repairs/:id', command('update', 200, (tx, ctx, id, body, meta, _key, c) => updateRepair(tx, ctx, id, body, meta, c)));
  // №344
  app.post('/repairs/:id/status', command('status', 200, (tx, ctx, id, body, meta, _key, c) => changeRepairStatus(tx, ctx, id, body, meta, c)));
  app.post('/repairs/:id/approve', command('approve', 200, (tx, ctx, id, body, meta, _key, c) => approveRepair(tx, ctx, id, body, meta, c)));
  // №345: предпросмотр ничего не пишет; ремонт без места и без цели – пустая форма, цель выбирает сотрудник
  app.get('/repairs/:id/block-proposal', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = parseInput(proposalQuery, request.query);
    const proposal = await proposeBlock(
      deps.pool,
      access,
      (request.params as { id: string }).id,
      {
        ...(q.targetType && q.targetId ? { target: { type: q.targetType, ids: [q.targetId] } } : {}),
        ...(q.start && q.end ? { period: { start: q.start, end: q.end } } : {}),
      },
      clock,
    );
    return proposal ?? { target: null, period: null, reasonCode: 'repair', affectedBookings: [], affectedEvents: [], otherOpenRepairs: [] };
  });
  app.post(
    '/repairs/:id/blocks',
    command('block', 201, async (tx, ctx, id, body, meta, _key, c) => {
      const done = await confirmBlock(tx, ctx, id, body, meta, c);
      return { blockId: done.blockId, affectedBookings: await bookingRowsByIds(tx, done.affectedBookingIds, c.now()), affectedEventIds: done.affectedEventIds, affectedHoldIds: done.affectedHoldIds };
    }),
  );
  // №346
  app.post('/repairs/:id/close', command('close', 200, (tx, ctx, id, body, meta, _key, c) => closeRepair(tx, ctx, id, body, meta, c)));
  // №347
  app.post('/repairs/:id/expense', command('expense', 201, (tx, ctx, id, body, meta, key, c) => createRepairExpense(tx, ctx, id, body, meta, { idempotencyKey: key, clock: c })));
  app.post(
    '/repairs/:id/expense/link',
    command('expense.link', 200, async (tx, ctx, id, body, meta, _key, c) => {
      await linkRepairExpense(tx, ctx, id, body, meta, c);
      return getRepair(tx, ctx, id);
    }),
  );
  // №348
  app.get('/equipment/:id/warranties', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return { items: await listWarranties(deps.pool, access, (request.params as { id: string }).id) };
  });
  app.post('/equipment/:id/warranties', command('warranty', 201, (tx, ctx, id, body, meta, _key, c) => createWarranty(tx, ctx, id, body, meta, c)));
  app.post('/warranties/:id/invalidate', command('warranty.invalidate', 200, (tx, ctx, id, body, meta, _key, c) => invalidateWarranty(tx, ctx, id, body, meta, c)));
  // №349
  app.get('/repair-executors', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = parseInput(executorsQuery, request.query);
    return { items: await listExecutors(deps.pool, access, { includeArchived: q.includeArchived === 'true' }) };
  });
  app.post('/repair-executors', command('executor.create', 201, (tx, ctx, _id, body, meta, _key, c) => createExecutor(tx, ctx, body, meta, c)));
  app.patch('/repair-executors/:id', command('executor.update', 200, (tx, ctx, id, body, meta, _key, c) => updateExecutor(tx, ctx, id, body, meta, c)));
}
