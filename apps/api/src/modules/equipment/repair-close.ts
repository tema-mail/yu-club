// S3-37. K19 §7, §9: закрытие ремонта, снятие выбранных блокировок, гарантии. Снятие – только явное (16 §12): невыбранная блокировка
// остаётся (not_selected), а на единицах с другим открытым ремонтом не снимается, даже если выбрана (other_open_repair, 02 §11).
// Снятая остаётся в истории блокировок; прошлые брони не трогаются (10 §12.2). Гарантия не признаёт случай гарантийным сама (10 §10.2).
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { EQUIPMENT_STATUSES } from '../../../../../packages/contracts/src/events-e3.ts';
import { blockInfo, liftBlockFor } from '../booking/providers.ts';
import { applyEquipmentStatus, denyWith, forbidden, guard, guardRole, itemRow, lockItem, notFound, parseInput, UUID_RE, type EquipmentStatus } from './items.ts';
import {
  aboveThreshold,
  approvalThreshold,
  executorSnapshot,
  lockRepair,
  otherOpenRepairsOn,
  repairPayment,
  repairRow,
  toRepairDto,
  writeTransition,
  type RepairDto,
  type RepairRow,
} from './repairs.ts';

const uuid = z.string().regex(UUID_RE);
const iso = z.iso.datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const warrantyFields = {
  startsOn: date,
  endsOn: date,
  terms: z.string().trim().max(2000).nullish(),
  issuer: z.string().trim().max(300).nullish(),
  attachmentId: uuid.nullish(),
  comment: z.string().trim().max(2000).nullish(),
};
const closeSchema = z.strictObject({
  rowVersion: z.number().int().min(1),
  worksDone: z.string().trim().max(4000).optional(),
  completedAt: iso.optional(),
  finalEquipmentStatus: z.enum(EQUIPMENT_STATUSES).optional(),
  actualCostKop: z.number().int().min(0).max(100_000_000_000).optional(),
  noCost: z.boolean().optional(),
  costComment: z.string().trim().max(2000).optional(),
  executorId: uuid.nullish(),
  warranty: z.strictObject(warrantyFields).optional(),
  liftBlockIds: z.array(uuid).max(100).optional(),
});

export type StillBlockedReason = 'other_open_repair' | 'not_selected';
export interface StillBlocked {
  blockId: string;
  reason: StillBlockedReason;
}

export interface WarrantyDto {
  id: string;
  kind: 'manufacturer' | 'repair';
  equipmentId: string;
  repairId: string | null;
  startsOn: string;
  endsOn: string;
  terms: string | null;
  issuer: string | null;
  attachmentId: string | null;
  comment: string | null;
  status: 'active' | 'invalid';
}

const WARRANTY_COLUMNS = `id, kind, equipment_id AS "equipmentId", repair_id AS "repairId", to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn",
  terms, issuer, attachment_id AS "attachmentId", comment, status`;

/** Документ гарантии – вложение этого оборудования или его ремонта. */
async function assertWarrantyDocument(db: Db | Tx, attachmentId: string, equipmentId: string): Promise<void> {
  const r = await db.query(
    `SELECT 1 FROM app.attachments a WHERE a.id = $1 AND a.status = 'active'
       AND ((a.owner_type = 'equipment' AND a.owner_id = $2)
         OR (a.owner_type = 'repair' AND a.owner_id IN (SELECT id FROM app.repairs WHERE equipment_id = $2)))`,
    [attachmentId, equipmentId],
  );
  if (!r.rowCount) throw new AppError('VALIDATION_FAILED', 400, 'Документ гарантии не найден у этого оборудования', { field: 'attachmentId' });
}

