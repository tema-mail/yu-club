// S3-32. K19 §5: учётные записи PS/VR (10 §5). Хранится идентификатор и подсказка «где взять доступ», паролей и кодов нет ни в
// схеме команды (strictObject отвергает лишнее), ни в таблице (Q-53). Переназначение закрывает прежнюю связь с датой и причиной и
// создаёт новую (10 §5.4). Видят учётки Владелец и Директор; Администратор – нет (equipment.view.accounts, Q-54).
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { denyWith, forbidden, guard, itemRow, notFound, parseInput, UUID_RE } from './items.ts';

export interface EquipmentAccountDto {
  id: string;
  platform: 'playstation' | 'meta' | 'other';
  displayName: string;
  equipmentId: string | null;
  branchId: string;
  status: 'active' | 'ended';
  boundFrom: string;
  boundTo: string | null;
  endReason: string | null;
  accessHint: string | null;
  comment: string | null;
}

const uuid = z.string().regex(UUID_RE);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bindSchema = z.strictObject({
  platform: z.enum(['playstation', 'meta', 'other']),
  displayName: z.string().trim().min(1).max(200),
  equipmentId: uuid.nullable(),
  branchId: uuid,
  boundFrom: date,
  accessHint: z.string().trim().max(500).nullish(),
  comment: z.string().trim().max(2000).nullish(),
});
const rebindSchema = z.strictObject({ equipmentId: uuid.nullable(), at: date, reason: z.string().trim().min(1).max(2000) });

interface AccountRow {
  id: string;
  platform: EquipmentAccountDto['platform'];
  display_name: string;
  equipment_id: string | null;
  branch_id: string;
  status: EquipmentAccountDto['status'];
  bound_from: string;
  bound_to: string | null;
  end_reason: string | null;
  access_hint: string | null;
  comment: string | null;
}
const COLUMNS = `id, platform, display_name, equipment_id, branch_id, status, to_char(bound_from, 'YYYY-MM-DD') AS bound_from, to_char(bound_to, 'YYYY-MM-DD') AS bound_to, end_reason, access_hint, comment`;

const toDto = (r: AccountRow): EquipmentAccountDto => ({
  id: r.id,
  platform: r.platform,
  displayName: r.display_name,
  equipmentId: r.equipment_id,
  branchId: r.branch_id,
  status: r.status,
  boundFrom: r.bound_from,
  boundTo: r.bound_to,
  endReason: r.end_reason,
  accessHint: r.access_hint,
  comment: r.comment,
});

/** Оборудование привязки: в зоне действующего, не списанное; его филиал – филиал связи. */
async function equipmentForBinding(db: Db | Tx, ctx: AccessContext, equipmentId: string): Promise<{ branchId: string }> {
  const row = await itemRow(db, equipmentId);
  if (!row || !can(ctx, 'equipment.manage', { branchId: row.branch_id })) throw notFound();
  if (row.status === 'written_off') throw new AppError('EQUIPMENT_WRITTEN_OFF', 409, 'Списанное оборудование не изменяется');
  return { branchId: row.branch_id };
}

