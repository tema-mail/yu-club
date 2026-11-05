// S3-34. K19 §6: ремонтное событие – регистрация с тремя датами и историей повторов, правка диагностики и плана, переходы статусов
// по таблице, согласование выше порога. Статус ремонта ведёт карточку оборудования (K19 §2), но не доступность ресурса: закрыть
// ресурс может только подтверждённая блокировка (repair-blocks.ts). Денег здесь нет: оплата вычисляется из связей кассы (K17 §14).
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import { branchScopeSql, can, roleAllows, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { addDays, interval, localToInstant, parseLocalDate, parseLocalTime, systemClock, type Clock, type Interval } from '../../core/time.ts';
import { createBlockFor } from '../booking/providers.ts';
import { linksOf } from '../finance/links.ts';
import { getBranch } from '../network/index.ts';
import {
  applyEquipmentStatus,
  assertVersion,
  buildProposal,
  criticalPeriod,
  forbidden,
  guard,
  guardRole,
  lockItem,
  notFound,
  otherOpenRepairsOn,
  parseInput,
  targetOfPlacement,
  UUID_RE,
  type BlockProposal,
  type EquipmentStatus,
} from './items.ts';

export const REPAIR_STATUSES = ['new', 'diagnostics', 'awaiting_approval', 'planned', 'in_repair', 'awaiting_parts', 'done_pending_check', 'closed', 'cancelled'] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];
export type RepairPriority = 'critical' | 'high' | 'medium' | 'low';
export type RepairPaymentStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overpaid' | 'no_cost';

export interface ExecutorSnapshot {
  kind: string;
  name: string;
  staffId: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  inn: string | null;
}

export interface RepairDto {
  id: string;
  number: string;
  equipmentId: string;
  branchId: string;
  roomId: string | null;
  unitId: string | null;
  brokenAt: string | null;
  brokenAtUnknown: boolean;
  detectedAt: string;
  registeredAt: string;
  reportedBy: { staffId: string | null; name: string | null };
  symptoms: string;
  priority: RepairPriority;
  impact: 'none' | 'partial' | 'full';
  status: RepairStatus;
  diagnostics: string | null;
  cause: string | null;
  worksDone: string | null;
  partsUsed: string | null;
  conclusion: string | null;
  plan: { works: string | null; start: string | null; end: string | null; costKop: number | null; responsibleStaffId: string | null; partsNeeded: boolean; comment: string | null };
  executor: { id: string | null; snapshot: ExecutorSnapshot | null };
  approval: { required: boolean; approvedBy: string | null; approvedAt: string | null };
  actualCostKop: number | null;
  noCost: boolean;
  completedAt: string | null;
  finalEquipmentStatus: EquipmentStatus | null;
  acceptedBy: string | null;
  previousRepairId: string | null;
  blocks: Array<{ blockId: string; active: boolean; period: { start: string; end: string }; liftedAt: string | null }>;
  payment: { paidKop: number; status: RepairPaymentStatus; lastPaidAt: string | null; operationIds: string[] };
  rowVersion: number;
}

export interface RepairRow {
  id: string;
  number: string;
  equipment_id: string;
  branch_id: string;
  room_id: string | null;
  unit_id: string | null;
  broken_at: Date | null;
  broken_at_unknown: boolean;
  detected_at: Date;
  registered_at: Date;
  reported_by_staff_id: string | null;
  reported_by_name: string | null;
  symptoms: string;
  priority: RepairPriority;
  impact: RepairDto['impact'];
  status: RepairStatus;
  diagnostics: string | null;
  cause: string | null;
  works_done: string | null;
  parts_used: string | null;
  conclusion: string | null;
  plan_works: string | null;
  plan_start: string | null;
  plan_end: string | null;
  plan_cost_kop: string | null;
  plan_responsible_staff_id: string | null;
  plan_parts_needed: boolean;
  plan_comment: string | null;
  executor_id: string | null;
  executor_snapshot: ExecutorSnapshot | null;
  approval_required: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  actual_cost_kop: string | null;
  no_cost: boolean;
  cost_comment: string | null;
  completed_at: Date | null;
  final_equipment_status: EquipmentStatus | null;
  accepted_by: string | null;
  previous_repair_id: string | null;
  row_version: number;
}

