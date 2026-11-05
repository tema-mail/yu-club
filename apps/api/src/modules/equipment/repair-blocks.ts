// S3-36. K19 §8: ремонт → блокировка. Ресурс закрывает только блокировка K6, которую подтверждает сотрудник (10 §6.2): proposeBlock
// ничего не пишет, confirmBlock вызывает createBlockFor и связывает блокировку с ремонтом. Затронутые брони и мероприятия не отменяются
// и не переносятся (01 §13, 18 §7.4): решение – в CRM существующими командами. Единица VR1 закрывает «VR-место 1» и «комнату
// целиком», VR2 остаётся (K19 §1 п.3) – это даёт состав ресурсов K6, отдельной таблицы зависимостей нет. Простой – только по блокировкам.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { interval, systemClock, type Clock, type Interval } from '../../core/time.ts';
import { blockInfo, createBlockFor } from '../booking/providers.ts';
import { guard, notFound, parseInput, UUID_RE, type BlockProposal } from './items.ts';
import { isOpenRepair, linkRepairBlock, lockRepair, repairProposal, repairReasonId, repairRow } from './repairs.ts';

const uuid = z.string().regex(UUID_RE);
const iso = z.iso.datetime({ offset: true });
const targetSchema = z.strictObject({ type: z.enum(['unit', 'room']), ids: z.array(uuid).min(1).max(100) });
const periodSchema = z.strictObject({ start: iso, end: iso });
const confirmSchema = z.union([
  z.strictObject({ target: targetSchema, period: periodSchema, comment: z.string().trim().max(2000).optional() }),
  z.strictObject({ blockId: uuid }), // linkExisting: блокировка уже стоит вручную (Э1)
]);

function toInterval(p: { start: string; end: string }): Interval {
  const start = new Date(p.start);
  const end = new Date(p.end);
  if (!(start < end)) throw new AppError('VALIDATION_FAILED', 400, 'Конец блокировки раньше начала', { field: 'period.end' });
  return interval(start, end);
}

/** Предпросмотр: ничего не пишет. Ремонт без места и без цели – null. */
export async function proposeBlock(
  db: Db | Tx,
  ctx: AccessContext,
  repairId: string,
  raw: { target?: unknown; period?: unknown } = {},
  clock: Clock = systemClock,
): Promise<BlockProposal | null> {
  const row = await repairRow(db, repairId);
  if (!row || !can(ctx, 'equipment.view', { branchId: row.branch_id })) throw notFound();
  const target = raw.target === undefined ? undefined : parseInput(targetSchema, raw.target);
  const period = raw.period === undefined ? undefined : toInterval(parseInput(periodSchema, raw.period));
  return repairProposal(db, row, { ...(target ? { target } : {}), ...(period ? { period } : {}) }, clock);
}

export interface ConfirmedBlock {
  blockId: string;
  affectedBookingIds: string[];
  affectedHoldIds: string[];
  affectedEventIds: string[];
}

/** Подтверждение сотрудника: блокировка K6 (право block.manage есть и у Администратора, Q-56) + связь repair_blocks. Брони целы. */
export async function confirmBlock(tx: Tx, ctx: AccessContext, repairId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ConfirmedBlock> {
  const object = { type: 'repair' as const, id: UUID_RE.test(repairId) ? repairId : null };
  const row = await lockRepair(tx, repairId);
  if (!row) throw notFound();
  guard(ctx, row.branch_id, 'block.manage', { action: 'repair.block_linked', object });
  const input = parseInput(confirmSchema, raw);
  if (!isOpenRepair(row.status)) throw new AppError('REPAIR_TRANSITION_INVALID', 409, 'Закрытый или отменённый ремонт не блокирует ресурсы', { status: row.status });

  if ('blockId' in input) {
    const block = await blockInfo(tx, input.blockId);
    if (!block || block.branchId !== row.branch_id) throw notFound();
    if (block.status !== 'active') throw new AppError('VALIDATION_FAILED', 400, 'Блокировка уже снята', { field: 'blockId' });
    await linkRepairBlock(tx, ctx, row, input.blockId, { existing: true }, meta, clock);
    return { blockId: input.blockId, affectedBookingIds: [], affectedHoldIds: [], affectedEventIds: [] };
  }

  const created = await createBlockFor(
    tx,
    ctx,
    { branchId: row.branch_id, target: input.target, period: toInterval(input.period), reasonId: await repairReasonId(tx), ...(input.comment ? { comment: input.comment } : {}) },
    meta,
    clock,
  );
  await linkRepairBlock(tx, ctx, row, created.blockId, { existing: false }, meta, clock);
  return created;
}

/** Простой (10 §15): объединение [начало, min(конец, снятие, сейчас)) связанных блокировок – пересечения не считаются дважды.
 *  Ремонт без блокировки простоем не считается: блокировок нет – hasBlocks: false. */
export async function repairDowntime(db: Db | Tx, ctx: AccessContext, repairId: string, clock: Clock = systemClock): Promise<{ minutes: number; hasBlocks: boolean }> {
  const row = await repairRow(db, repairId);
  if (!row || !can(ctx, 'equipment.view', { branchId: row.branch_id })) throw notFound();
  const r = await db.query<{ blocks: number; minutes: string }>(
    `WITH spans AS (
       SELECT lower(b.period) AS s, least(upper(b.period), coalesce(b.lifted_at, 'infinity'::timestamptz), $2::timestamptz) AS e
         FROM app.repair_blocks rb JOIN app.resource_blocks b ON b.id = rb.block_id WHERE rb.repair_id = $1
     ),
     merged AS (SELECT unnest(range_agg(tstzrange(s, e, '[)'))) AS piece FROM spans WHERE s < e)
     SELECT (SELECT count(*)::int FROM spans) AS blocks,
            coalesce((SELECT sum(extract(epoch FROM upper(piece) - lower(piece))) FROM merged), 0) / 60 AS minutes`,
    [repairId, clock.now()],
  );
  const res = r.rows[0]!;
  return { minutes: Math.round(Number(res.minutes)), hasBlocks: res.blocks > 0 };
}
