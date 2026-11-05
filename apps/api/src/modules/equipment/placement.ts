// S3-31. K19 §4: размещение и перемещение (10 §4, 02 §10). Текущее место – строка без removed_at; перемещение закрывает её и
// вставляет новую в одной транзакции, карточку правкой не «перепрописать» (10 §4.2). Уход из единицы или комнаты при будущих
// бронях, удержаниях или мероприятиях – EQUIPMENT_MOVE_HAS_BOOKINGS; с подтверждением – проводится, брони не трогаются,
// список и автор – в аудит (02 §10 «решение и его автор фиксируются»). Компоненты едут с родителем, история – у каждого.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { bookingsOnUnits } from '../booking/providers.ts';
import { unitsOfTarget } from '../resources/index.ts';
import {
  assertVersion,
  buildProposal,
  criticalPeriod,
  denyWith,
  forbidden,
  insertPlacement,
  isPlaceable,
  itemRow,
  lockItem,
  notFound,
  orNullIfTargetGone,
  parseInput,
  resolvePlace,
  targetOfPlacement,
  toEquipmentDto,
  UUID_RE,
  type BlockProposal,
  type EquipmentDto,
  type ItemRow,
} from './items.ts';

const uuid = z.string().regex(UUID_RE);
const moveSchema = z.strictObject({
  rowVersion: z.number().int().min(1),
  to: z.strictObject({ branchId: uuid, roomId: uuid.nullish(), unitId: uuid.nullish() }),
  at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(2000),
  acknowledgeBookings: z.boolean().optional(),
});

/** Единицы, которые покидает строка размещения: единица или все единицы комнаты. Архивная цель занятий не держит. */
async function unitsOfPlace(db: Db | Tx, branchId: string, place: { roomId: string | null; unitId: string | null }, at: Date): Promise<string[]> {
  if (place.unitId) return [place.unitId];
  if (!place.roomId) return [];
  try {
    return await unitsOfTarget(db, branchId, { type: 'room', ids: [place.roomId] }, at);
  } catch (err) {
    if (err instanceof AppError && err.code === 'RESOURCE_LINK_INVALID') return [];
    throw err;
  }
}

/** Компоненты родителя (рекурсивно) под блокировкой, по id: порядок замков один у всех перемещений. */
async function lockComponents(tx: Tx, parentId: string): Promise<ItemRow[]> {
  const r = await tx.query<{ id: string }>(
    `WITH RECURSIVE down AS (
       SELECT id, 1 AS depth FROM app.equipment_items WHERE parent_id = $1
       UNION ALL
       SELECT i.id, down.depth + 1 FROM app.equipment_items i JOIN down ON i.parent_id = down.id WHERE down.depth < 10
     ) SELECT DISTINCT id FROM down ORDER BY id`,
    [parentId],
  );
  const out: ItemRow[] = [];
  for (const { id } of r.rows) {
    const row = await lockItem(tx, id);
    if (row) out.push(row);
  }
  return out;
}

