// S3-30. K19 §2–§3: карточка оборудования, статусы, инвентарный номер, категории.
// Статус не управляет доступностью ресурса (K19 §1): смена статуса только предлагает блокировку (BlockProposal), закрывает
// ресурс лишь блокировка K6 после подтверждения сотрудника (repair-blocks.ts). Права: вне зоны – 404 как у несуществующего,
// в зоне без права – 403 (отказ команды route-слой пишет в аудит по equipmentDenialOf, ADR 0005 п.8).
// Межмодульно – только провайдеры booking (K6 «Дополнения Э3») и публичные функции network (ADR 0002).
import { z } from 'zod';
import { writeAudit, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { interval, systemClock, type Clock, type Interval } from '../../core/time.ts';
import type { CrmBookingRow } from '../../../../../packages/contracts/src/crm/booking.ts';
import { EQUIPMENT_STATUSES } from '../../../../../packages/contracts/src/events-e3.ts';
import { bookingRowsByIds, previewBlock } from '../booking/providers.ts';
import { getBranch } from '../network/index.ts';

export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export interface PlacementDto {
  branchId: string;
  roomId: string | null;
  unitId: string | null;
  since: string;
}

export interface EquipmentDto {
  id: string;
  inventoryNumber: string;
  legacyNumber: string | null;
  name: string;
  categoryId: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  parentId: string | null;
  purchaseDate: string | null;
  purchaseCostKop: number | null;
  commissionedOn: string | null;
  status: EquipmentStatus;
  statusReason: string | null;
  placement: PlacementDto;
  openRepairsCount: number;
  warrantyUntil: string | null;
  lastRepairAt: string | null;
  comment: string | null;
  rowVersion: number;
}

/** K19 §8. Предпросмотр: ничего не пишет. Мероприятия – отдельным списком; поля события – от модуля events (см. EventSummaries). */
export interface BlockProposal {
  target: { type: 'unit' | 'room'; ids: string[] };
  period: { start: string; end: string };
  reasonCode: 'repair';
  affectedBookings: CrmBookingRow[];
  affectedEvents: EventSummary[];
  otherOpenRepairs: string[];
}

export interface EventSummary {
  eventId: string;
  number: string | null;
  status: string | null;
  start: string | null;
  end: string | null;
}
/** Карточки мероприятий для списка затронутых: таблицы ведёт модуль events (0305), equipment его не импортирует (ADR 0002) –
 *  server.ts регистрирует преобразование. До регистрации – только id, остальные поля null. */
export interface EventSummaries {
  summaries(db: Db | Tx, eventIds: string[]): Promise<EventSummary[]>;
}
let eventSummaries: EventSummaries = { summaries: async (_db, ids) => ids.map((eventId) => ({ eventId, number: null, status: null, start: null, end: null })) };
export function registerEventSummaries(s: EventSummaries): void {
  eventSummaries = s;
}

// ---- общие помощники модуля

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const notFound = (): AppError => new AppError('NOT_FOUND', 404, 'Не найдено');
export const forbidden = (action: string): AppError => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

export interface EquipmentDenial {
  action: AuditAction;
  object: { type: AuditObjectType; id: string | null };
  branchId: string | null;
  reason: string;
}
const DENIALS = new WeakMap<AppError, EquipmentDenial>();
export const equipmentDenialOf = (err: AppError): EquipmentDenial | undefined => DENIALS.get(err);

export function denyWith(err: AppError, denied: Omit<EquipmentDenial, 'reason'>, action: string): never {
  DENIALS.set(err, { ...denied, reason: `${err.code}: ${action}` });
  throw err;
}

/** Зона – equipment.view (вне зоны 404); действие – по филиалу (403). */
export function guard(ctx: AccessContext, branchId: string, action: string, denied: { action: AuditAction; object: { type: AuditObjectType; id: string | null } }): void {
  if (!can(ctx, 'equipment.view', { branchId })) denyWith(notFound(), { ...denied, branchId }, action);
  if (!can(ctx, action, { branchId })) denyWith(forbidden(action), { ...denied, branchId }, action);
}

/** Сетевое право (equipment.financial.edit, equipment.write_off, repair.approve): зона уже проверена по филиалу объекта.
 *  Роль решает матрица, а не assertCan({ network }) – цель одна, запрет отдаёт 403 (K19 §12). */
export function guardRole(ctx: AccessContext, branchId: string, action: string, denied: { action: AuditAction; object: { type: AuditObjectType; id: string | null } }): void {
  if (!roleAllows(ctx.role, action)) denyWith(forbidden(action), { ...denied, branchId }, action);
}

// ---- чтение

export interface ItemRow {
  id: string;
  inventory_number: string;
  legacy_number: string | null;
  name: string;
  category_id: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  parent_id: string | null;
  purchase_date: string | null;
  purchase_cost_kop: string | null;
  commissioned_on: string | null;
  status: EquipmentStatus;
  status_reason: string | null;
  branch_id: string;
  comment: string | null;
  row_version: number;
  p_room_id: string | null;
  p_unit_id: string | null;
  p_placed_at: Date;
}

export const ITEM_SELECT = `SELECT i.id, i.inventory_number, i.legacy_number, i.name, i.category_id, i.manufacturer, i.model, i.serial_number, i.parent_id,
    to_char(i.purchase_date, 'YYYY-MM-DD') AS purchase_date, i.purchase_cost_kop, to_char(i.commissioned_on, 'YYYY-MM-DD') AS commissioned_on,
    i.status, i.status_reason, i.branch_id, i.comment, i.row_version,
    p.room_id AS p_room_id, p.unit_id AS p_unit_id, p.placed_at AS p_placed_at
  FROM app.equipment_items i JOIN app.equipment_placements p ON p.item_id = i.id AND p.removed_at IS NULL`;

export function toEquipmentDto(r: ItemRow): EquipmentDto {
  return {
    id: r.id,
    inventoryNumber: r.inventory_number,
    legacyNumber: r.legacy_number,
    name: r.name,
    categoryId: r.category_id,
    manufacturer: r.manufacturer,
    model: r.model,
    serialNumber: r.serial_number,
    parentId: r.parent_id,
    purchaseDate: r.purchase_date,
    purchaseCostKop: r.purchase_cost_kop === null ? null : Number(r.purchase_cost_kop),
    commissionedOn: r.commissioned_on,
    status: r.status,
    statusReason: r.status_reason,
    placement: { branchId: r.branch_id, roomId: r.p_room_id, unitId: r.p_unit_id, since: r.p_placed_at.toISOString() },
    openRepairsCount: 0,
    warrantyUntil: null,
    lastRepairAt: null,
    comment: r.comment,
    rowVersion: r.row_version,
  };
}

export async function itemRow(db: Db | Tx, id: string): Promise<ItemRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** Строка карточки под блокировкой: сначала строка оборудования, потом чтение с размещением (FOR UPDATE с JOIN не нужен). */
export async function lockItem(tx: Tx, id: string): Promise<ItemRow | null> {
  if (!UUID_RE.test(id)) return null;
  await tx.query('SELECT id FROM app.equipment_items WHERE id = $1 FOR UPDATE', [id]);
  return itemRow(tx, id);
}

export function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw new AppError('VERSION_CONFLICT', 409, 'Запись изменилась – обновите форму', { current });
}

