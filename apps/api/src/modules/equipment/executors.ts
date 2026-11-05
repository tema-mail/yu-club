// S3-35. K19 §6, 10 §8: справочник исполнителей ремонта. Архив вместо удаления; необязательные реквизиты внутренний ремонт не
// блокируют (10 §8.2). В ремонт кладётся снимок реквизитов (repairs.ts executorSnapshot) – правка справочника прошлые ремонты не меняет
// (10 §8.3). Справочник сети: Директор правит его без сетевой зоны, поэтому проверка – по роли (K1 «repair.executor.manage»).
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { assertVersion, denyWith, forbidden, notFound, parseInput, UUID_RE } from './items.ts';

export interface RepairExecutorDto {
  id: string;
  kind: 'staff' | 'contractor' | 'service_center' | 'manufacturer';
  name: string;
  staffId: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  inn: string | null;
  comment: string | null;
  status: 'active' | 'archived';
  rowVersion: number;
}

const optional = (max: number) => z.string().trim().max(max).nullable().optional();
const fields = {
  contactPerson: optional(200),
  phone: optional(40),
  email: optional(200),
  address: optional(500),
  inn: z.string().trim().regex(/^(\d{10}|\d{12})$/).nullable().optional(),
  comment: optional(2000),
  staffId: z.string().regex(UUID_RE).nullable().optional(),
};
const KIND = z.enum(['staff', 'contractor', 'service_center', 'manufacturer']);
const createSchema = z.strictObject({ kind: KIND, name: z.string().trim().min(1).max(300), ...fields });
const updateSchema = z.strictObject({ rowVersion: z.number().int().min(1), kind: KIND.optional(), name: z.string().trim().min(1).max(300).optional(), status: z.enum(['active', 'archived']).optional(), ...fields });

const COLUMNS = `id, kind, name, staff_id AS "staffId", contact_person AS "contactPerson", phone, email, address, inn, comment, status, row_version AS "rowVersion"`;

function assertManage(ctx: AccessContext, action: 'repair.executor.created' | 'repair.executor.updated' | 'repair.executor.archived', id: string | null): void {
  if (!roleAllows(ctx.role, 'repair.executor.manage')) denyWith(forbidden('repair.executor.manage'), { action, object: { type: 'repair_executor', id }, branchId: null }, 'repair.executor.manage');
}

export async function listExecutors(db: Db | Tx, ctx: AccessContext, opts: { includeArchived?: boolean } = {}): Promise<RepairExecutorDto[]> {
  if (!roleAllows(ctx.role, 'equipment.view')) throw forbidden('equipment.view');
  const r = await db.query<RepairExecutorDto>(`SELECT ${COLUMNS} FROM app.repair_executors ${opts.includeArchived ? '' : `WHERE status = 'active'`} ORDER BY name, id`);
  return r.rows;
}

async function assertStaff(db: Db | Tx, staffId: string | null | undefined): Promise<void> {
  if (!staffId) return;
  const r = await db.query('SELECT 1 FROM app.staff WHERE id = $1', [staffId]);
  if (!r.rowCount) throw new AppError('VALIDATION_FAILED', 400, 'Сотрудник не найден', { field: 'staffId' });
}

export async function createExecutor(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<RepairExecutorDto> {
  assertManage(ctx, 'repair.executor.created', null);
  const input = parseInput(createSchema, raw);
  await assertStaff(tx, input.staffId);
  const r = await tx.query<RepairExecutorDto>(
    `INSERT INTO app.repair_executors (kind, name, staff_id, contact_person, phone, email, address, inn, comment) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
    [input.kind, input.name, input.staffId ?? null, input.contactPerson ?? null, input.phone ?? null, input.email ?? null, input.address ?? null, input.inn ?? null, input.comment ?? null],
  );
  const dto = r.rows[0]!;
  await writeAudit(tx, meta, { action: 'repair.executor.created', object: { type: 'repair_executor', id: dto.id }, after: { kind: dto.kind, name: dto.name, inn: dto.inn } }, clock);
  return dto;
}

export async function updateExecutor(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<RepairExecutorDto> {
  assertManage(ctx, 'repair.executor.updated', UUID_RE.test(id) ? id : null);
  const input = parseInput(updateSchema, raw);
  if (!UUID_RE.test(id)) throw notFound();
  const cur = (await tx.query<RepairExecutorDto>(`SELECT ${COLUMNS} FROM app.repair_executors WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw notFound();
  assertVersion(cur.rowVersion, input.rowVersion);
  await assertStaff(tx, input.staffId);
  const keep = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);
  const r = await tx.query<RepairExecutorDto>(
    `UPDATE app.repair_executors SET kind = $2, name = $3, staff_id = $4, contact_person = $5, phone = $6, email = $7, address = $8, inn = $9, comment = $10, status = $11, row_version = row_version + 1
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, input.kind ?? cur.kind, input.name ?? cur.name, keep(input.staffId, cur.staffId), keep(input.contactPerson, cur.contactPerson), keep(input.phone, cur.phone), keep(input.email, cur.email),
      keep(input.address, cur.address), keep(input.inn, cur.inn), keep(input.comment, cur.comment), input.status ?? cur.status],
  );
  const dto = r.rows[0]!;
  const action = dto.status === 'archived' && cur.status !== 'archived' ? 'repair.executor.archived' : 'repair.executor.updated';
  await writeAudit(tx, meta, { action, object: { type: 'repair_executor', id }, before: { name: cur.name, inn: cur.inn, status: cur.status }, after: { name: dto.name, inn: dto.inn, status: dto.status } }, clock);
  return dto;
}