export async function bindAccount(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EquipmentAccountDto> {
  const denied = { action: 'equipment.account.bound', object: { type: 'equipment_account', id: null } } as const;
  const branchHint = (raw as { branchId?: unknown } | null)?.branchId;
  if (typeof branchHint === 'string') guard(ctx, branchHint, 'equipment.manage', denied);
  const input = parseInput(bindSchema, raw);
  guard(ctx, input.branchId, 'equipment.manage', denied);
  if (input.equipmentId) {
    const eq = await equipmentForBinding(tx, ctx, input.equipmentId);
    if (eq.branchId !== input.branchId) throw new AppError('VALIDATION_FAILED', 400, 'Оборудование из другого филиала', { field: 'equipmentId' });
  }
  const r = await tx.query<AccountRow>(
    `INSERT INTO app.equipment_accounts (platform, display_name, equipment_id, branch_id, bound_from, access_hint, comment, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
    [input.platform, input.displayName, input.equipmentId, input.branchId, input.boundFrom, input.accessHint ?? null, input.comment ?? null, ctx.actor.staffId, clock.now()],
  );
  const dto = toDto(r.rows[0]!);
  await writeAudit(tx, meta, { action: 'equipment.account.bound', object: { type: 'equipment_account', id: dto.id }, branchId: dto.branchId, after: { platform: dto.platform, displayName: dto.displayName, equipmentId: dto.equipmentId, boundFrom: dto.boundFrom } }, clock);
  return dto;
}

/** Переназначение: прежняя связь закрывается датой и причиной; equipmentId = null – учётка просто снята (новой связи нет). */
export async function rebindAccount(
  tx: Tx,
  ctx: AccessContext,
  accountId: string,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ ended: EquipmentAccountDto; current: EquipmentAccountDto | null }> {
  const denied = { action: 'equipment.account.rebound', object: { type: 'equipment_account', id: UUID_RE.test(accountId) ? accountId : null } } as const;
  const found = UUID_RE.test(accountId) ? await tx.query<AccountRow>(`SELECT ${COLUMNS} FROM app.equipment_accounts WHERE id = $1 FOR UPDATE`, [accountId]) : { rows: [] };
  const cur = found.rows[0];
  if (!cur) throw notFound();
  guard(ctx, cur.branch_id, 'equipment.manage', denied);
  const input = parseInput(rebindSchema, raw);
  if (cur.status === 'ended') throw new AppError('VERSION_CONFLICT', 409, 'Эта связь уже закрыта – обновите форму', { accountId });
  if (input.at < cur.bound_from) throw new AppError('VALIDATION_FAILED', 400, 'Дата раньше начала прежней связи', { field: 'at' });
  const target = input.equipmentId ? await equipmentForBinding(tx, ctx, input.equipmentId) : null;
  const ended = await tx.query<AccountRow>(`UPDATE app.equipment_accounts SET status = 'ended', bound_to = $2, end_reason = $3 WHERE id = $1 RETURNING ${COLUMNS}`, [accountId, input.at, input.reason]);
  let current: EquipmentAccountDto | null = null;
  if (input.equipmentId && target) {
    const ins = await tx.query<AccountRow>(
      `INSERT INTO app.equipment_accounts (platform, display_name, equipment_id, branch_id, bound_from, access_hint, comment, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [cur.platform, cur.display_name, input.equipmentId, target.branchId, input.at, cur.access_hint, cur.comment, ctx.actor.staffId, clock.now()],
    );
    current = toDto(ins.rows[0]!);
  }
  await writeAudit(
    tx,
    meta,
    {
      action: 'equipment.account.rebound',
      object: { type: 'equipment_account', id: accountId },
      branchId: cur.branch_id,
      before: { equipmentId: cur.equipment_id },
      after: { equipmentId: input.equipmentId, at: input.at, currentAccountId: current?.id ?? null },
      reason: input.reason,
    },
    clock,
  );
  return { ended: toDto(ended.rows[0]!), current };
}

/** Учётки оборудования или филиала; без equipment.view.accounts – 403 в зоне (Администратор, Q-54), вне зоны – 404. */
export async function listAccounts(db: Db | Tx, ctx: AccessContext, filter: { equipmentId?: string | undefined; branchId?: string | undefined }): Promise<EquipmentAccountDto[]> {
  let branchId = filter.branchId ?? null;
  if (filter.equipmentId) {
    const row = await itemRow(db, filter.equipmentId);
    if (!row) throw notFound();
    branchId = row.branch_id;
  }
  if (!branchId || !can(ctx, 'equipment.view', { branchId })) throw notFound();
  if (!can(ctx, 'equipment.view.accounts', { branchId })) {
    denyWith(forbidden('equipment.view.accounts'), { action: 'equipment.account.bound', object: { type: 'equipment_account', id: null }, branchId }, 'equipment.view.accounts');
  }
  const r = filter.equipmentId
    ? await db.query<AccountRow>(`SELECT ${COLUMNS} FROM app.equipment_accounts WHERE equipment_id = $1 ORDER BY status, bound_from DESC, id`, [filter.equipmentId])
    : await db.query<AccountRow>(`SELECT ${COLUMNS} FROM app.equipment_accounts WHERE branch_id = $1 ORDER BY status, bound_from DESC, id`, [branchId]);
  return r.rows.map(toDto);
}