export async function getEquipment(db: Db | Tx, ctx: AccessContext, id: string): Promise<EquipmentDto> {
  const row = await itemRow(db, id);
  if (!row || !can(ctx, 'equipment.view', { branchId: row.branch_id })) throw notFound();
  return toEquipmentDto(row);
}

// ---- предложение блокировки (K19 §8)

/** Цель блокировки по размещению (K19 §1 п.3): единица → единица; комната без единицы – вся комната; иначе блокировать нечего. */
export function targetOfPlacement(p: { roomId: string | null; unitId: string | null }): BlockProposal['target'] | null {
  if (p.unitId) return { type: 'unit', ids: [p.unitId] };
  if (p.roomId) return { type: 'room', ids: [p.roomId] };
  return null;
}

export async function criticalPeriod(db: Db | Tx, from: Date): Promise<Interval> {
  const hours = (await resolveSetting(db, 'equipment.critical_block_hours', { network: true }, from)).value;
  return interval(from, new Date(from.getTime() + hours * 3_600_000));
}

export async function buildProposal(
  db: Db | Tx,
  input: { branchId: string; target: BlockProposal['target']; period: Interval; otherOpenRepairs?: string[] },
  clock: Clock = systemClock,
): Promise<BlockProposal> {
  const preview = await previewBlock(db, { branchId: input.branchId, target: input.target, period: input.period }, clock);
  return {
    target: input.target,
    period: { start: input.period.start.toISOString(), end: input.period.end.toISOString() },
    reasonCode: 'repair',
    affectedBookings: await bookingRowsByIds(db, preview.bookingIds, clock.now()),
    affectedEvents: await eventSummaries.summaries(db, preview.eventIds),
    otherOpenRepairs: input.otherOpenRepairs ?? [],
  };
}

