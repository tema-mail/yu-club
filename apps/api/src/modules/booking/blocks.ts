// S1-04. K6 createBlock / assertNotBlocked, K11 №13–14: блокировки ресурсов (ремонт, ТО, закрытие; 01 §13).
// Блокировка ложится поверх броней и не трогает их: возвращает список затронутых (брони и удержания), решение по
// каждой – за сотрудником. Новые занятия на заблокированные единицы отвергает assertNotBlocked в транзакции occupy.
// Гонка «блокировка ↔ занятие» сериализуется строкой единицы: createBlock – FOR UPDATE, occupy – FOR NO KEY UPDATE
// (occupancy.ts): либо блокировка видит новую бронь в затронутых, либо занятие видит блокировку → RESOURCE_BLOCKED.
// Права: block.manage по филиалу (K1); вне зоны – NOT_FOUND, отказ – в аудит отдельной транзакцией (ADR 0005 п.8).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit, writeDenied, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { interval, systemClock, toPgRange, type Clock, type Interval } from '../../core/time.ts';
import { unitsOfTarget } from '../resources/index.ts';

export type BlockTarget = { type: 'unit' | 'resource' | 'room' | 'resources'; ids: string[] };

export interface BlockInfo {
  id: string;
  branchId: string;
  targetType: BlockTarget['type'];
  targetIds: string[];
  start: Date;
  end: Date;
  reasonId: string;
  comment: string | null;
  status: 'active' | 'lifted';
  unitIds: string[];
  rowVersion: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const DENIED = new WeakMap<AppError, { action: 'block.created' | 'block.lifted'; id: string | null; branchId: string | null; reason: string }>();

function guard(ctx: AccessContext, branchId: string, action: 'block.created' | 'block.lifted', id: string | null): void {
  const fail = (err: AppError): never => {
    DENIED.set(err, { action, id, branchId, reason: `${err.code}: block.manage` });
    throw err;
  };
  if (!can(ctx, 'schedule.view', { branchId })) fail(notFound());
  if (!can(ctx, 'block.manage', { branchId })) fail(new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'block.manage' }));
}

/** K6: пересечение с активной блокировкой на любой из единиц → RESOURCE_BLOCKED. Вызывать после захвата строк единиц. */
export async function assertNotBlocked(tx: Tx, unitIds: string[], period: Interval): Promise<void> {
  if (unitIds.length === 0) return;
  const r = await tx.query(`SELECT 1 FROM app.resource_block_units WHERE active AND unit_id = ANY($1::uuid[]) AND period && $2::tstzrange LIMIT 1`, [
    unitIds,
    toPgRange(period),
  ]);
  if (r.rowCount === 1) throw new AppError('RESOURCE_BLOCKED', 409, 'Место временно недоступно');
}

/** Активные строки занятости на единицах за период: брони и живые удержания (истёкшие на $now – не держат слот).
 *  До S1-06 (holds) affectedHoldIds – id позиций удержаний (source_id). */
async function affected(tx: Tx, unitIds: string[], period: Interval, now: Date): Promise<{ bookingIds: string[]; holdIds: string[] }> {
  const r = await tx.query<{ source_type: string; source_id: string }>(
    `SELECT DISTINCT source_type, source_id FROM app.occupancy
     WHERE active AND unit_id = ANY($1::uuid[]) AND period && $2::tstzrange
       AND (source_type = 'booking' OR (source_type = 'hold_item' AND hold_expires_at > $3))
     ORDER BY source_type, source_id`,
    [unitIds, toPgRange(period), now],
  );
  return {
    bookingIds: r.rows.filter((x) => x.source_type === 'booking').map((x) => x.source_id),
    holdIds: r.rows.filter((x) => x.source_type === 'hold_item').map((x) => x.source_id),
  };
}