const REPAIR_SELECT = `SELECT r.*, to_char(r.plan_start, 'YYYY-MM-DD') AS plan_start, to_char(r.plan_end, 'YYYY-MM-DD') AS plan_end FROM app.repairs r`;
const num = (s: string | null): number | null => (s === null ? null : Number(s));
export const OPEN_REPAIR_SQL = `status NOT IN ('closed','cancelled')`;
export const isOpenRepair = (s: RepairStatus): boolean => s !== 'closed' && s !== 'cancelled';

/** Статус оплаты вычисляется из живых связанных расходов (K19 §10): сторно кассы исключает операцию, отдельных полей нет. */
export async function repairPayment(db: Db | Tx, row: Pick<RepairRow, 'id' | 'no_cost' | 'actual_cost_kop' | 'plan_cost_kop'>): Promise<RepairDto['payment']> {
  const links = (await linksOf(db, { type: 'repair', id: row.id })).filter((l) => l.role === 'expense');
  const paidKop = links.reduce((sum, l) => sum + l.operation.amountKop, 0);
  const lastPaidAt = links.map((l) => l.operation.occurredAt).sort().at(-1) ?? null;
  const target = num(row.actual_cost_kop) ?? num(row.plan_cost_kop);
  let status: RepairPaymentStatus;
  if (row.no_cost) status = 'no_cost';
  else if (paidKop === 0) status = 'unpaid';
  else if (target === null || paidKop === target) status = 'paid';
  else status = paidKop < target ? 'partially_paid' : 'overpaid';
  return { paidKop, status, lastPaidAt, operationIds: links.map((l) => l.operation.id) };
}

export async function toRepairDto(db: Db | Tx, r: RepairRow): Promise<RepairDto> {
  const blocks = await db.query<{ block_id: string; status: string; s: Date; e: Date; lifted_at: Date | null }>(
    `SELECT b.id AS block_id, b.status, lower(b.period) AS s, upper(b.period) AS e, b.lifted_at
       FROM app.repair_blocks rb JOIN app.resource_blocks b ON b.id = rb.block_id WHERE rb.repair_id = $1 ORDER BY rb.linked_at, b.id`,
    [r.id],
  );
  return {
    id: r.id,
    number: r.number,
    equipmentId: r.equipment_id,
    branchId: r.branch_id,
    roomId: r.room_id,
    unitId: r.unit_id,
    brokenAt: r.broken_at?.toISOString() ?? null,
    brokenAtUnknown: r.broken_at_unknown,
    detectedAt: r.detected_at.toISOString(),
    registeredAt: r.registered_at.toISOString(),
    reportedBy: { staffId: r.reported_by_staff_id, name: r.reported_by_name },
    symptoms: r.symptoms,
    priority: r.priority,
    impact: r.impact,
    status: r.status,
    diagnostics: r.diagnostics,
    cause: r.cause,
    worksDone: r.works_done,
    partsUsed: r.parts_used,
    conclusion: r.conclusion,
    plan: { works: r.plan_works, start: r.plan_start, end: r.plan_end, costKop: num(r.plan_cost_kop), responsibleStaffId: r.plan_responsible_staff_id, partsNeeded: r.plan_parts_needed, comment: r.plan_comment },
    executor: { id: r.executor_id, snapshot: r.executor_snapshot },
    approval: { required: r.approval_required, approvedBy: r.approved_by, approvedAt: r.approved_at?.toISOString() ?? null },
    actualCostKop: num(r.actual_cost_kop),
    noCost: r.no_cost,
    completedAt: r.completed_at?.toISOString() ?? null,
    finalEquipmentStatus: r.final_equipment_status,
    acceptedBy: r.accepted_by,
    previousRepairId: r.previous_repair_id,
    blocks: blocks.rows.map((b) => ({ blockId: b.block_id, active: b.status === 'active', period: { start: b.s.toISOString(), end: b.e.toISOString() }, liftedAt: b.lifted_at?.toISOString() ?? null })),
    payment: await repairPayment(db, r),
    rowVersion: r.row_version,
  };
}