async function insertWarranty(
  tx: Tx,
  input: { kind: WarrantyDto['kind']; equipmentId: string; repairId: string | null; branchId: string; startsOn: string; endsOn: string; terms?: string | null | undefined; issuer?: string | null | undefined; attachmentId?: string | null | undefined; comment?: string | null | undefined },
  meta: AuditRequestMeta,
  clock: Clock,
): Promise<WarrantyDto> {
  if (input.endsOn < input.startsOn) throw new AppError('VALIDATION_FAILED', 400, 'Конец гарантии раньше начала', { field: 'endsOn' });
  if (input.attachmentId) await assertWarrantyDocument(tx, input.attachmentId, input.equipmentId);
  const r = await tx.query<WarrantyDto>(
    `INSERT INTO app.equipment_warranties (kind, equipment_id, repair_id, starts_on, ends_on, terms, issuer, attachment_id, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${WARRANTY_COLUMNS}`,
    [input.kind, input.equipmentId, input.repairId, input.startsOn, input.endsOn, input.terms ?? null, input.issuer ?? null, input.attachmentId ?? null, input.comment ?? null],
  );
  const dto = r.rows[0]!;
  await writeAudit(tx, meta, { action: 'warranty.created', object: { type: 'warranty', id: dto.id }, branchId: input.branchId, after: { kind: dto.kind, equipmentId: dto.equipmentId, repairId: dto.repairId, startsOn: dto.startsOn, endsOn: dto.endsOn } }, clock);
  return dto;
}