export async function moveEquipment(
  tx: Tx,
  ctx: AccessContext,
  id: string,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ equipment: EquipmentDto; affectedBookingIds: string[]; blockProposal: BlockProposal | null }> {
  const denied = { action: 'equipment.moved', object: { type: 'equipment', id: UUID_RE.test(id) ? id : null } } as const;
  const row = await lockItem(tx, id);
  if (!row) throw notFound();
  const zone = (branchId: string) => {
    if (!can(ctx, 'equipment.view', { branchId })) denyWith(notFound(), { ...denied, branchId }, 'equipment.move');
    if (!can(ctx, 'equipment.move', { branchId })) denyWith(forbidden('equipment.move'), { ...denied, branchId }, 'equipment.move');
  };
  zone(row.branch_id);
  const input = parseInput(moveSchema, raw);
  zone(input.to.branchId); // право в зоне обоих филиалов, иначе 404 (K19 §4)
  const place = await resolvePlace(tx, input.to);
  const toPlace = place.roomId !== null || place.unitId !== null;
  if (toPlace && !isPlaceable(row.status)) throw new AppError('EQUIPMENT_NOT_PLACEABLE', 409, 'Списанное, утерянное или резервное не ставится в единицу или комнату', { status: row.status });
  if (row.status === 'written_off') throw new AppError('EQUIPMENT_WRITTEN_OFF', 409, 'Списанное оборудование не перемещается');
  assertVersion(row.row_version, input.rowVersion);

  const at = new Date(input.at);
  const now = clock.now();
  if (at.getTime() > now.getTime()) throw new AppError('VALIDATION_FAILED', 400, 'Перемещение – фактический момент, не будущий', { field: 'at' });
  if (at.getTime() < row.p_placed_at.getTime()) throw new AppError('VALIDATION_FAILED', 400, 'Момент перемещения раньше постановки на прежнее место', { field: 'at' });

  // Компонент, уже уехавший в другой филиал, с родителем не едет: иначе родитель увёз бы его из чужой зоны (K19 §4)
  const components = (await lockComponents(tx, row.id)).filter((c) => c.id !== row.id && c.branch_id === row.branch_id && c.status !== 'written_off' && c.status !== 'lost');
  const same = (r: ItemRow) => r.branch_id === input.to.branchId && r.p_room_id === place.roomId && r.p_unit_id === place.unitId;
  const moving = [row, ...components].filter((r) => !same(r));
  if (moving.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Оборудование уже на этом месте', { field: 'to' });

  // Будущие занятия – с «сейчас»: прошедшие брони решения не требуют (02 §10), даже если перемещение датировано задним числом.
  const targetUnits = new Set(place.unitId ? [place.unitId] : await unitsOfPlace(tx, input.to.branchId, place, now));
  const leftUnits = new Set<string>();
  for (const r of moving) {
    for (const u of await unitsOfPlace(tx, r.branch_id, { roomId: r.p_room_id, unitId: r.p_unit_id }, now)) if (!targetUnits.has(u)) leftUnits.add(u);
  }
  const affected = leftUnits.size > 0 ? await bookingsOnUnits(tx, [...leftUnits].sort(), now) : { bookingIds: [], holdIds: [], eventIds: [] };
  const hasAffected = affected.bookingIds.length + affected.holdIds.length + affected.eventIds.length > 0;
  if (hasAffected && !input.acknowledgeBookings) {
    throw new AppError('EQUIPMENT_MOVE_HAS_BOOKINGS', 409, 'На прежнем месте есть будущие брони или мероприятия', { bookingIds: affected.bookingIds, holdIds: affected.holdIds, eventIds: affected.eventIds });
  }

  for (const r of moving) {
    await tx.query('UPDATE app.equipment_placements SET removed_at = $2 WHERE item_id = $1 AND removed_at IS NULL', [r.id, at.getTime() < r.p_placed_at.getTime() ? r.p_placed_at : at]);
    // Компонент в резерве едет с родителем, но в единицу не встаёт (K19 §2).
    const childPlace = isPlaceable(r.status) ? place : { roomId: null, unitId: null };
    await insertPlacement(tx, { itemId: r.id, branchId: input.to.branchId, ...childPlace, at: at.getTime() < r.p_placed_at.getTime() ? r.p_placed_at : at, by: ctx.actor.staffId, reason: input.reason });
    await tx.query('UPDATE app.equipment_items SET branch_id = $2, row_version = row_version + 1 WHERE id = $1', [r.id, input.to.branchId]);
    // Действующие учётки едут с оборудованием: управляет ими зона нового филиала (K19 §5)
    if (r.branch_id !== input.to.branchId) await tx.query(`UPDATE app.equipment_accounts SET branch_id = $2 WHERE equipment_id = $1 AND status = 'active'`, [r.id, input.to.branchId]);
    await writeAudit(
      tx,
      meta,
      {
        action: 'equipment.moved',
        object: { type: 'equipment', id: r.id },
        branchId: input.to.branchId,
        before: { branchId: r.branch_id, roomId: r.p_room_id, unitId: r.p_unit_id },
        after: {
          branchId: input.to.branchId,
          ...childPlace,
          at: at.toISOString(),
          ...(r.id === row.id ? {} : { withParent: row.id }),
          acknowledged: input.acknowledgeBookings ?? false,
          affectedBookingIds: affected.bookingIds,
          affectedHoldIds: affected.holdIds,
          affectedEventIds: affected.eventIds,
        },
        reason: input.reason,
      },
      clock,
    );
  }

  const equipment = toEquipmentDto((await itemRow(tx, row.id))!);
  const freed = targetOfPlacement({ roomId: row.p_room_id, unitId: row.p_unit_id });
  const period = await criticalPeriod(tx, now);
  const blockProposal = hasAffected && freed ? await orNullIfTargetGone(() => buildProposal(tx, { branchId: row.branch_id, target: freed, period }, clock)) : null;
  return { equipment, affectedBookingIds: affected.bookingIds, blockProposal };
}

export interface PlacementHistoryRow {
  id: string;
  branchId: string;
  roomId: string | null;
  unitId: string | null;
  placedAt: string;
  removedAt: string | null;
  movedBy: string;
  reason: string;
}

/** История мест (приёмка 3–4): прежние филиалы видны тому, у кого оборудование сейчас в зоне. Новые сверху. */
export async function listPlacements(db: Db | Tx, ctx: AccessContext, id: string): Promise<PlacementHistoryRow[]> {
  const row = await itemRow(db, id);
  if (!row || !can(ctx, 'equipment.view', { branchId: row.branch_id })) throw notFound();
  const r = await db.query<{ id: string; branch_id: string; room_id: string | null; unit_id: string | null; placed_at: Date; removed_at: Date | null; moved_by: string; reason: string }>(
    `SELECT id, branch_id, room_id, unit_id, placed_at, removed_at, moved_by, reason FROM app.equipment_placements WHERE item_id = $1 ORDER BY placed_at DESC, removed_at DESC NULLS FIRST`,
    [id],
  );
  return r.rows.map((x) => ({
    id: x.id,
    branchId: x.branch_id,
    roomId: x.room_id,
    unitId: x.unit_id,
    placedAt: x.placed_at.toISOString(),
    removedAt: x.removed_at?.toISOString() ?? null,
    movedBy: x.moved_by,
    reason: x.reason,
  }));
}