export async function repairRow(db: Db | Tx, id: string): Promise<RepairRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<RepairRow>(`${REPAIR_SELECT} WHERE r.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** Порядок замков у всех команд ремонта: ремонт → оборудование → единицы (createBlock). */
export async function lockRepair(tx: Tx, id: string): Promise<RepairRow | null> {
  if (!UUID_RE.test(id)) return null;
  await tx.query('SELECT id FROM app.repairs WHERE id = $1 FOR UPDATE', [id]);
  return repairRow(tx, id);
}

export async function getRepair(db: Db | Tx, ctx: AccessContext, id: string): Promise<RepairDto> {
  const row = await repairRow(db, id);
  if (!row || !can(ctx, 'equipment.view', { branchId: row.branch_id })) throw notFound();
  return toRepairDto(db, row);
}

const repairObject = (id: string) => ({ type: 'repair' as const, id: UUID_RE.test(id) ? id : null });

// ---- предложение блокировки по ремонту (K19 §8)

export { otherOpenRepairsOn };

/** Период по умолчанию (K19 §8): от обнаружения (при повторной блокировке – от «сейчас») до конца плана + 1 день, иначе – критические часы. */
export async function defaultRepairPeriod(db: Db | Tx, row: RepairRow, clock: Clock): Promise<Interval> {
  const now = clock.now();
  const linked = await db.query('SELECT 1 FROM app.repair_blocks WHERE repair_id = $1 LIMIT 1', [row.id]);
  const start = linked.rowCount ? now : row.detected_at;
  if (row.plan_end) {
    const branch = await getBranch(db, row.branch_id);
    if (branch) {
      const end = localToInstant(addDays(parseLocalDate(row.plan_end), 1), parseLocalTime('00:00'), branch.timezone);
      if (end.getTime() > start.getTime() && end.getTime() > now.getTime()) return interval(start, end);
    }
  }
  const critical = await criticalPeriod(db, now);
  return interval(start, critical.end);
}

export async function repairProposal(db: Db | Tx, row: RepairRow, input: { target?: BlockProposal['target']; period?: Interval }, clock: Clock): Promise<BlockProposal | null> {
  const target = input.target ?? targetOfPlacement({ roomId: row.room_id, unitId: row.unit_id });
  if (!target) return null;
  const period = input.period ?? (await defaultRepairPeriod(db, row, clock));
  return buildProposal(db, { branchId: row.branch_id, target, period, exceptRepairId: row.id }, clock);
}

/** Причина блокировки «Ремонт» из справочника (0010). */
export async function repairReasonId(db: Db | Tx): Promise<string> {
  const r = await db.query<{ id: string }>(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`);
  if (!r.rows[0]) throw new Error('Нет причины блокировки repair в dict_reasons');
  return r.rows[0].id;
}

/** Связь блокировки с ремонтом (K19 §8): block_id UNIQUE; повтор для того же ремонта – без изменений, чужая – отказ. */
export async function linkRepairBlock(tx: Tx, ctx: AccessContext, row: RepairRow, blockId: string, opts: { existing: boolean; auto?: boolean }, meta: AuditRequestMeta, clock: Clock): Promise<void> {
  const r = await tx.query(
    `INSERT INTO app.repair_blocks (repair_id, block_id, linked_at, linked_by) VALUES ($1, $2, $3, $4) ON CONFLICT (block_id) DO NOTHING RETURNING block_id`,
    [row.id, blockId, clock.now(), ctx.actor.staffId],
  );
  if (!r.rowCount) {
    const owner = await tx.query<{ repair_id: string }>('SELECT repair_id FROM app.repair_blocks WHERE block_id = $1', [blockId]);
    if (owner.rows[0]?.repair_id === row.id) return;
    throw new AppError('VALIDATION_FAILED', 400, 'Блокировка уже связана с другим ремонтом', { field: 'blockId', repairId: owner.rows[0]?.repair_id });
  }
  await writeAudit(tx, meta, { action: 'repair.block_linked', object: { type: 'repair', id: row.id }, branchId: row.branch_id, after: { blockId, existing: opts.existing, auto: opts.auto ?? false } }, clock);
}

// ---- регистрация

const uuid = z.string().regex(UUID_RE);
const iso = z.iso.datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const longText = z.string().trim().max(4000);
const PRIORITY = z.enum(['critical', 'high', 'medium', 'low']);

const registerSchema = z.strictObject({
  equipmentId: uuid,
  detectedAt: iso,
  brokenAt: iso.nullish(),
  brokenAtUnknown: z.boolean().optional(),
  symptoms: z.string().trim().min(1).max(4000),
  priority: PRIORITY,
  impact: z.enum(['none', 'partial', 'full']),
  reportedByName: z.string().trim().max(200).nullish(),
  previousRepairId: uuid.nullish(),
});

