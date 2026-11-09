// S3-51. Состав мероприятия и пакеты (K20 §3, 11 §5.1–5.2, §7.1): строки с ценой для клиента и плановой себестоимостью,
// удаление – статусом с причиной, скидка – с причиной. Пакет – шаблон: applyPackage копирует строки, дальнейшая правка
// состава шаблон не меняет (приёмка 4). Индивидуальная цена и скидка – право event.price.manage (Владелец, Директор);
// без него (Администратор) – только цена из пакета мероприятия или 0 ₽ (11 §17 п.8, Q-70). Каждое изменение – аудит
// before/after с согласованной стоимостью (11 §7.4, приёмка 21). Факт себестоимости здесь не вводится: он из связанных
// расходов (money.ts). Справочники типов и пакетов (№370) – тоже здесь: их единственный потребитель – состав.
import { z } from 'zod';
import { diffFields, writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan, can, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { agreedOf, isClosed, lockEvent, notFound, parseBody, requireReason, UUID_RE, type EventRow } from './events.ts';

export const LINE_KINDS = ['service', 'goods', 'room_rent', 'game_time', 'animator', 'catering', 'decor', 'activity', 'other'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export interface EventLineDto {
  id: string;
  eventId: string;
  kind: LineKind;
  name: string;
  quantity: number;
  unit: string;
  priceKop: number;
  discountKop: number;
  discountReason: string | null;
  planCostKop: number | null;
  supplier: string | null;
  comment: string | null;
  status: 'active' | 'removed';
  removedReason: string | null;
  rowVersion: number;
}

interface LineRow {
  id: string;
  event_id: string;
  kind: LineKind;
  name: string;
  quantity: string;
  unit: string;
  price_kop: string;
  discount_kop: string;
  discount_reason: string | null;
  plan_cost_kop: string | null;
  supplier: string | null;
  comment: string | null;
  status: 'active' | 'removed';
  removed_reason: string | null;
  row_version: number;
}

const LINE_COLS = 'id, event_id, kind, name, quantity, unit, price_kop, discount_kop, discount_reason, plan_cost_kop, supplier, comment, status, removed_reason, row_version';

function toLineDto(r: LineRow): EventLineDto {
  return {
    id: r.id,
    eventId: r.event_id,
    kind: r.kind,
    name: r.name,
    quantity: Number(r.quantity),
    unit: r.unit,
    priceKop: Number(r.price_kop),
    discountKop: Number(r.discount_kop),
    discountReason: r.discount_reason,
    planCostKop: r.plan_cost_kop === null ? null : Number(r.plan_cost_kop),
    supplier: r.supplier,
    comment: r.comment,
    status: r.status,
    removedReason: r.removed_reason,
    rowVersion: r.row_version,
  };
}

/** Аудит: что важно для истории цены (11 §7.4). */
const lineView = (l: EventLineDto) => ({
  kind: l.kind, name: l.name, quantity: l.quantity, unit: l.unit, priceKop: l.priceKop, discountKop: l.discountKop, discountReason: l.discountReason,
  planCostKop: l.planCostKop, supplier: l.supplier, comment: l.comment, status: l.status,
});

const Kop = z.number().int().min(0).max(100_000_000_000);
// Не больше двух знаков после запятой: 1.1 * 100 = 110.00000000000001 в плавающей точке, поэтому сравнение с допуском:
// третий знак даёт отклонение не меньше 0,1, а ошибка округления у 99 999 999,99 × 100 – порядка 1e-6.
const Quantity = z.number().positive().max(99_999_999).refine((q) => Math.abs(Math.round(q * 100) - q * 100) < 1e-3, 'не больше двух знаков');
const Short = z.string().trim().min(1).max(200);
const Note = z.string().trim().max(2000);

const lineFields = {
  kind: z.enum(LINE_KINDS),
  name: Short,
  quantity: Quantity,
  unit: z.string().trim().min(1).max(30),
  priceKop: Kop,
  discountKop: Kop,
  discountReason: Note.nullish(),
  planCostKop: Kop.nullish(),
  supplier: Short.nullish(),
  comment: Note.nullish(),
};
const addSchema = z.object({ ...lineFields, discountKop: Kop.default(0) });
const updateSchema = z.object({
  rowVersion: z.number().int(),
  kind: lineFields.kind.optional(),
  name: lineFields.name.optional(),
  quantity: lineFields.quantity.optional(),
  unit: lineFields.unit.optional(),
  priceKop: lineFields.priceKop.optional(),
  discountKop: lineFields.discountKop.optional(),
  discountReason: lineFields.discountReason,
  planCostKop: lineFields.planCostKop,
  supplier: lineFields.supplier,
  comment: lineFields.comment,
});
const removeSchema = z.object({ rowVersion: z.number().int(), reason: z.string().max(2000).optional() });
const packageLineSchema = z.object({
  kind: lineFields.kind,
  name: lineFields.name,
  quantity: lineFields.quantity,
  unit: lineFields.unit,
  priceKop: lineFields.priceKop,
  planCostKop: lineFields.planCostKop,
  supplier: lineFields.supplier,
  comment: lineFields.comment,
});
export type PackageLine = z.infer<typeof packageLineSchema>;

const forbiddenPrice = () => new AppError('FORBIDDEN', 403, 'Цену и скидку меняет Владелец или Директор', { action: 'event.price.manage' });

function assertOpen(e: EventRow): void {
  if (isClosed(e.status)) throw new AppError('EVENT_CLOSED', 409, 'Мероприятие завершено – состав не меняется', { status: e.status });
}

function assertDiscount(quantity: number, priceKop: number, discountKop: number, reason: string | null | undefined): void {
  if (discountKop > 0 && !(reason ?? '').trim()) throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину скидки', { field: 'discountReason' });
  if (discountKop > Math.round(quantity * priceKop)) throw new AppError('VALIDATION_FAILED', 400, 'Скидка больше стоимости строки', { field: 'discountKop' });
}

/** Цена без права event.price.manage: 0 ₽ или цена этой же позиции в пакете мероприятия. */
async function assertPriceAllowed(db: Db, ctx: AccessContext, e: EventRow, line: { name: string; priceKop: number; discountKop: number }): Promise<void> {
  if (can(ctx, 'event.price.manage', { branchId: e.branch_id })) return;
  if (line.discountKop > 0) throw forbiddenPrice();
  if (line.priceKop === 0) return;
  const inPackage = e.package_id ? ((await packageLines(db, e.package_id)) ?? []).some((p) => p.name === line.name && p.priceKop === line.priceKop) : false;
  if (!inPackage) throw forbiddenPrice();
}

async function packageLines(db: Db, packageId: string): Promise<PackageLine[] | null> {
  const r = await db.query<{ lines: PackageLine[] }>('SELECT lines FROM app.event_packages WHERE id = $1', [packageId]);
  return r.rows[0]?.lines ?? null;
}

async function insertLine(tx: Tx, eventId: string, l: z.infer<typeof addSchema>): Promise<EventLineDto> {
  const r = await tx.query<LineRow>(
    `INSERT INTO app.event_lines (event_id, kind, name, quantity, unit, price_kop, discount_kop, discount_reason, plan_cost_kop, supplier, comment, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, (SELECT coalesce(max(sort_order), 0) + 1 FROM app.event_lines WHERE event_id = $1))
     RETURNING ${LINE_COLS}`,
    [eventId, l.kind, l.name, l.quantity, l.unit, l.priceKop, l.discountKop, l.discountReason?.trim() || null, l.planCostKop ?? null, l.supplier ?? null, l.comment ?? null],
  );
  return toLineDto(r.rows[0]!);
}

export async function addLine(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventLineDto> {
  const input = parseBody(addSchema, raw);
  const e = await lockEvent(tx, ctx, eventId, 'event.manage');
  assertOpen(e);
  await assertPriceAllowed(tx, ctx, e, input);
  assertDiscount(input.quantity, input.priceKop, input.discountKop, input.discountReason);
  const line = await insertLine(tx, e.id, input);
  const { agreedKop } = await agreedOf(tx, e.id);
  await writeAudit(tx, meta, { action: 'event.line_added', object: { type: 'event', id: e.id }, branchId: e.branch_id, after: { lineId: line.id, ...lineView(line), agreedKop } }, clock);
  return line;
}

/** Строка и её мероприятие под замком: сначала мероприятие (порядок всех команд), потом строка. */
async function lockLine(tx: Tx, ctx: AccessContext, lineId: string): Promise<{ e: EventRow; row: LineRow }> {
  if (!UUID_RE.test(lineId)) throw notFound();
  const found = await tx.query<{ event_id: string }>('SELECT event_id FROM app.event_lines WHERE id = $1', [lineId]);
  if (!found.rows[0]) throw notFound();
  const e = await lockEvent(tx, ctx, found.rows[0].event_id, 'event.manage');
  const r = await tx.query<LineRow>(`SELECT ${LINE_COLS} FROM app.event_lines WHERE id = $1 FOR UPDATE`, [lineId]);
  return { e, row: r.rows[0]! };
}

function assertLineVersion(row: LineRow, rowVersion: number): void {
  if (row.row_version !== rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Строку уже изменили – обновите карточку', { current: row.row_version });
}

export async function updateLine(tx: Tx, ctx: AccessContext, lineId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventLineDto> {
  const input = parseBody(updateSchema, raw);
  const { e, row } = await lockLine(tx, ctx, lineId);
  assertOpen(e);
  assertLineVersion(row, input.rowVersion);
  if (row.status === 'removed') throw new AppError('VALIDATION_FAILED', 400, 'Строка удалена', { field: 'status' });
  const old = toLineDto(row);
  const next = {
    kind: input.kind ?? old.kind,
    name: input.name ?? old.name,
    quantity: input.quantity ?? old.quantity,
    unit: input.unit ?? old.unit,
    priceKop: input.priceKop ?? old.priceKop,
    discountKop: input.discountKop ?? old.discountKop,
    discountReason: input.discountReason !== undefined ? input.discountReason : old.discountReason,
    planCostKop: input.planCostKop !== undefined ? input.planCostKop : old.planCostKop,
    supplier: input.supplier !== undefined ? input.supplier : old.supplier,
    comment: input.comment !== undefined ? input.comment : old.comment,
  };
  if ((next.priceKop !== old.priceKop || next.discountKop !== old.discountKop) && !can(ctx, 'event.price.manage', { branchId: e.branch_id })) throw forbiddenPrice();
  assertDiscount(next.quantity, next.priceKop, next.discountKop, next.discountReason);
  const r = await tx.query<LineRow>(
    `UPDATE app.event_lines SET kind = $2, name = $3, quantity = $4, unit = $5, price_kop = $6, discount_kop = $7, discount_reason = $8, plan_cost_kop = $9, supplier = $10,
       comment = $11, row_version = row_version + 1 WHERE id = $1 RETURNING ${LINE_COLS}`,
    [row.id, next.kind, next.name, next.quantity, next.unit, next.priceKop, next.discountKop, next.discountKop > 0 ? next.discountReason?.trim() : null, next.planCostKop ?? null, next.supplier ?? null, next.comment ?? null],
  );
  const line = toLineDto(r.rows[0]!);
  const { agreedKop } = await agreedOf(tx, e.id);
  const diff = diffFields(lineView(old), lineView(line));
  await writeAudit(tx, meta, { action: 'event.line_updated', object: { type: 'event', id: e.id }, branchId: e.branch_id, before: { lineId: line.id, ...diff.before }, after: { lineId: line.id, ...diff.after, agreedKop } }, clock);
  return line;
}

/** Удаление – статус с причиной (K20 §3): связанные расходы и история остаются. Повтор по удалённой – без изменений. */
export async function removeLine(tx: Tx, ctx: AccessContext, lineId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventLineDto> {
  const input = parseBody(removeSchema, raw);
  const { e, row } = await lockLine(tx, ctx, lineId);
  assertOpen(e);
  if (row.status === 'removed') return toLineDto(row);
  assertLineVersion(row, input.rowVersion);
  const reason = requireReason(input.reason);
  const r = await tx.query<LineRow>(`UPDATE app.event_lines SET status = 'removed', removed_reason = $2, row_version = row_version + 1 WHERE id = $1 RETURNING ${LINE_COLS}`, [row.id, reason]);
  const { agreedKop } = await agreedOf(tx, e.id);
  await writeAudit(tx, meta, { action: 'event.line_removed', object: { type: 'event', id: e.id }, branchId: e.branch_id, before: { lineId: row.id, status: 'active' }, after: { lineId: row.id, status: 'removed', agreedKop }, reason }, clock);
  return toLineDto(r.rows[0]!);
}

export async function listLines(db: Db, eventId: string): Promise<EventLineDto[]> {
  const r = await db.query<LineRow>(`SELECT ${LINE_COLS} FROM app.event_lines WHERE event_id = $1 ORDER BY sort_order, id`, [eventId]);
  return r.rows.map(toLineDto);
}

/** Копия строк шаблона в мероприятие; цена шаблона разрешена и Администратору. Шаблон не меняется. */
export async function applyPackage(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventLineDto[]> {
  const input = parseBody(z.object({ packageId: z.string().regex(UUID_RE) }), raw);
  const e = await lockEvent(tx, ctx, eventId, 'event.manage');
  assertOpen(e);
  const p = await tx.query<{ type_id: string; status: string; lines: PackageLine[] }>('SELECT type_id, status, lines FROM app.event_packages WHERE id = $1', [input.packageId]);
  const pack = p.rows[0];
  if (!pack || pack.status !== 'active' || pack.type_id !== e.type_id) throw new AppError('VALIDATION_FAILED', 400, 'Пакет не подходит к этому мероприятию', { field: 'packageId' });
  const lines: EventLineDto[] = [];
  for (const l of pack.lines) lines.push(await insertLine(tx, e.id, { ...l, discountKop: 0 }));
  await tx.query('UPDATE app.events SET package_id = $2, row_version = row_version + 1 WHERE id = $1', [e.id, input.packageId]);
  const { agreedKop } = await agreedOf(tx, e.id);
  await writeAudit(tx, meta, { action: 'event.package_applied', object: { type: 'event', id: e.id }, branchId: e.branch_id, before: { packageId: e.package_id }, after: { packageId: input.packageId, lines: lines.length, agreedKop } }, clock);
  return lines;
}

// ---- справочники №370: архив вместо удаления

export interface EventPackageDto {
  id: string;
  typeId: string;
  name: string;
  lines: PackageLine[];
  approxPriceKop: number | null;
  status: 'active' | 'archived';
  rowVersion: number;
}

interface PackageRow {
  id: string;
  type_id: string;
  name: string;
  lines: PackageLine[];
  approx_price_kop: string | null;
  status: 'active' | 'archived';
  row_version: number;
}

const toPackageDto = (r: PackageRow): EventPackageDto => ({
  id: r.id, typeId: r.type_id, name: r.name, lines: r.lines, approxPriceKop: r.approx_price_kop === null ? null : Number(r.approx_price_kop), status: r.status, rowVersion: r.row_version,
});
const PACKAGE_COLS = 'id, type_id, name, lines, approx_price_kop, status, row_version';
const packageSchema = z.object({ typeId: z.string().regex(UUID_RE), name: Short, lines: z.array(packageLineSchema).max(100), approxPriceKop: Kop.nullish() });
const packagePatch = z.object({ rowVersion: z.number().int(), name: Short.optional(), lines: z.array(packageLineSchema).max(100).optional(), approxPriceKop: Kop.nullish(), status: z.enum(['active', 'archived']).optional() });

export async function listPackages(db: Db, opts: { typeId?: string | undefined; includeArchived?: boolean } = {}): Promise<EventPackageDto[]> {
  const r = await db.query<PackageRow>(
    `SELECT ${PACKAGE_COLS} FROM app.event_packages WHERE ($1::uuid IS NULL OR type_id = $1) AND ($2 OR status = 'active') ORDER BY name, id`,
    [opts.typeId ?? null, opts.includeArchived ?? false],
  );
  return r.rows.map(toPackageDto);
}

export async function createPackage(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventPackageDto> {
  assertCan(ctx, 'event.package.manage', { network: true });
  const input = parseBody(packageSchema, raw);
  const type = await tx.query(`SELECT 1 FROM app.event_types WHERE id = $1 AND status = 'active'`, [input.typeId]);
  if (type.rowCount !== 1) throw new AppError('VALIDATION_FAILED', 400, 'Тип мероприятия не найден', { field: 'typeId' });
  const r = await tx.query<PackageRow>(`INSERT INTO app.event_packages (type_id, name, lines, approx_price_kop) VALUES ($1, $2, $3, $4) RETURNING ${PACKAGE_COLS}`, [input.typeId, input.name, JSON.stringify(input.lines), input.approxPriceKop ?? null]);
  const dto = toPackageDto(r.rows[0]!);
  await writeAudit(tx, meta, { action: 'event.package.created', object: { type: 'event_package', id: dto.id }, after: { name: dto.name, typeId: dto.typeId, lines: dto.lines.length, approxPriceKop: dto.approxPriceKop } }, clock);
  return dto;
}

export async function updatePackage(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventPackageDto> {
  assertCan(ctx, 'event.package.manage', { network: true });
  const input = parseBody(packagePatch, raw);
  if (!UUID_RE.test(id)) throw notFound();
  const cur = (await tx.query<PackageRow>(`SELECT ${PACKAGE_COLS} FROM app.event_packages WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw notFound();
  if (cur.row_version !== input.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Пакет уже изменили – обновите страницу', { current: cur.row_version });
  const r = await tx.query<PackageRow>(
    `UPDATE app.event_packages SET name = $2, lines = $3, approx_price_kop = $4, status = $5, row_version = row_version + 1 WHERE id = $1 RETURNING ${PACKAGE_COLS}`,
    [id, input.name ?? cur.name, JSON.stringify(input.lines ?? cur.lines), input.approxPriceKop !== undefined ? input.approxPriceKop : cur.approx_price_kop, input.status ?? cur.status],
  );
  const dto = toPackageDto(r.rows[0]!);
  const before = toPackageDto(cur);
  const action = dto.status === 'archived' && before.status === 'active' ? 'event.package.archived' : 'event.package.updated';
  const diff = diffFields({ name: before.name, lines: before.lines, approxPriceKop: before.approxPriceKop, status: before.status }, { name: dto.name, lines: dto.lines, approxPriceKop: dto.approxPriceKop, status: dto.status });
  await writeAudit(tx, meta, { action, object: { type: 'event_package', id }, before: diff.before, after: diff.after }, clock);
  return dto;
}

export interface EventTypeDto {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'archived';
  rowVersion: number;
}
const toTypeDto = (r: { id: string; code: string; name: string; status: 'active' | 'archived'; row_version: number }): EventTypeDto => ({ id: r.id, code: r.code, name: r.name, status: r.status, rowVersion: r.row_version });
const typeSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]*$/).max(50), name: Short });
const typePatch = z.object({ rowVersion: z.number().int(), name: Short.optional(), status: z.enum(['active', 'archived']).optional() });
/** Типы, на которые завязан код: их нельзя архивировать (K20 §4, §8). */
const SYSTEM_TYPES = new Set(['birthday_party', 'birthday']);

export async function listEventTypes(db: Db): Promise<EventTypeDto[]> {
  const r = await db.query<{ id: string; code: string; name: string; status: 'active' | 'archived'; row_version: number }>(`SELECT id, code, name, status, row_version FROM app.event_types ORDER BY name, id`);
  return r.rows.map(toTypeDto);
}

export async function createEventType(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventTypeDto> {
  assertCan(ctx, 'event.type.manage', { network: true });
  const input = parseBody(typeSchema, raw);
  const r = await tx.query<{ id: string; code: string; name: string; status: 'active' | 'archived'; row_version: number }>(
    `INSERT INTO app.event_types (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING id, code, name, status, row_version`,
    [input.code, input.name],
  );
  if (!r.rows[0]) throw new AppError('VALIDATION_FAILED', 400, 'Такой код уже есть', { field: 'code' });
  await writeAudit(tx, meta, { action: 'event.type.created', object: { type: 'event_type', id: r.rows[0].id }, after: input }, clock);
  return toTypeDto(r.rows[0]);
}

export async function updateEventType(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventTypeDto> {
  assertCan(ctx, 'event.type.manage', { network: true });
  const input = parseBody(typePatch, raw);
  if (!UUID_RE.test(id)) throw notFound();
  const cur = (await tx.query<{ id: string; code: string; name: string; status: 'active' | 'archived'; row_version: number }>('SELECT id, code, name, status, row_version FROM app.event_types WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw notFound();
  if (cur.row_version !== input.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Тип уже изменили – обновите страницу', { current: cur.row_version });
  if (input.status === 'archived' && SYSTEM_TYPES.has(cur.code)) throw new AppError('VALIDATION_FAILED', 400, 'Этот тип нужен для праздника и подарка', { field: 'status' });
  const r = await tx.query<{ id: string; code: string; name: string; status: 'active' | 'archived'; row_version: number }>(
    `UPDATE app.event_types SET name = $2, status = $3, row_version = row_version + 1 WHERE id = $1 RETURNING id, code, name, status, row_version`,
    [id, input.name ?? cur.name, input.status ?? cur.status],
  );
  const diff = diffFields({ name: cur.name, status: cur.status }, { name: r.rows[0]!.name, status: r.rows[0]!.status });
  await writeAudit(tx, meta, { action: 'event.type.updated', object: { type: 'event_type', id }, before: diff.before, after: diff.after }, clock);
  return toTypeDto(r.rows[0]!);
}