// ---- команды карточки

const text = (max = 500) => z.string().trim().min(1).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().regex(UUID_RE);
const cost = z.number().int().min(0).max(100_000_000_000);

const createSchema = z.strictObject({
  name: text(),
  categoryId: uuid,
  branchId: uuid,
  roomId: uuid.nullish(),
  unitId: uuid.nullish(),
  manufacturer: text().nullish(),
  model: text().nullish(),
  serialNumber: text().nullish(),
  legacyNumber: text().nullish(),
  parentId: uuid.nullish(),
  purchaseDate: date.nullish(),
  purchaseCostKop: cost.nullish(),
  commissionedOn: date.nullish(),
  status: z.enum(['in_service', 'reserve']).optional(),
  comment: z.string().trim().max(2000).nullish(),
});

const updateSchema = z.strictObject({
  rowVersion: z.number().int().min(1),
  name: text().optional(),
  categoryId: uuid.optional(),
  manufacturer: text().nullable().optional(),
  model: text().nullable().optional(),
  serialNumber: text().nullable().optional(),
  legacyNumber: text().nullable().optional(),
  parentId: uuid.nullable().optional(),
  purchaseDate: date.nullable().optional(),
  purchaseCostKop: cost.nullable().optional(),
  commissionedOn: date.nullable().optional(),
  comment: z.string().trim().max(2000).nullable().optional(),
});

const statusSchema = z.strictObject({
  rowVersion: z.number().int().min(1),
  status: z.enum(EQUIPMENT_STATUSES),
  reason: z.string().trim().max(2000).optional(),
});

/** Статусы, в которых оборудование стоит в единице/комнате (K19 §2). */
const NOT_PLACEABLE: ReadonlySet<EquipmentStatus> = new Set(['reserve', 'written_off', 'lost']);
export const isPlaceable = (s: EquipmentStatus): boolean => !NOT_PLACEABLE.has(s);
/** Статусы, которые предлагают блокировку (K19 §2). */
const PROPOSES_BLOCK: ReadonlySet<EquipmentStatus> = new Set(['diagnostics', 'repair', 'awaiting_parts', 'unavailable']);
const REASON_REQUIRED: ReadonlySet<EquipmentStatus> = new Set(['written_off', 'lost', 'unavailable']);
/** Поля, которые правит только Владелец (10 §14, K19 §3): серийный, прежний номер, стоимость. */
const FINANCIAL = ['serialNumber', 'legacyNumber', 'purchaseCostKop'] as const;

async function assertCategory(db: Db | Tx, categoryId: string, current?: string): Promise<void> {
  const r = await db.query<{ status: string }>('SELECT status FROM app.equipment_categories WHERE id = $1', [categoryId]);
  if (!r.rows[0]) throw new AppError('VALIDATION_FAILED', 400, 'Неизвестная категория', { field: 'categoryId' });
  if (r.rows[0].status === 'archived' && categoryId !== current) throw new AppError('VALIDATION_FAILED', 400, 'Категория в архиве', { field: 'categoryId' });
}