export interface RepairHistoryEntry {
  id: string;
  number: string;
  status: RepairStatus;
  detectedAt: string;
  completedAt: string | null;
  cause: string | null;
}
export interface WarrantyBrief {
  id: string;
  kind: 'manufacturer' | 'repair';
  repairId: string | null;
  startsOn: string;
  endsOn: string;
  issuer: string | null;
}

/** 10 §10.2: прошлые ремонты и действующие гарантии показываются сотруднику; гарантийным случаем система ничего не признаёт. */
export async function repairHistory(db: Db | Tx, equipmentId: string, exceptId: string | null, today: string): Promise<{ history: RepairHistoryEntry[]; warranties: WarrantyBrief[] }> {
  const h = await db.query<{ id: string; number: string; status: RepairStatus; detected_at: Date; completed_at: Date | null; cause: string | null }>(
    `SELECT id, number, status, detected_at, completed_at, cause FROM app.repairs WHERE equipment_id = $1 AND ($2::uuid IS NULL OR id <> $2) ORDER BY detected_at DESC, number DESC LIMIT 50`,
    [equipmentId, exceptId],
  );
  const w = await db.query<{ id: string; kind: WarrantyBrief['kind']; repair_id: string | null; starts_on: string; ends_on: string; issuer: string | null }>(
    `SELECT id, kind, repair_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, issuer
       FROM app.equipment_warranties WHERE equipment_id = $1 AND status = 'active' AND ends_on >= $2::date ORDER BY ends_on DESC, id`,
    [equipmentId, today],
  );
  return {
    history: h.rows.map((x) => ({ id: x.id, number: x.number, status: x.status, detectedAt: x.detected_at.toISOString(), completedAt: x.completed_at?.toISOString() ?? null, cause: x.cause })),
    warranties: w.rows.map((x) => ({ id: x.id, kind: x.kind, repairId: x.repair_id, startsOn: x.starts_on, endsOn: x.ends_on, issuer: x.issuer })),
  };
}

