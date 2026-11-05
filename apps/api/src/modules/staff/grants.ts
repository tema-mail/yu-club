// S3-89: API делегирования (K1 «Делегирование», 04 §9, K11 №380–382). Выдаёт, отзывает и смотрит только Владелец;
// себе – нельзя; выдача и отзыв – в аудите. Проверка права и зоны – core/permissions (assertGrantable), действие права – там же.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { DELEGABLE, assertGrantable, noNetwork, type AccessContext, type GrantScope, type NetworkLookup } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';

const DateOnly = z.iso.date();
const createSchema = z
  .object({
    action: z.string().min(1).max(100),
    cityId: z.uuid().optional(),
    branchId: z.uuid().optional(),
    validFrom: DateOnly,
    validTo: DateOnly.nullable().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((b) => (b.cityId === undefined) !== (b.branchId === undefined), { message: 'Нужна одна цель: cityId или branchId' })
  .refine((b) => !b.validTo || b.validTo >= b.validFrom, { message: 'validTo раньше validFrom', path: ['validTo'] });
const revokeSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });
const listSchema = z.object({ staffId: z.uuid().optional() });

export interface GrantDto {
  id: string;
  staffId: string;
  action: string;
  cityId: string | null;
  branchId: string | null;
  validFrom: string;
  validTo: string | null;
  grantedBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

interface GrantRow {
  id: string;
  staff_id: string;
  action: string;
  city_id: string | null;
  branch_id: string | null;
  valid_from: string;
  valid_to: string | null;
  granted_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

const COLS = `id, staff_id, action, city_id, branch_id, valid_from::text AS valid_from, valid_to::text AS valid_to, granted_by, created_at, revoked_at, revoked_by`;
const toDto = (r: GrantRow): GrantDto => ({
  id: r.id,
  staffId: r.staff_id,
  action: r.action,
  cityId: r.city_id,
  branchId: r.branch_id,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  grantedBy: r.granted_by,
  createdAt: r.created_at.toISOString(),
  revokedAt: r.revoked_at?.toISOString() ?? null,
  revokedBy: r.revoked_by,
});

const forbidden = () => new AppError('FORBIDDEN', 403, 'Делегирование – только Владелец');
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
function assertOwner(ctx: AccessContext): void {
  if (ctx.role !== 'owner') throw forbidden();
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw ?? {});
  if (r.success) return r.data;
  throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
}

/** №380. Задним числом не выдаётся: право действует с даты начала, прошлое им не объясняется (запас сутки – зоны филиалов). */
export async function createGrant(
  tx: Tx,
  ctx: AccessContext,
  staffId: string,
  raw: unknown,
  meta: AuditRequestMeta,
  opts: { network?: NetworkLookup; clock?: Clock } = {},
): Promise<GrantDto> {
  assertOwner(ctx);
  const clock = opts.clock ?? systemClock;
  const b = parse(createSchema, raw);
  const yesterday = new Date(clock.now().getTime() - 86_400_000).toISOString().slice(0, 10);
  if (b.validFrom < yesterday) throw new AppError('VALIDATION_FAILED', 400, 'Дата начала права в прошлом', { field: 'validFrom' });
  if (staffId === ctx.actor.staffId) throw forbidden();
  const s = await tx.query<{ status: string }>(`SELECT status FROM app.staff WHERE id = $1 FOR SHARE`, [staffId]);
  if (!s.rows[0] || s.rows[0].status === 'archived') throw notFound();
  const scope: GrantScope = b.cityId ? { cityId: b.cityId } : { branchId: b.branchId! };
  await assertGrantable(tx, { staffId, action: b.action, scope, validFrom: b.validFrom }, opts.network ?? noNetwork);
  let row: GrantRow;
  try {
    const r = await tx.query<GrantRow>(
      `INSERT INTO app.staff_grants (staff_id, action, scope_type, city_id, branch_id, valid_from, valid_to, granted_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS}`,
      [staffId, b.action, b.cityId ? 'city' : 'branch', b.cityId ?? null, b.branchId ?? null, b.validFrom, b.validTo ?? null, ctx.actor.staffId, clock.now()],
    );
    row = r.rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23P01') throw new AppError('GRANT_ALREADY_ACTIVE', 409, 'На эти даты такое право уже выдано');
    throw err;
  }
  await writeAudit(
    tx,
    meta,
    {
      action: 'staff.grant.created',
      object: { type: 'staff_grant', id: row.id },
      branchId: row.branch_id,
      cityId: row.city_id,
      after: { staffId, action: row.action, cityId: row.city_id, branchId: row.branch_id, validFrom: row.valid_from, validTo: row.valid_to },
      reason: b.reason ?? null,
    },
    clock,
  );
  return toDto(row);
}

/** №381. Действует со следующего запроса (loadAccess без кэша). Повтор над отозванным – без новой записи аудита. */
export async function revokeGrant(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<GrantDto> {
  assertOwner(ctx);
  const b = parse(revokeSchema, raw);
  if (!z.uuid().safeParse(id).success) throw notFound();
  const seen = await tx.query<GrantRow>(`SELECT ${COLS} FROM app.staff_grants WHERE id = $1 FOR UPDATE`, [id]);
  const before = seen.rows[0];
  if (!before) throw notFound();
  if (before.revoked_at) return toDto(before);
  const r = await tx.query<GrantRow>(`UPDATE app.staff_grants SET revoked_at = $2, revoked_by = $3 WHERE id = $1 RETURNING ${COLS}`, [id, clock.now(), ctx.actor.staffId]);
  const row = r.rows[0]!;
  await writeAudit(
    tx,
    meta,
    {
      action: 'staff.grant.revoked',
      object: { type: 'staff_grant', id },
      branchId: row.branch_id,
      cityId: row.city_id,
      before: { staffId: row.staff_id, action: row.action, validFrom: row.valid_from, validTo: row.valid_to },
      reason: b.reason ?? null,
    },
    clock,
  );
  return toDto(row);
}

/** №382. Вместе со списком – закрытый список действий: экран предлагает только их (S3-87). */
export async function listGrants(db: Db, ctx: AccessContext, raw: unknown): Promise<{ items: GrantDto[]; delegable: readonly string[] }> {
  assertOwner(ctx);
  const q = parse(listSchema, raw);
  const r = await db.query<GrantRow>(
    `SELECT ${COLS} FROM app.staff_grants WHERE ($1::uuid IS NULL OR staff_id = $1) ORDER BY created_at DESC, id LIMIT 500`,
    [q.staffId ?? null],
  );
  return { items: r.rows.map(toDto), delegable: DELEGABLE };
}