/** Компонент → родитель того же филиала, глубина ≤ 3 (K19 §3), без циклов. */
async function assertParent(db: Db | Tx, parentId: string, branchId: string, selfId: string | null): Promise<void> {
  const r = await db.query<{ id: string; branch_id: string; depth: number }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, branch_id, 1 AS depth FROM app.equipment_items WHERE id = $1
       UNION ALL
       SELECT i.id, i.parent_id, i.branch_id, up.depth + 1 FROM app.equipment_items i JOIN up ON i.id = up.parent_id WHERE up.depth < 10
     ) SELECT id, branch_id, depth FROM up`,
    [parentId],
  );
  const parent = r.rows[0];
  if (!parent || parent.branch_id !== branchId) throw new AppError('VALIDATION_FAILED', 400, 'Родитель не найден в этом филиале', { field: 'parentId' });
  if (selfId && r.rows.some((x) => x.id === selfId)) throw new AppError('VALIDATION_FAILED', 400, 'Компонент не может быть родителем сам себе', { field: 'parentId' });
  const parentDepth = r.rows.length;
  let childLevels = 0;
  if (selfId) {
    const below = await db.query<{ levels: number }>(
      `WITH RECURSIVE down AS (
         SELECT id, 0 AS levels FROM app.equipment_items WHERE id = $1
         UNION ALL
         SELECT i.id, down.levels + 1 FROM app.equipment_items i JOIN down ON i.parent_id = down.id WHERE down.levels < 10
       ) SELECT max(levels) AS levels FROM down`,
      [selfId],
    );
    childLevels = below.rows[0]?.levels ?? 0;
  }
  if (parentDepth + 1 + childLevels > 3) throw new AppError('VALIDATION_FAILED', 400, 'Глубина вложенности компонентов – не больше трёх', { field: 'parentId' });
}

/** Дубль серийного номера в той же категории и модели – предупреждение, не отказ (K19 §3). */
async function duplicatesOf(db: Db | Tx, input: { serial: string | null | undefined; categoryId: string; model: string | null | undefined; selfId: string | null }): Promise<string[]> {
  if (!input.serial) return [];
  const r = await db.query<{ id: string }>(
    `SELECT id FROM app.equipment_items
      WHERE serial_number = $1 AND category_id = $2 AND model IS NOT DISTINCT FROM $3 AND ($4::uuid IS NULL OR id <> $4) ORDER BY inventory_number`,
    [input.serial, input.categoryId, input.model ?? null, input.selfId],
  );
  return r.rows.map((x) => x.id);
}

/** Единица и комната размещения: комната выводится из единицы; расхождение – ошибка. Чужой филиал отвергает составной FK (вставка). */
export async function resolvePlace(db: Db | Tx, input: { branchId: string; roomId?: string | null | undefined; unitId?: string | null | undefined }): Promise<{ roomId: string | null; unitId: string | null }> {
  const unitId = input.unitId ?? null;
  let roomId = input.roomId ?? null;
  if (unitId) {
    const u = await db.query<{ room_id: string | null }>('SELECT room_id FROM app.occupancy_units WHERE id = $1 AND branch_id = $2', [unitId, input.branchId]);
    const unitRoom = u.rows[0]?.room_id ?? null;
    if (u.rows[0] && roomId && unitRoom && unitRoom !== roomId) throw new AppError('VALIDATION_FAILED', 400, 'Единица не из этой комнаты', { field: 'unitId' });
    roomId = roomId ?? unitRoom;
  }
  return { roomId, unitId };
}

/** Строка размещения; единица или комната чужого филиала – FK 23503 → 404 (SAVEPOINT: транзакция команды остаётся живой). */
export async function insertPlacement(
  tx: Tx,
  input: { itemId: string; branchId: string; roomId: string | null; unitId: string | null; at: Date; by: string; reason: string },
): Promise<void> {
  await tx.query('SAVEPOINT equipment_placement');
  try {
    await tx.query(
      `INSERT INTO app.equipment_placements (item_id, branch_id, room_id, unit_id, placed_at, moved_by, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.itemId, input.branchId, input.roomId, input.unitId, input.at, input.by, input.reason],
    );
    await tx.query('RELEASE SAVEPOINT equipment_placement');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT equipment_placement');
    if ((err as { code?: string }).code === '23503') throw notFound();
    throw err;
  }
}