/** K19 §6, §8. Регистрация только предлагает блокировку (10 §6.2). */
export async function registerRepair(
  tx: Tx,
  ctx: AccessContext,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{
  repair: RepairDto;
  blockProposal: BlockProposal | null;
  autoBlock: { blockId: string; affectedBookingIds: string[]; affectedEventIds: string[] } | null;
  details: { history: RepairHistoryEntry[]; warranties: WarrantyBrief[] };
}> {
  const denied = { action: 'repair.registered', object: { type: 'repair', id: null } } as const;
  const equipmentHint = (raw as { equipmentId?: unknown } | null)?.equipmentId;
  if (typeof equipmentHint === 'string') {
    const hint = await lockItem(tx, equipmentHint);
    if (hint) guard(ctx, hint.branch_id, 'repair.register', denied);
  }
  const input = parseInput(registerSchema, raw);
  const item = await lockItem(tx, input.equipmentId);
  if (!item) throw notFound();
  guard(ctx, item.branch_id, 'repair.register', denied);
  if (item.status === 'written_off') throw new AppError('EQUIPMENT_WRITTEN_OFF', 409, 'Списанное оборудование не ремонтируется');

  const now = clock.now();
  const detectedAt = new Date(input.detectedAt);
  const brokenAt = input.brokenAt ? new Date(input.brokenAt) : null;
  const unknown = input.brokenAtUnknown ?? false;
  const datesInvalid = (message: string): never => {
    throw new AppError('REPAIR_DATES_INVALID', 422, message);
  };
  if (!brokenAt && !unknown) datesInvalid('Укажите дату поломки или отметьте, что она неизвестна');
  if (brokenAt && unknown) datesInvalid('Дата поломки указана, а отметка «неизвестна» стоит');
  if (brokenAt && brokenAt.getTime() > detectedAt.getTime()) datesInvalid('Поломка не может быть позже обнаружения');
  if (detectedAt.getTime() > now.getTime()) datesInvalid('Обнаружение не может быть позже регистрации');

  if (input.previousRepairId) {
    const prev = await tx.query('SELECT 1 FROM app.repairs WHERE id = $1 AND equipment_id = $2', [input.previousRepairId, item.id]);
    if (!prev.rowCount) throw new AppError('VALIDATION_FAILED', 400, 'Прошлый ремонт – другого оборудования', { field: 'previousRepairId' });
  }

  const ins = await tx.query<{ id: string }>(
    `INSERT INTO app.repairs (number, equipment_id, branch_id, room_id, unit_id, broken_at, broken_at_unknown, detected_at, registered_at, reported_by_staff_id,
        reported_by_name, symptoms, priority, impact, previous_repair_id, created_by)
     VALUES ('R-' || lpad(nextval('app.repair_number_seq')::text, 6, '0'), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [item.id, item.branch_id, item.p_room_id, item.p_unit_id, brokenAt, unknown, detectedAt, now, ctx.actor.staffId, input.reportedByName ?? null, input.symptoms, input.priority, input.impact,
      input.previousRepairId ?? null, ctx.actor.staffId],
  );
  const id = ins.rows[0]!.id;
  await tx.query(`INSERT INTO journal.repair_status_history (repair_id, from_status, to_status, at, by_staff_id, comment) VALUES ($1, NULL, 'new', $2, $3, 'Регистрация')`, [id, now, ctx.actor.staffId]);
  const row = (await repairRow(tx, id))!;
  await writeAudit(
    tx,
    meta,
    { action: 'repair.registered', object: { type: 'repair', id }, branchId: row.branch_id, after: { number: row.number, equipmentId: row.equipment_id, priority: row.priority, impact: row.impact, detectedAt: detectedAt.toISOString(), brokenAt: brokenAt?.toISOString() ?? null } },
    clock,
  );
  // Критическая автоблокировка – только за флагом (K19 §1, Q-111, по умолчанию выключена): в той же транзакции, брони целы.
  const target = targetOfPlacement({ roomId: row.room_id, unitId: row.unit_id });
  let autoBlock: { blockId: string; affectedBookingIds: string[]; affectedEventIds: string[] } | null = null;
  if (row.priority === 'critical' && target && (await resolveSetting(tx, 'equipment.critical_auto_block', { network: true }, now)).value) {
    const hours = (await resolveSetting(tx, 'equipment.critical_block_hours', { network: true }, now)).value;
    const created = await createBlockFor(
      tx,
      ctx,
      { branchId: row.branch_id, target, period: interval(detectedAt, new Date(detectedAt.getTime() + hours * 3_600_000)), reasonId: await repairReasonId(tx), comment: `Ремонт ${row.number}` },
      meta,
      clock,
    );
    await linkRepairBlock(tx, ctx, row, created.blockId, { existing: false, auto: true }, meta, clock);
    autoBlock = { blockId: created.blockId, affectedBookingIds: created.affectedBookingIds, affectedEventIds: created.affectedEventIds };
  }
  await publish(tx as OutboxTx, {
    type: 'repair.registered',
    aggregateType: 'repair',
    aggregateId: id,
    aggregateVersion: 1,
    branchId: row.branch_id,
    occurredAt: now,
    payload: { repairId: id, number: row.number, equipmentId: row.equipment_id, branchId: row.branch_id, priority: row.priority, impact: row.impact, autoBlockId: autoBlock?.blockId ?? null },
  });
  const blockProposal = row.impact === 'none' || autoBlock ? null : await repairProposal(tx, row, {}, clock);
  const details = await repairHistory(tx, row.equipment_id, id, now.toISOString().slice(0, 10));
  return { repair: await toRepairDto(tx, row), blockProposal, autoBlock, details };
}

// ---- правка

const planSchema = z.strictObject({
  works: longText.nullable().optional(),
  start: date.nullable().optional(),
  end: date.nullable().optional(),
  costKop: z.number().int().min(0).max(100_000_000_000).nullable().optional(),
  responsibleStaffId: uuid.nullable().optional(),
  partsNeeded: z.boolean().optional(),
  comment: longText.nullable().optional(),
});
const updateSchema = z.strictObject({
  rowVersion: z.number().int().min(1),
  diagnostics: longText.nullable().optional(),
  cause: longText.nullable().optional(),
  worksDone: longText.nullable().optional(),
  partsUsed: longText.nullable().optional(),
  conclusion: longText.nullable().optional(),
  plan: planSchema.optional(),
  executorId: uuid.nullable().optional(),
  priority: PRIORITY.optional(),
});

export async function approvalThreshold(db: Db | Tx, at: Date): Promise<number | null> {
  return (await resolveSetting(db, 'repair.approval_threshold_kop', { network: true }, at)).value;
}

export const aboveThreshold = (costKop: number | null, threshold: number | null): boolean => threshold !== null && costKop !== null && costKop > threshold;

/** Снимок реквизитов на момент назначения (10 §8.3): правка справочника прошлые ремонты не меняет. */
export async function executorSnapshot(db: Db | Tx, executorId: string): Promise<ExecutorSnapshot> {
  const r = await db.query<{ kind: string; name: string; staff_id: string | null; contact_person: string | null; phone: string | null; email: string | null; address: string | null; inn: string | null; status: string }>(
    'SELECT kind, name, staff_id, contact_person, phone, email, address, inn, status FROM app.repair_executors WHERE id = $1',
    [executorId],
  );
  const e = r.rows[0];
  if (!e || e.status === 'archived') throw new AppError('VALIDATION_FAILED', 400, 'Исполнитель не найден или в архиве', { field: 'executorId' });
  return { kind: e.kind, name: e.name, staffId: e.staff_id, contactPerson: e.contact_person, phone: e.phone, email: e.email, address: e.address, inn: e.inn };
}

export async function updateRepair(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<RepairDto> {
  const denied = { action: 'repair.updated', object: repairObject(id) } as const;
  const row = await lockRepair(tx, id);
  if (!row) throw notFound();
  guard(ctx, row.branch_id, 'repair.manage', denied);
  const input = parseInput(updateSchema, raw);
  if (!isOpenRepair(row.status)) throw new AppError('REPAIR_TRANSITION_INVALID', 409, 'Закрытый или отменённый ремонт не меняется', { status: row.status });
  assertVersion(row.row_version, input.rowVersion);

  const keep = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);
  const p = input.plan ?? {};
  const next = {
    diagnostics: keep(input.diagnostics, row.diagnostics),
    cause: keep(input.cause, row.cause),
    worksDone: keep(input.worksDone, row.works_done),
    partsUsed: keep(input.partsUsed, row.parts_used),
    conclusion: keep(input.conclusion, row.conclusion),
    planWorks: keep(p.works, row.plan_works),
    planStart: keep(p.start, row.plan_start),
    planEnd: keep(p.end, row.plan_end),
    planCostKop: keep(p.costKop, num(row.plan_cost_kop)),
    planResponsible: keep(p.responsibleStaffId, row.plan_responsible_staff_id),
    planParts: keep(p.partsNeeded, row.plan_parts_needed),
    planComment: keep(p.comment, row.plan_comment),
    priority: input.priority ?? row.priority,
  };
  if (next.planStart && next.planEnd && next.planEnd < next.planStart) throw new AppError('VALIDATION_FAILED', 400, 'Конец плана раньше начала', { field: 'plan.end' });

  const executorId = keep(input.executorId, row.executor_id);
  const snapshot = input.executorId === undefined ? row.executor_snapshot : input.executorId === null ? null : await executorSnapshot(tx, input.executorId);

  const threshold = await approvalThreshold(tx, clock.now());
  const planChanged = input.plan !== undefined && (next.planWorks !== row.plan_works || next.planStart !== row.plan_start || next.planEnd !== row.plan_end || next.planCostKop !== num(row.plan_cost_kop)
    || next.planResponsible !== row.plan_responsible_staff_id || next.planParts !== row.plan_parts_needed || next.planComment !== row.plan_comment);
  const needsApproval = aboveThreshold(next.planCostKop, threshold);
  // Изменение плана после согласования выше порога сбрасывает согласование (K19 §6)
  const resetApproval = planChanged && needsApproval && row.approved_at !== null;

  await tx.query(
    `UPDATE app.repairs SET diagnostics = $2, cause = $3, works_done = $4, parts_used = $5, conclusion = $6, plan_works = $7, plan_start = $8, plan_end = $9, plan_cost_kop = $10,
        plan_responsible_staff_id = $11, plan_parts_needed = $12, plan_comment = $13, priority = $14, executor_id = $15, executor_snapshot = $16, approval_required = $17,
        approved_by = CASE WHEN $18 THEN NULL ELSE approved_by END, approved_at = CASE WHEN $18 THEN NULL ELSE approved_at END, row_version = row_version + 1 WHERE id = $1`,
    [id, next.diagnostics, next.cause, next.worksDone, next.partsUsed, next.conclusion, next.planWorks, next.planStart, next.planEnd, next.planCostKop, next.planResponsible, next.planParts, next.planComment,
      next.priority, executorId, snapshot === null ? null : JSON.stringify(snapshot), needsApproval, resetApproval],
  );
  const updated = (await repairRow(tx, id))!;
  await writeAudit(
    tx,
    meta,
    {
      action: 'repair.updated',
      object: { type: 'repair', id },
      branchId: row.branch_id,
      before: { planCostKop: num(row.plan_cost_kop), planEnd: row.plan_end, executorId: row.executor_id, priority: row.priority },
      after: { planCostKop: next.planCostKop, planEnd: next.planEnd, executorId, priority: next.priority, fields: Object.keys(input).filter((k) => k !== 'rowVersion'), approvalReset: resetApproval },
    },
    clock,
  );
  return toRepairDto(tx, updated);
}

// ---- статусы (K19 §6)

const TRANSITIONS: Readonly<Record<RepairStatus, readonly RepairStatus[]>> = {
  new: ['diagnostics', 'planned', 'in_repair', 'cancelled'],
  diagnostics: ['awaiting_approval', 'planned', 'in_repair', 'done_pending_check', 'cancelled'],
  // planned и diagnostics из согласования – только approveRepair; closed – только closeRepair
  awaiting_approval: ['cancelled'],
  planned: ['in_repair', 'awaiting_parts', 'cancelled'],
  in_repair: ['awaiting_parts', 'done_pending_check'],
  awaiting_parts: ['in_repair', 'cancelled'],
  done_pending_check: ['in_repair'],
  closed: [],
  cancelled: [],
};
/** Статус ремонта ведёт карточку оборудования (K19 §2): это карточка, не доступность. */
const FOLLOW: Partial<Record<RepairStatus, EquipmentStatus>> = { diagnostics: 'diagnostics', in_repair: 'repair', awaiting_parts: 'awaiting_parts' };
const invalidTransition = (from: RepairStatus, to: RepairStatus) => new AppError('REPAIR_TRANSITION_INVALID', 409, 'Такой переход статуса ремонта невозможен', { from, to });

/** Запись перехода: строка истории, аудит, карточка оборудования. Проверки – у вызывающего. */
export async function writeTransition(tx: Tx, ctx: AccessContext, row: RepairRow, to: RepairStatus, comment: string, meta: AuditRequestMeta, clock: Clock): Promise<void> {
  const now = clock.now();
  await tx.query('UPDATE app.repairs SET status = $2, row_version = row_version + 1 WHERE id = $1', [row.id, to]);
  await tx.query(`INSERT INTO journal.repair_status_history (repair_id, from_status, to_status, at, by_staff_id, comment) VALUES ($1, $2, $3, $4, $5, $6)`, [row.id, row.status, to, now, ctx.actor.staffId, comment]);
  await writeAudit(tx, meta, { action: 'repair.status_changed', object: { type: 'repair', id: row.id }, branchId: row.branch_id, before: { status: row.status }, after: { status: to }, reason: comment }, clock);
  const follow = FOLLOW[to];
  if (!follow) return;
  const item = await lockItem(tx, row.equipment_id);
  if (item && item.status !== follow && item.status !== 'written_off' && item.status !== 'lost') {
    await applyEquipmentStatus(tx, ctx, item, { status: follow, reason: `Ремонт ${row.number}`, source: 'repair' }, meta, clock);
  }
}

const statusSchema = z.strictObject({ rowVersion: z.number().int().min(1), to: z.enum(REPAIR_STATUSES), comment: z.string().trim().max(2000).optional() });

export async function changeRepairStatus(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<RepairDto> {
  const denied = { action: 'repair.status_changed', object: repairObject(id) } as const;
  const row = await lockRepair(tx, id);
  if (!row) throw notFound();
  guard(ctx, row.branch_id, 'repair.manage', denied);
  const input = parseInput(statusSchema, raw);
  assertVersion(row.row_version, input.rowVersion);
  if (!input.comment) throw new AppError('COMMENT_REQUIRED', 422, 'Смена статуса ремонта – с комментарием', { field: 'comment' });
  if (!TRANSITIONS[row.status].includes(input.to)) throw invalidTransition(row.status, input.to);
  if (input.to === 'planned' || input.to === 'in_repair') {
    const threshold = await approvalThreshold(tx, clock.now());
    if (aboveThreshold(num(row.plan_cost_kop), threshold) && !row.approved_at) {
      throw new AppError('REPAIR_APPROVAL_REQUIRED', 409, 'План выше порога – нужно согласование', { planCostKop: num(row.plan_cost_kop), thresholdKop: threshold });
    }
  }
  await writeTransition(tx, ctx, row, input.to, input.comment, meta, clock);
  return toRepairDto(tx, (await repairRow(tx, id))!);
}

const approveSchema = z.strictObject({ rowVersion: z.number().int().min(1), decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(2000).optional() });

/** Согласование Владельца (Q-52): approve → planned, reject → diagnostics. */
export async function approveRepair(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<RepairDto> {
  const denied = { action: 'repair.approved', object: repairObject(id) } as const;
  const row = await lockRepair(tx, id);
  if (!row) throw notFound();
  if (!can(ctx, 'equipment.view', { branchId: row.branch_id })) throw notFound();
  guardRole(ctx, row.branch_id, 'repair.approve', denied);
  const input = parseInput(approveSchema, raw);
  assertVersion(row.row_version, input.rowVersion);
  if (!input.comment) throw new AppError('COMMENT_REQUIRED', 422, 'Решение по согласованию – с комментарием', { field: 'comment' });
  const to: RepairStatus = input.decision === 'approve' ? 'planned' : 'diagnostics';
  if (row.status !== 'awaiting_approval') throw invalidTransition(row.status, to);
  if (input.decision === 'approve') await tx.query('UPDATE app.repairs SET approved_by = $2, approved_at = $3 WHERE id = $1', [id, ctx.actor.staffId, clock.now()]);
  await writeTransition(tx, ctx, row, to, input.comment, meta, clock);
  await writeAudit(tx, meta, { action: 'repair.approved', object: { type: 'repair', id }, branchId: row.branch_id, after: { decision: input.decision, planCostKop: num(row.plan_cost_kop) }, reason: input.comment }, clock);
  return toRepairDto(tx, (await repairRow(tx, id))!);
}

// ---- список (K19 №341, 10 §13.3)

const listSchema = z.object({
  from: iso.optional(),
  to: iso.optional(),
  branchId: uuid.optional(),
  equipmentId: uuid.optional(),
  status: z.enum(REPAIR_STATUSES).optional(),
  executorId: uuid.optional(),
  priority: PRIORITY.optional(),
  planOverdue: z.enum(['true', 'false']).optional(),
  cursor: z.string().regex(/^R-\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function listRepairs(db: Db, ctx: AccessContext, raw: unknown, clock: Clock = systemClock): Promise<{ items: RepairDto[]; nextCursor: string | null }> {
  if (!roleAllows(ctx.role, 'equipment.view')) throw forbidden('equipment.view');
  const q = parseInput(listSchema, raw);
  const params: unknown[] = [];
  const where = [branchScopeSql('r.branch_id', scopeFilter(ctx, 'equipment.view'), params)];
  const eq = (sql: string, value: unknown) => {
    if (value === undefined) return;
    params.push(value);
    where.push(`${sql} = $${params.length}`);
  };
  eq('r.branch_id', q.branchId);
  eq('r.equipment_id', q.equipmentId);
  eq('r.status', q.status);
  eq('r.executor_id', q.executorId);
  eq('r.priority', q.priority);
  if (q.from) {
    params.push(q.from);
    where.push(`r.detected_at >= $${params.length}`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`r.detected_at < $${params.length}`);
  }
  if (q.planOverdue) {
    params.push(clock.now());
    const overdue = `(r.${OPEN_REPAIR_SQL} AND r.plan_end < ($${params.length}::timestamptz AT TIME ZONE (SELECT timezone FROM app.branches b WHERE b.id = r.branch_id))::date)`;
    where.push(q.planOverdue === 'true' ? overdue : `NOT coalesce(${overdue}, false)`);
  }
  if (q.cursor) {
    params.push(q.cursor);
    where.push(`r.number < $${params.length}`);
  }
  params.push(q.limit + 1);
  const r = await db.query<RepairRow>(`${REPAIR_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.number DESC LIMIT $${params.length}`, params);
  const page = r.rows.slice(0, q.limit);
  const items: RepairDto[] = [];
  for (const row of page) items.push(await toRepairDto(db, row));
  return { items, nextCursor: r.rows.length > q.limit ? page[page.length - 1]!.number : null };
}