/** Был ли ремонт: «ремонт не нужен» (диагностика → проверка) исполнителя не требует (K19 §7). */
async function workWasDone(db: Db | Tx, repairId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM journal.repair_status_history WHERE repair_id = $1 AND to_status = 'in_repair' LIMIT 1`, [repairId]);
  return r.rowCount === 1;
}

/** K19 §7 п. «Снятие блокировки»: перебор активных блокировок ремонта. Брони не трогаются, история блокировки остаётся. */
async function liftSelected(tx: Tx, ctx: AccessContext, row: RepairRow, selected: ReadonlySet<string>, meta: AuditRequestMeta, clock: Clock): Promise<StillBlocked[]> {
  const blocks = await tx.query<{ block_id: string; status: string }>(
    `SELECT b.id AS block_id, b.status FROM app.repair_blocks rb JOIN app.resource_blocks b ON b.id = rb.block_id WHERE rb.repair_id = $1 ORDER BY b.id`,
    [row.id],
  );
  const own = new Set(blocks.rows.map((b) => b.block_id));
  for (const id of selected) if (!own.has(id)) throw notFound();
  const still: StillBlocked[] = [];
  for (const b of blocks.rows) {
    if (b.status !== 'active') continue;
    if (!selected.has(b.block_id)) {
      still.push({ blockId: b.block_id, reason: 'not_selected' });
      continue;
    }
    const info = await blockInfo(tx, b.block_id);
    const others = await otherOpenRepairsOn(tx, row.branch_id, info?.unitIds ?? [], row.id);
    if (others.length > 0) {
      still.push({ blockId: b.block_id, reason: 'other_open_repair' });
      continue;
    }
    await liftBlockFor(tx, ctx, b.block_id, { comment: `Ремонт ${row.number} закрыт` }, meta, clock);
  }
  return still;
}

export async function closeRepair(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<{ repair: RepairDto; stillBlocked: StillBlocked[] }> {
  const denied = { action: 'repair.closed', object: { type: 'repair', id: UUID_RE.test(id) ? id : null } } as const;
  const row = await lockRepair(tx, id);
  if (!row) throw notFound();
  if (!can(ctx, 'equipment.view', { branchId: row.branch_id })) denyWith(notFound(), { ...denied, branchId: row.branch_id }, 'repair.close');
  const canClose = can(ctx, 'repair.close', { branchId: row.branch_id });
  if (!canClose && !can(ctx, 'repair.accept', { branchId: row.branch_id })) denyWith(forbidden('repair.close'), { ...denied, branchId: row.branch_id }, 'repair.close');
  const input = parseInput(closeSchema, raw);
  if (row.status !== 'done_pending_check') throw new AppError('REPAIR_TRANSITION_INVALID', 409, 'Закрыть можно только ремонт на проверке', { from: row.status, to: 'closed' });
  if (row.row_version !== input.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Запись изменилась – обновите форму', { current: row.row_version });

  const executorId = input.executorId === undefined ? row.executor_id : input.executorId;
  const missing: string[] = [];
  if (!input.worksDone) missing.push('worksDone');
  if (!input.completedAt) missing.push('completedAt');
  if (!input.finalEquipmentStatus) missing.push('finalEquipmentStatus');
  const noCost = input.noCost === true;
  if (noCost === (input.actualCostKop !== undefined)) missing.push('actualCostKop', 'noCost'); // ровно одно из двух
  if (noCost && !input.costComment) missing.push('costComment');
  if (input.actualCostKop === 0) missing.push('noCost'); // ноль рублей – это «без затрат» с комментарием, иначе статус оплаты навсегда unpaid
  if (!executorId && (await workWasDone(tx, row.id))) missing.push('executorId');
  if (missing.length > 0) throw new AppError('REPAIR_CLOSE_INCOMPLETE', 422, 'Для закрытия ремонта не хватает данных', { fields: missing });

  const completedAt = new Date(input.completedAt!);
  const now = clock.now();
  if (completedAt.getTime() < row.detected_at.getTime() || completedAt.getTime() > now.getTime()) throw new AppError('REPAIR_DATES_INVALID', 422, 'Дата завершения – между обнаружением и сейчас');
  // Администратор принимает только в пределах порога (K19 §7, 10 §14): считается и план – иначе «без затрат» или 1 ₽ обошли бы порог согласованного ремонта
  const decisiveKop = Math.max(input.actualCostKop ?? 0, Number(row.plan_cost_kop ?? 0));
  if (!canClose && aboveThreshold(decisiveKop, await approvalThreshold(tx, now))) denyWith(forbidden('repair.close'), { ...denied, branchId: row.branch_id }, 'repair.close');
  const finalStatus: EquipmentStatus = input.finalEquipmentStatus!;
  if (finalStatus === 'written_off' || finalStatus === 'lost') guardRole(ctx, row.branch_id, 'equipment.write_off', denied);
  const item = await lockItem(tx, row.equipment_id);
  // Выход из lost – только с equipment.write_off, закрытие ремонта его не обходит (K19 §2, §18)
  if (item?.status === 'lost' && finalStatus !== 'lost') guardRole(ctx, row.branch_id, 'equipment.write_off', denied);
  if (noCost) {
    // Касса уже списала: «без затрат» разошлось бы со связанными операциями (K19 §10, 16 §14). Строка ремонта под замком – новый расход не проскочит.
    const paid = await repairPayment(tx, row);
    if (paid.paidKop > 0) throw new AppError('REPAIR_CLOSE_INCOMPLETE', 422, 'По ремонту уже есть расход – укажите сумму', { fields: ['noCost'], operationIds: paid.operationIds });
  }

  const snapshot = executorId === null ? null : executorId !== row.executor_id ? await executorSnapshot(tx, executorId) : row.executor_snapshot;
  await tx.query(
    `UPDATE app.repairs SET works_done = $2, completed_at = $3, final_equipment_status = $4, actual_cost_kop = $5, no_cost = $6, cost_comment = $7, executor_id = $8, executor_snapshot = $9, accepted_by = $10 WHERE id = $1`,
    [id, input.worksDone, completedAt, finalStatus, input.actualCostKop ?? null, noCost, input.costComment ?? null, executorId, snapshot === null ? null : JSON.stringify(snapshot), ctx.actor.staffId],
  );
  await writeTransition(tx, ctx, row, 'closed', input.worksDone!, meta, clock);

  if (item && item.status !== finalStatus && item.status !== 'written_off') {
    await applyEquipmentStatus(tx, ctx, item, { status: finalStatus, reason: `Ремонт ${row.number} закрыт`, source: 'repair' }, meta, clock);
  }
  if (input.warranty) await insertWarranty(tx, { ...input.warranty, kind: 'repair', equipmentId: row.equipment_id, repairId: row.id, branchId: row.branch_id }, meta, clock);

  const stillBlocked = await liftSelected(tx, ctx, row, new Set(input.liftBlockIds ?? []), meta, clock);
  await writeAudit(
    tx,
    meta,
    {
      action: 'repair.closed',
      object: { type: 'repair', id },
      branchId: row.branch_id,
      after: { actualCostKop: input.actualCostKop ?? null, noCost, finalEquipmentStatus: finalStatus, completedAt: completedAt.toISOString(), executorId, stillBlocked },
      reason: input.costComment ?? null,
    },
    clock,
  );
  await publish(tx as OutboxTx, {
    type: 'repair.closed',
    aggregateType: 'repair',
    aggregateId: id,
    aggregateVersion: 'closed',
    branchId: row.branch_id,
    occurredAt: now,
    payload: { repairId: id, branchId: row.branch_id, finalEquipmentStatus: finalStatus, stillBlockedIds: stillBlocked.map((s) => s.blockId) },
  });
  return { repair: await toRepairDto(tx, (await repairRow(tx, id))!), stillBlocked };
}

// ---- гарантии (K19 §9, №348)

const warrantySchema = z.strictObject({ kind: z.enum(['manufacturer', 'repair']), repairId: uuid.nullish(), ...warrantyFields });
const invalidateSchema = z.strictObject({ reason: z.string().trim().min(1).max(2000) });

export async function listWarranties(db: Db | Tx, ctx: AccessContext, equipmentId: string): Promise<WarrantyDto[]> {
  const item = await itemRow(db, equipmentId);
  if (!item || !can(ctx, 'equipment.view', { branchId: item.branch_id })) throw notFound();
  return (await db.query<WarrantyDto>(`SELECT ${WARRANTY_COLUMNS} FROM app.equipment_warranties WHERE equipment_id = $1 ORDER BY ends_on DESC, id`, [equipmentId])).rows;
}

export async function createWarranty(tx: Tx, ctx: AccessContext, equipmentId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<WarrantyDto> {
  const item = await itemRow(tx, equipmentId);
  if (!item) throw notFound();
  guard(ctx, item.branch_id, 'repair.manage', { action: 'warranty.created', object: { type: 'warranty', id: null } });
  const input = parseInput(warrantySchema, raw);
  if ((input.kind === 'repair') !== Boolean(input.repairId)) throw new AppError('VALIDATION_FAILED', 400, 'Ремонт указывается только у гарантии на работы', { field: 'repairId' });
  if (input.repairId) {
    const r = await tx.query('SELECT 1 FROM app.repairs WHERE id = $1 AND equipment_id = $2', [input.repairId, equipmentId]);
    if (!r.rowCount) throw new AppError('VALIDATION_FAILED', 400, 'Ремонт другого оборудования', { field: 'repairId' });
  }
  return insertWarranty(tx, { ...input, equipmentId, repairId: input.repairId ?? null, branchId: item.branch_id }, meta, clock);
}

export async function invalidateWarranty(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<WarrantyDto> {
  const found = UUID_RE.test(id) ? await tx.query<WarrantyDto>(`SELECT ${WARRANTY_COLUMNS} FROM app.equipment_warranties WHERE id = $1 FOR UPDATE`, [id]) : { rows: [] };
  const cur = found.rows[0];
  const item = cur ? await itemRow(tx, cur.equipmentId) : null;
  if (!cur || !item) throw notFound();
  guard(ctx, item.branch_id, 'repair.manage', { action: 'warranty.invalidated', object: { type: 'warranty', id } });
  const input = parseInput(invalidateSchema, raw);
  const r = await tx.query<WarrantyDto>(`UPDATE app.equipment_warranties SET status = 'invalid' WHERE id = $1 RETURNING ${WARRANTY_COLUMNS}`, [id]);
  if (cur.status === 'active') await writeAudit(tx, meta, { action: 'warranty.invalidated', object: { type: 'warranty', id }, branchId: item.branch_id, before: { status: 'active' }, after: { status: 'invalid' }, reason: input.reason }, clock);
  return r.rows[0]!;
}