export async function createEquipment(
  tx: Tx,
  ctx: AccessContext,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<EquipmentDto & { details?: { duplicateOf: string[] } }> {
  const denied = { action: 'equipment.created', object: { type: 'equipment', id: null } } as const;
  const branchHint = (raw as { branchId?: unknown } | null)?.branchId;
  if (typeof branchHint === 'string') guard(ctx, branchHint, 'equipment.manage', denied);
  const input = parseInput(createSchema, raw);
  guard(ctx, input.branchId, 'equipment.manage', denied);
  const branch = await getBranch(tx, input.branchId);
  if (!branch) throw notFound();
  await assertCategory(tx, input.categoryId);
  if (input.parentId) await assertParent(tx, input.parentId, input.branchId, null);
  const status = input.status ?? 'in_service';
  const place = await resolvePlace(tx, input);
  if ((place.roomId || place.unitId) && !isPlaceable(status)) throw new AppError('EQUIPMENT_NOT_PLACEABLE', 409, 'В резерве оборудование не ставится в единицу или комнату', { status });
  const duplicateOf = await duplicatesOf(tx, { serial: input.serialNumber, categoryId: input.categoryId, model: input.model, selfId: null });
  const now = clock.now();
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO app.equipment_items (inventory_number, legacy_number, name, category_id, manufacturer, model, serial_number, parent_id, purchase_date,
       purchase_cost_kop, commissioned_on, status, branch_id, comment, created_by, created_at)
     VALUES ('INV-' || lpad(nextval('app.equipment_inventory_seq')::text, 6, '0'), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [input.legacyNumber ?? null, input.name, input.categoryId, input.manufacturer ?? null, input.model ?? null, input.serialNumber ?? null, input.parentId ?? null,
      input.purchaseDate ?? null, input.purchaseCostKop ?? null, input.commissionedOn ?? null, status, input.branchId, input.comment ?? null, ctx.actor.staffId, now],
  );
  const id = ins.rows[0]!.id;
  await insertPlacement(tx, { itemId: id, branchId: input.branchId, ...place, at: now, by: ctx.actor.staffId, reason: 'Постановка на учёт' });
  const row = (await itemRow(tx, id))!;
  const dto = toEquipmentDto(row);
  await writeAudit(tx, meta, { action: 'equipment.created', object: { type: 'equipment', id }, branchId: input.branchId, cityId: branch.cityId, after: { inventoryNumber: dto.inventoryNumber, name: dto.name, status, placement: place, duplicateOf } }, clock);
  return duplicateOf.length > 0 ? { ...dto, details: { duplicateOf } } : dto;
}

export async function updateEquipment(
  tx: Tx,
  ctx: AccessContext,
  id: string,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<EquipmentDto & { details?: { duplicateOf: string[] } }> {
  const denied = { action: 'equipment.updated', object: { type: 'equipment', id: UUID_RE.test(id) ? id : null } } as const;
  const row = await lockItem(tx, id);
  if (!row) throw notFound();
  guard(ctx, row.branch_id, 'equipment.manage', denied);
  const input = parseInput(updateSchema, raw);
  const before = toEquipmentDto(row);
  if (row.status === 'written_off') throw new AppError('EQUIPMENT_WRITTEN_OFF', 409, 'Списанное оборудование не изменяется');
  assertVersion(row.row_version, input.rowVersion);
  const financial = FINANCIAL.filter((k) => input[k] !== undefined && input[k] !== before[k]);
  if (financial.length > 0) guardRole(ctx, row.branch_id, 'equipment.financial.edit', denied);
  if (input.categoryId) await assertCategory(tx, input.categoryId, row.category_id);
  if (input.parentId) await assertParent(tx, input.parentId, row.branch_id, row.id);

  const next = {
    name: input.name ?? row.name,
    categoryId: input.categoryId ?? row.category_id,
    manufacturer: input.manufacturer === undefined ? row.manufacturer : input.manufacturer,
    model: input.model === undefined ? row.model : input.model,
    serialNumber: input.serialNumber === undefined ? row.serial_number : input.serialNumber,
    legacyNumber: input.legacyNumber === undefined ? row.legacy_number : input.legacyNumber,
    parentId: input.parentId === undefined ? row.parent_id : input.parentId,
    purchaseDate: input.purchaseDate === undefined ? row.purchase_date : input.purchaseDate,
    purchaseCostKop: input.purchaseCostKop === undefined ? before.purchaseCostKop : input.purchaseCostKop,
    commissionedOn: input.commissionedOn === undefined ? row.commissioned_on : input.commissionedOn,
    comment: input.comment === undefined ? row.comment : input.comment,
  };
  await tx.query(
    `UPDATE app.equipment_items SET name = $2, category_id = $3, manufacturer = $4, model = $5, serial_number = $6, legacy_number = $7, parent_id = $8,
       purchase_date = $9, purchase_cost_kop = $10, commissioned_on = $11, comment = $12, row_version = row_version + 1 WHERE id = $1`,
    [id, next.name, next.categoryId, next.manufacturer, next.model, next.serialNumber, next.legacyNumber, next.parentId, next.purchaseDate, next.purchaseCostKop, next.commissionedOn, next.comment],
  );
  const dto = toEquipmentDto((await itemRow(tx, id))!);
  const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => before[k] !== dto[k]);
  const pick = (d: EquipmentDto) => Object.fromEntries(changed.map((k) => [k, d[k]]));
  await writeAudit(tx, meta, { action: 'equipment.updated', object: { type: 'equipment', id }, branchId: row.branch_id, before: pick(before), after: pick(dto) }, clock);
  if (before.serialNumber !== dto.serialNumber) {
    await writeAudit(tx, meta, { action: 'equipment.serial_changed', object: { type: 'equipment', id }, branchId: row.branch_id, before: { serialNumber: before.serialNumber }, after: { serialNumber: dto.serialNumber } }, clock);
  }
  const duplicateOf = await duplicatesOf(tx, { serial: dto.serialNumber, categoryId: dto.categoryId, model: dto.model, selfId: id });
  return duplicateOf.length > 0 ? { ...dto, details: { duplicateOf } } : dto;
}

/** Статус без проверки прав – карточка следует за ремонтом и закрытием (K19 §2). Списанное, утерянное и резервное покидает
 *  единицу и комнату: текущая строка размещения закрывается, новая – на уровне филиала (10 §4.3). Доступность не меняется. */
export async function applyEquipmentStatus(
  tx: Tx,
  ctx: AccessContext,
  row: ItemRow,
  input: { status: EquipmentStatus; reason: string | null; source: 'manual' | 'repair' },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<ItemRow> {
  const now = clock.now();
  await tx.query('UPDATE app.equipment_items SET status = $2, status_reason = $3, row_version = row_version + 1 WHERE id = $1', [row.id, input.status, input.reason]);
  const leaves = !isPlaceable(input.status) && (row.p_room_id !== null || row.p_unit_id !== null);
  if (leaves) {
    await tx.query('UPDATE app.equipment_placements SET removed_at = $2 WHERE item_id = $1 AND removed_at IS NULL', [row.id, now < row.p_placed_at ? row.p_placed_at : now]);
    await insertPlacement(tx, { itemId: row.id, branchId: row.branch_id, roomId: null, unitId: null, at: now < row.p_placed_at ? row.p_placed_at : now, by: ctx.actor.staffId, reason: input.reason ?? `Статус ${input.status}` });
  }
  const action = input.status === 'written_off' ? 'equipment.written_off' : 'equipment.status_changed';
  await writeAudit(
    tx,
    meta,
    {
      action,
      object: { type: 'equipment', id: row.id },
      branchId: row.branch_id,
      before: { status: row.status, roomId: row.p_room_id, unitId: row.p_unit_id },
      after: { status: input.status, source: input.source, ...(leaves ? { roomId: null, unitId: null } : {}) },
      reason: input.reason,
    },
    clock,
  );
  return (await itemRow(tx, row.id))!;
}

export async function setEquipmentStatus(
  tx: Tx,
  ctx: AccessContext,
  id: string,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ equipment: EquipmentDto; blockProposal: BlockProposal | null }> {
  const denied = { action: 'equipment.status_changed', object: { type: 'equipment', id: UUID_RE.test(id) ? id : null } } as const;
  const row = await lockItem(tx, id);
  if (!row) throw notFound();
  guard(ctx, row.branch_id, 'equipment.manage', denied);
  const input = parseInput(statusSchema, raw);
  if (row.status === 'written_off') throw new AppError('EQUIPMENT_WRITTEN_OFF', 409, 'Списание – конечный статус');
  assertVersion(row.row_version, input.rowVersion);
  if (input.status === 'written_off' || row.status === 'lost') guardRole(ctx, row.branch_id, 'equipment.write_off', { ...denied, action: input.status === 'written_off' ? 'equipment.written_off' : denied.action });
  const reason = input.reason || null;
  if (!reason && (REASON_REQUIRED.has(input.status) || row.status === 'lost')) throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину смены статуса', { field: 'reason' });
  if (input.status === row.status) return { equipment: toEquipmentDto(row), blockProposal: null };
  const updated = await applyEquipmentStatus(tx, ctx, row, { status: input.status, reason, source: 'manual' }, meta, clock);
  const dto = toEquipmentDto(updated);
  const target = PROPOSES_BLOCK.has(input.status) ? targetOfPlacement(dto.placement) : null;
  const blockProposal = target ? await buildProposal(tx, { branchId: row.branch_id, target, period: await criticalPeriod(tx, clock.now()) }, clock) : null;
  return { equipment: dto, blockProposal };
}

// ---- категории (10 §3.2: архив вместо удаления)

export interface EquipmentCategoryDto {
  id: string;
  name: string;
  sortOrder: number;
  status: 'active' | 'archived';
}
const CATEGORY_SELECT = `SELECT id, name, sort_order AS "sortOrder", status FROM app.equipment_categories`;
const categoryCreate = z.strictObject({ name: text(200), sortOrder: z.number().int().min(0).max(100_000).optional() });
const categoryUpdate = z.strictObject({ name: text(200).optional(), sortOrder: z.number().int().min(0).max(100_000).optional(), status: z.enum(['active', 'archived']).optional() });
const duplicateName = () => new AppError('VALIDATION_FAILED', 400, 'Категория с таким названием уже есть', { field: 'name' });

export async function listCategories(db: Db | Tx, ctx: AccessContext): Promise<EquipmentCategoryDto[]> {
  if (!roleAllows(ctx.role, 'equipment.view')) throw forbidden('equipment.view');
  return (await db.query<EquipmentCategoryDto>(`${CATEGORY_SELECT} ORDER BY sort_order, name`)).rows;
}

export async function createCategory(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EquipmentCategoryDto> {
  if (!roleAllows(ctx.role, 'equipment.category.manage')) denyWith(forbidden('equipment.category.manage'), { action: 'equipment.category.created', object: { type: 'equipment_category', id: null }, branchId: null }, 'equipment.category.manage');
  const input = parseInput(categoryCreate, raw);
  const r = await tx.query<EquipmentCategoryDto>(
    `INSERT INTO app.equipment_categories (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING id, name, sort_order AS "sortOrder", status`,
    [input.name, input.sortOrder ?? 0],
  );
  const dto = r.rows[0];
  if (!dto) throw duplicateName();
  await writeAudit(tx, meta, { action: 'equipment.category.created', object: { type: 'equipment_category', id: dto.id }, after: dto }, clock);
  return dto;
}

export async function updateCategory(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EquipmentCategoryDto> {
  const objectId = UUID_RE.test(id) ? id : null;
  if (!roleAllows(ctx.role, 'equipment.category.manage')) denyWith(forbidden('equipment.category.manage'), { action: 'equipment.category.updated', object: { type: 'equipment_category', id: objectId }, branchId: null }, 'equipment.category.manage');
  const input = parseInput(categoryUpdate, raw);
  if (!objectId) throw notFound();
  const cur = (await tx.query<EquipmentCategoryDto>(`${CATEGORY_SELECT} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw notFound();
  const name = input.name ?? cur.name;
  if (name !== cur.name) {
    const taken = await tx.query('SELECT 1 FROM app.equipment_categories WHERE name = $1 AND id <> $2', [name, id]);
    if (taken.rowCount) throw duplicateName();
  }
  const r = await tx.query<EquipmentCategoryDto>(
    `UPDATE app.equipment_categories SET name = $2, sort_order = $3, status = $4 WHERE id = $1 RETURNING id, name, sort_order AS "sortOrder", status`,
    [id, name, input.sortOrder ?? cur.sortOrder, input.status ?? cur.status],
  );
  const dto = r.rows[0]!;
  const action = dto.status === 'archived' && cur.status !== 'archived' ? 'equipment.category.archived' : 'equipment.category.updated';
  await writeAudit(tx, meta, { action, object: { type: 'equipment_category', id }, before: cur, after: dto }, clock);
  return dto;
}