const createInput = z.strictObject({
  target: z.strictObject({ type: z.enum(['unit', 'resource', 'room', 'resources']), ids: z.array(z.string().max(64)).min(1).max(100) }),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  reasonId: z.uuid(),
  comment: z.string().trim().max(2000).optional(),
});
const liftInput = z.strictObject({ rowVersion: z.number().int().min(1), comment: z.string().trim().max(2000).optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const BLOCK_SELECT = `SELECT b.id, b.branch_id AS "branchId", b.target_type AS "targetType", b.target_ids AS "targetIds",
    lower(b.period) AS start, upper(b.period) AS "end", b.reason_id AS "reasonId", b.comment, b.status,
    coalesce((SELECT array_agg(u.unit_id ORDER BY u.unit_id) FROM app.resource_block_units u WHERE u.block_id = b.id), '{}') AS "unitIds",
    b.row_version AS "rowVersion"
  FROM app.resource_blocks b`;

/** K6 createBlock. Брони не трогаются (01 §13): только список затронутых. */
export async function createBlock(
  tx: Tx,
  ctx: AccessContext,
  input: { branchId: string; target: BlockTarget; period: Interval; reasonId: string; comment?: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ blockId: string; affectedBookingIds: string[]; affectedHoldIds: string[] }> {
  if (!UUID_RE.test(input.branchId)) throw notFound();
  guard(ctx, input.branchId, 'block.created', null);
  const reason = await tx.query<{ requires_comment: boolean }>(
    `SELECT requires_comment FROM app.dict_reasons WHERE id = $1 AND domain = 'resource_block' AND archived_at IS NULL`,
    [input.reasonId],
  );
  if (!reason.rows[0]) throw new AppError('VALIDATION_FAILED', 400, 'Неизвестная причина блокировки', { field: 'reasonId' });
  if (reason.rows[0].requires_comment && !input.comment) throw new AppError('VALIDATION_FAILED', 400, 'Для этой причины нужен комментарий', { field: 'comment' });
  const unitIds = await unitsOfTarget(tx, input.branchId, input.target, input.period.start);
  // строки единиц FOR UPDATE в порядке id – против FOR NO KEY UPDATE занятия (occupancy.ts)
  await tx.query('SELECT id FROM app.occupancy_units WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [unitIds]);
  const range = toPgRange(input.period);
  const b = await tx.query<{ id: string }>(
    `INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, comment, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.branchId, input.target.type, input.target.ids, range, input.reasonId, input.comment ?? null, ctx.actor.staffId, clock.now()],
  );
  const blockId = b.rows[0]!.id;
  await tx.query(`INSERT INTO app.resource_block_units (block_id, unit_id, period) SELECT $1, u, $2 FROM unnest($3::uuid[]) u ORDER BY u`, [blockId, range, unitIds]);
  const hit = await affected(tx, unitIds, input.period, clock.now());
  await writeAudit(
    tx,
    meta,
    {
      action: 'block.created',
      object: { type: 'resource_block', id: blockId },
      branchId: input.branchId,
      after: { target: input.target, start: input.period.start, end: input.period.end, reasonId: input.reasonId, unitIds, affectedBookingIds: hit.bookingIds, affectedHoldIds: hit.holdIds },
    },
    clock,
  );
  return { blockId, affectedBookingIds: hit.bookingIds, affectedHoldIds: hit.holdIds };
}

export async function getBlock(db: Db | Tx, blockId: string): Promise<BlockInfo | null> {
  if (!UUID_RE.test(blockId)) return null;
  const r = await db.query<BlockInfo>(`${BLOCK_SELECT} WHERE b.id = $1`, [blockId]);
  return r.rows[0] ?? null;
}

/** K11 №14: снять блокировку. Повтор для уже снятой – без изменений. */
export async function liftBlock(tx: Tx, ctx: AccessContext, blockId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<BlockInfo> {
  const lock = UUID_RE.test(blockId) ? await tx.query<{ branch_id: string; status: string; row_version: number }>(
    'SELECT branch_id, status, row_version FROM app.resource_blocks WHERE id = $1 FOR UPDATE',
    [blockId],
  ) : { rows: [] };
  const cur = lock.rows[0];
  if (!cur) {
    const err = notFound();
    DENIED.set(err, { action: 'block.lifted', id: UUID_RE.test(blockId) ? blockId : null, branchId: null, reason: 'NOT_FOUND: block.manage' });
    throw err;
  }
  guard(ctx, cur.branch_id, 'block.lifted', blockId);
  const input = parse(liftInput, raw);
  if (cur.status === 'lifted') return (await getBlock(tx, blockId))!;
  if (cur.row_version !== input.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Запись изменилась – обновите форму', { current: cur.row_version });
  const now = clock.now();
  await tx.query(
    `UPDATE app.resource_blocks SET status = 'lifted', lifted_at = $2, lifted_by = $3, lift_comment = $4, row_version = row_version + 1 WHERE id = $1`,
    [blockId, now, ctx.actor.staffId, input.comment ?? null],
  );
  await tx.query('UPDATE app.resource_block_units SET active = false WHERE block_id = $1', [blockId]);
  await writeAudit(tx, meta, { action: 'block.lifted', object: { type: 'resource_block', id: blockId }, branchId: cur.branch_id, before: { status: 'active' }, after: { status: 'lifted', comment: input.comment ?? null } }, clock);
  return (await getBlock(tx, blockId))!;
}

// ---- HTTP (K11 №13–14)

export interface BlockDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

export async function blockRoutes(app: FastifyInstance, deps: BlockDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const command = (operation: string, status: number, run: (tx: Tx, ctx: AccessContext, id: string, body: unknown, meta: AuditRequestMeta) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const client = await deps.pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await runIdempotent(
          client,
          { scope: idempotencyScope('staff', access.actor.staffId, `booking.${operation}`), key, request: { route: `${request.method} ${request.routeOptions.url}`, params, body: request.body ?? null }, clock },
          async () => ({ status, body: await run(client, access, Object.values(params)[0] ?? '', request.body, meta) }),
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const d = err instanceof AppError ? DENIED.get(err) : undefined;
        if (d) await writeDenied(deps.pool, meta, { action: d.action, object: { type: 'resource_block', id: d.id }, branchId: d.branchId, reason: d.reason, result: 'denied' }, clock);
        throw err;
      } finally {
        client.release();
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };

  app.post(
    '/branches/:branchId/blocks',
    command('block.create', 201, async (tx, ctx, branchId, body, meta) => {
      const input = parse(createInput, body);
      const start = new Date(input.start);
      const end = new Date(input.end);
      if (!(start < end)) throw new AppError('VALIDATION_FAILED', 400, 'Конец блокировки раньше начала', { field: 'end' });
      const res = await createBlock(
        tx,
        ctx,
        { branchId, target: input.target, period: interval(start, end), reasonId: input.reasonId, ...(input.comment ? { comment: input.comment } : {}) },
        meta,
        clock,
      );
      // K11: affectedBookings – строки CrmBookingRow; таблицы броней нет до S1-07 – пока только id.
      return { block: await getBlock(tx, res.blockId), affectedBookingIds: res.affectedBookingIds, affectedHoldIds: res.affectedHoldIds };
    }),
  );
  app.post('/blocks/:blockId/lift', command('block.lift', 200, (tx, ctx, id, body, meta) => liftBlock(tx, ctx, id, body, meta, clock)));
}
