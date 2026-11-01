// S1-14. Базовый тариф: филиал × тип ресурса × длительность и цена брони со снимком (K6 §Цена, K5 шаг 3, 15 §9.1–9.4).
// quote() – единственный вход для booking: нет тарифа → TARIFF_NOT_CONFIGURED (не 0 ₽), два с одинаковым наибольшим
// приоритетом → TARIFF_AMBIGUOUS. Снимок (tariffId, priceKop, snapshot) кладёт в booking_versions сам booking (K10:
// сеансу оплаты нужен только он) – смена тарифа созданную бронь не меняет. Цена тарифа в базе неизменна (0107).
// Команды CRM: создание, изменение (имя, конец действия, включение черновика), архив – право tariff.manage (K1), аудит K2.
// Сеть читается только через modules/network/index.ts (ADR 0002).
import { z } from 'zod';
import { diffFields, writeAudit, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { getBranch, isUuid } from '../network/index.ts';

/** Отказ по правам – для writeDenied в HTTP-слое (ADR 0005 п.8). */
export interface Denial {
  action: AuditAction;
  object: { type: AuditObjectType; id: string | null };
  branchId: string | null;
  cityId: string | null;
  reason: string;
}

export type TariffStatus = 'draft' | 'active' | 'archived';

export interface Tariff {
  id: string;
  branchId: string;
  resourceType: string;
  name: string;
  unitMinutes: number;
  pricePerUnitKop: number;
  durationFromMin: number;
  durationToMin: number | null;
  validFrom: Date;
  validTo: Date | null;
  priority: number;
  status: TariffStatus;
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface Quote {
  tariffId: string;
  priceKop: number;
  snapshot: { tariffName: string; unitMinutes: number; pricePerUnitKop: number; units: number };
}

interface TariffRow {
  id: string;
  branch_id: string;
  resource_type: string;
  name: string;
  unit_minutes: number;
  price_per_unit_kop: string; // bigint
  duration_from_min: number;
  duration_to_min: number | null;
  valid_from: Date;
  valid_to: Date | null;
  priority: number;
  status: TariffStatus;
  created_by: string;
  created_at: Date;
  archived_at: Date | null;
}

const COLUMNS = `id, branch_id, resource_type, name, unit_minutes, price_per_unit_kop, duration_from_min, duration_to_min,
  valid_from, valid_to, priority, status, created_by, created_at, archived_at`;

function toTariff(r: TariffRow): Tariff {
  return {
    id: r.id,
    branchId: r.branch_id,
    resourceType: r.resource_type,
    name: r.name,
    unitMinutes: r.unit_minutes,
    pricePerUnitKop: Number(r.price_per_unit_kop),
    durationFromMin: r.duration_from_min,
    durationToMin: r.duration_to_min,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    priority: r.priority,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

/** Цена по тарифу: ceil(длительность / единица) × цена единицы (model-dannyh §0107). */
export function priceOf(t: Pick<Tariff, 'id' | 'name' | 'unitMinutes' | 'pricePerUnitKop'>, durationMinutes: number): Quote {
  const units = Math.ceil(durationMinutes / t.unitMinutes);
  return {
    tariffId: t.id,
    priceKop: units * t.pricePerUnitKop,
    snapshot: { tariffName: t.name, unitMinutes: t.unitMinutes, pricePerUnitKop: t.pricePerUnitKop, units },
  };
}

// ---- цена брони (K6 quote)

/** Тариф по филиалу, типу ресурса, моменту начала и длительности: status='active', действует на start.
 *  0 подходящих → TARIFF_NOT_CONFIGURED; ≥2 с наибольшим одинаковым priority → TARIFF_AMBIGUOUS. */
export async function quote(
  tx: Db | Tx,
  input: { branchId: string; resourceType: string; start: Date; durationMinutes: number },
): Promise<Quote> {
  const d = input.durationMinutes;
  if (!Number.isInteger(d) || d < 1 || d > 32_767) {
    throw new AppError('INVALID_DURATION', 422, 'Неверная длительность', { durationMinutes: d });
  }
  const details = { branchId: input.branchId, resourceType: input.resourceType, start: input.start.toISOString(), durationMinutes: d };
  if (!isUuid(input.branchId)) throw new AppError('TARIFF_NOT_CONFIGURED', 422, 'Тариф не настроен', details);
  // ADR 0003 п.10: момент – параметром, не now() базы.
  const r = await tx.query<TariffRow>(
    `SELECT ${COLUMNS} FROM app.tariffs
     WHERE status = 'active' AND branch_id = $1 AND resource_type = $2
       AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
       AND duration_from_min <= $4 AND (duration_to_min IS NULL OR duration_to_min > $4)
     ORDER BY priority DESC, id LIMIT 2`,
    [input.branchId, input.resourceType, input.start, d],
  );
  const [best, next] = r.rows;
  if (!best) throw new AppError('TARIFF_NOT_CONFIGURED', 422, 'Тариф не настроен', details);
  // Защита на случай снятого ограничения tariffs_same_priority_overlap: выбирать наугад нельзя.
  if (next && next.priority === best.priority) {
    throw new AppError('TARIFF_AMBIGUOUS', 422, 'Два тарифа одного приоритета', { ...details, tariffIds: [best.id, next.id] });
  }
  return priceOf(toTariff(best), d);
}

// ---- права (как в network: вне зоны – 404 как у несуществующего, в зоне без права – 403)

const DENIALS = new WeakMap<AppError, Denial>();
/** Отказ по правам команд тарифа (для writeDenied в HTTP-слое) или undefined. */
export const tariffDenialOf = (err: unknown): Denial | undefined => (err instanceof AppError ? DENIALS.get(err) : undefined);

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

async function guardBranch(db: Db | Tx, ctx: AccessContext, branchId: string, action: AuditAction, tariffId: string | null): Promise<{ cityId: string }> {
  const b = await getBranch(db, branchId);
  const d = {
    action,
    object: { type: 'tariff' as const, id: tariffId },
    branchId: b?.id ?? null,
    cityId: b?.cityId ?? null,
  };
  const deny = (code: 'NOT_FOUND' | 'FORBIDDEN'): never => {
    const err = code === 'NOT_FOUND' ? notFound() : new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'tariff.manage' });
    DENIALS.set(err, { ...d, reason: `${code}: tariff.manage` });
    throw err;
  };
  if (!b) {
    if (!roleAllows(ctx.role, 'tariff.manage')) deny('FORBIDDEN');
    throw notFound();
  }
  if (!can(ctx, 'network.view', { branchId: b.id })) deny('NOT_FOUND');
  if (!can(ctx, 'tariff.manage', { branchId: b.id })) deny('FORBIDDEN');
  return { cityId: b.cityId };
}

// ---- разбор

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const MOMENT = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const SMALL = z.number().int().min(0).max(32_767);

const createSchema = z
  .object({
    branchId: z.string(),
    resourceType: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    unitMinutes: SMALL.min(1),
    pricePerUnitKop: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    durationFromMin: SMALL.default(0),
    durationToMin: SMALL.nullable().default(null),
    validFrom: MOMENT,
    validTo: MOMENT.nullable().default(null),
    priority: z.number().int().min(-32_768).max(32_767).default(0),
    status: z.enum(['draft', 'active']).default('active'),
  })
  .refine((t) => t.durationToMin === null || t.durationToMin > t.durationFromMin, { path: ['durationToMin'], message: 'Верх длительности больше низа' })
  .refine((t) => t.validTo === null || t.validTo > t.validFrom, { path: ['validTo'], message: 'Конец действия позже начала' });

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    validTo: MOMENT.nullable().optional(),
    status: z.literal('active').optional(), // черновик → действующий
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Нечего менять' });

/** Активный тариф того же филиала, типа и приоритета с пересечением длительностей и периода – до сохранения (15 §20). */
async function assertNoPriorityConflict(db: Db | Tx, t: Omit<Tariff, 'id' | 'createdBy' | 'createdAt' | 'archivedAt' | 'status'> & { id: string | null }): Promise<void> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM app.tariffs
     WHERE status = 'active' AND branch_id = $1 AND resource_type = $2 AND priority = $3 AND id IS DISTINCT FROM $4::uuid
       AND int4range(duration_from_min, duration_to_min, '[)') && int4range($5, $6, '[)')
       AND tstzrange(valid_from, valid_to, '[)') && tstzrange($7, $8, '[)')
     LIMIT 1`,
    [t.branchId, t.resourceType, t.priority, t.id, t.durationFromMin, t.durationToMin, t.validFrom, t.validTo],
  );
  if (r.rows[0]) throw priorityConflict(r.rows[0].id);
}

const priorityConflict = (tariffId: string | null) =>
  new AppError('TARIFF_PRIORITY_CONFLICT', 409, 'Уже есть тариф того же приоритета на эти длительности и даты', { tariffId });

/** Гонка двух сохранений: EXCLUDE tariffs_same_priority_overlap → тот же код; неизвестный тип ресурса – 400. */
function dbError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23P01') throw priorityConflict(null);
  if (e.code === '23503' && e.constraint?.includes('resource_type')) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неизвестный тип ресурса', { field: 'resourceType' });
  }
  throw err;
}

// ---- команды CRM (транзакцию открывает вызывающий)

export async function createTariff(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<Tariff> {
  const input = parse(createSchema, raw);
  const { cityId } = await guardBranch(tx, ctx, input.branchId, 'tariff.created', null);
  if (input.status === 'active') await assertNoPriorityConflict(tx, { ...input, id: null });
  const r = await tx
    .query<TariffRow>(
      `INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, duration_from_min, duration_to_min,
         valid_from, valid_to, priority, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${COLUMNS}`,
      [
        input.branchId,
        input.resourceType,
        input.name,
        input.unitMinutes,
        input.pricePerUnitKop,
        input.durationFromMin,
        input.durationToMin,
        input.validFrom,
        input.validTo,
        input.priority,
        input.status,
        ctx.actor.staffId,
        clock.now(),
      ],
    )
    .catch(dbError);
  const t = toTariff(r.rows[0]!);
  await writeAudit(tx, meta, { action: 'tariff.created', object: { type: 'tariff', id: t.id }, branchId: t.branchId, cityId, after: t }, clock);
  return t;
}

async function lockTariff(tx: Tx, ctx: AccessContext, tariffId: string, action: AuditAction): Promise<{ t: Tariff; cityId: string }> {
  const r = isUuid(tariffId) ? await tx.query<TariffRow>(`SELECT ${COLUMNS} FROM app.tariffs WHERE id = $1 FOR UPDATE`, [tariffId]) : { rows: [] };
  if (!r.rows[0]) {
    if (!roleAllows(ctx.role, 'tariff.manage')) {
      const err = new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'tariff.manage' });
      DENIALS.set(err, { action, object: { type: 'tariff', id: isUuid(tariffId) ? tariffId : null }, branchId: null, cityId: null, reason: 'FORBIDDEN: tariff.manage' });
      throw err;
    }
    throw notFound();
  }
  const t = toTariff(r.rows[0]);
  const { cityId } = await guardBranch(tx, ctx, t.branchId, action, t.id);
  if (t.status === 'archived') throw new AppError('TARIFF_ARCHIVED', 409, 'Тариф в архиве');
  return { t, cityId };
}

/** Имя, конец действия (не в прошлом – прошлые цены не переписываются), включение черновика. Цена не меняется. */
export async function updateTariff(
  tx: Tx,
  ctx: AccessContext,
  tariffId: string,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<Tariff> {
  const { t, cityId } = await lockTariff(tx, ctx, tariffId, 'tariff.updated');
  const p = parse(patchSchema, raw);
  const now = clock.now();
  const next: Tariff = {
    ...t,
    name: p.name ?? t.name,
    validTo: p.validTo === undefined ? t.validTo : p.validTo,
    status: p.status ?? t.status,
  };
  if (p.validTo !== undefined && p.validTo !== null && (p.validTo <= t.validFrom || p.validTo < now)) {
    throw new AppError('VALIDATION_FAILED', 400, 'Конец действия – позже начала и не в прошлом', { field: 'validTo' });
  }
  if (next.status === 'active') await assertNoPriorityConflict(tx, next);
  const r = await tx
    .query<TariffRow>(`UPDATE app.tariffs SET name = $2, valid_to = $3, status = $4 WHERE id = $1 RETURNING ${COLUMNS}`, [
      t.id,
      next.name,
      next.validTo,
      next.status,
    ])
    .catch(dbError);
  const after = toTariff(r.rows[0]!);
  const d = diffFields({ ...t }, { ...after });
  if (Object.keys(d.after).length > 0) {
    await writeAudit(tx, meta, { action: 'tariff.updated', object: { type: 'tariff', id: t.id }, branchId: t.branchId, cityId, ...d }, clock);
  }
  return after;
}

/** Архив: тариф больше не применяется к новым броням; созданные брони хранят снимок. */
export async function archiveTariff(tx: Tx, ctx: AccessContext, tariffId: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<Tariff> {
  const { t, cityId } = await lockTariff(tx, ctx, tariffId, 'tariff.archived');
  const r = await tx.query<TariffRow>(`UPDATE app.tariffs SET status = 'archived', archived_at = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [
    t.id,
    clock.now(),
  ]);
  const after = toTariff(r.rows[0]!);
  await writeAudit(
    tx,
    meta,
    { action: 'tariff.archived', object: { type: 'tariff', id: t.id }, branchId: t.branchId, cityId, before: { status: t.status }, after: { status: after.status } },
    clock,
  );
  return after;
}

const listSchema = z.object({
  resourceType: z.string().max(64).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
});

/** Тарифы филиала (видит любой сотрудник зоны: право schedule.view). Порядок фиксирован. Вне зоны – 404. */
export async function listTariffs(db: Db, ctx: AccessContext, branchId: string, raw: unknown): Promise<{ items: Tariff[] }> {
  const q = parse(listSchema, raw);
  const b = await getBranch(db, branchId);
  if (!b || !can(ctx, 'schedule.view', { branchId: b.id })) throw notFound();
  const params: unknown[] = [b.id];
  let where = 'branch_id = $1';
  if (q.resourceType) where += ` AND resource_type = $${params.push(q.resourceType)}`;
  if (q.status) where += ` AND status = $${params.push(q.status)}`;
  const r = await db.query<TariffRow>(`SELECT ${COLUMNS} FROM app.tariffs WHERE ${where} ORDER BY resource_type, priority DESC, valid_from, id`, params);
  return { items: r.rows.map(toTariff) };
}
