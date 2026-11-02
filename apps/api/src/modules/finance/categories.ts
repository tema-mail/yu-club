// S2-12. Категории доходов и расходов (K17 §5, 06 §7): справочник сети, два уровня (категория и подкатегория),
// порядок, архив вместо удаления. Управляет Владелец (finance.category.manage), выбирают все, у кого есть касса.
// Третий уровень и подкатегория другого вида запрещены и здесь, и триггером 0202 (finance_categories_depth/_kind).
// assertExpenseCategory – проверка категории расхода для cashbox.ts: архив → CATEGORY_ARCHIVED, у категории есть
// активные подкатегории, а подкатегория не выбрана → SUBCATEGORY_REQUIRED (06 §8, §13.4).
import { z } from 'zod';
import { writeAudit, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';

export type CategoryKind = 'income' | 'expense';
export type CategoryStatus = 'active' | 'archived';

export interface FinanceCategory {
  id: string;
  kind: CategoryKind;
  parentId: string | null;
  name: string;
  sortOrder: number;
  status: CategoryStatus;
  rowVersion: number;
}

export interface CategoryNode extends FinanceCategory {
  children: FinanceCategory[];
}

interface CategoryRow {
  id: string;
  kind: CategoryKind;
  parent_id: string | null;
  name: string;
  sort_order: number;
  status: CategoryStatus;
  row_version: number;
}

const COLUMNS = 'id, kind, parent_id, name, sort_order, status, row_version';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toCategory = (r: CategoryRow): FinanceCategory => ({
  id: r.id,
  kind: r.kind,
  parentId: r.parent_id,
  name: r.name,
  sortOrder: r.sort_order,
  status: r.status,
  rowVersion: r.row_version,
});

// ---- права: справочник сетевой – цель { network: true }; отказ – в аудит отдельной транзакцией (ADR 0005 п.8)

export interface Denial {
  action: AuditAction;
  object: { type: AuditObjectType; id: string | null };
  branchId: string | null;
  cityId: string | null;
  reason: string;
}
const DENIALS = new WeakMap<AppError, Denial>();
export const categoryDenialOf = (err: unknown): Denial | undefined => (err instanceof AppError ? DENIALS.get(err) : undefined);

function guardManage(ctx: AccessContext, action: AuditAction, id: string | null): void {
  if (roleAllows(ctx.role, 'finance.category.manage')) return;
  const err = new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'finance.category.manage' });
  DENIALS.set(err, { action, object: { type: 'finance_category', id }, branchId: null, cityId: null, reason: 'FORBIDDEN: finance.category.manage' });
  throw err;
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

const NAME = z.string().trim().min(1).max(200);
const ORDER = z.number().int().min(-1_000_000).max(1_000_000);

const createSchema = z.object({
  kind: z.enum(['income', 'expense']),
  parentId: z.string().regex(UUID_RE).nullable().default(null),
  name: NAME,
  sortOrder: ORDER.optional(),
});

const patchSchema = z
  .object({
    rowVersion: z.number().int().min(1),
    name: NAME.optional(),
    sortOrder: ORDER.optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((p) => p.name !== undefined || p.sortOrder !== undefined || p.status !== undefined, { message: 'Нечего менять' });

const listSchema = z.object({
  kind: z.enum(['income', 'expense']).optional(),
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .default(false),
});

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const thirdLevel = () => new AppError('VALIDATION_FAILED', 400, 'Третьего уровня категорий нет', { field: 'parentId' });

/** Дубль имени на уровне, гонка с триггером глубины – понятные коды вместо сырых ошибок базы. */
function dbError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505') throw new AppError('VALIDATION_FAILED', 400, 'Такое имя уже есть на этом уровне', { field: 'name' });
  if (e.code === '23514' && e.constraint === 'finance_categories_depth') throw thirdLevel();
  if (e.code === '23514' && e.constraint === 'finance_categories_kind') {
    throw new AppError('VALIDATION_FAILED', 400, 'Подкатегория того же вида, что и категория', { field: 'kind' });
  }
  throw err;
}

async function loadCategory(db: Db | Tx, id: string, lock = false): Promise<FinanceCategory | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<CategoryRow>(`SELECT ${COLUMNS} FROM app.finance_categories WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ? toCategory(r.rows[0]) : null;
}

// ---- чтение

/** Дерево справочника (K17 №46): верхний уровень и подкатегории по sort_order, затем имени.
 *  Читать могут все, у кого есть касса (finance.view.day); архив – по запросу. */
export async function listCategories(db: Db, ctx: AccessContext, raw: unknown): Promise<{ items: CategoryNode[] }> {
  if (!roleAllows(ctx.role, 'finance.view.day')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'finance.view.day' });
  const q = parse(listSchema, raw);
  const r = await db.query<CategoryRow>(
    `SELECT ${COLUMNS} FROM app.finance_categories
     WHERE ($1::text IS NULL OR kind = $1) AND ($2 OR status = 'active')
     ORDER BY sort_order, name, id`,
    [q.kind ?? null, q.includeArchived],
  );
  const all = r.rows.map(toCategory);
  const children = new Map<string, FinanceCategory[]>();
  for (const c of all) if (c.parentId) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
  return { items: all.filter((c) => c.parentId === null).map((c) => ({ ...c, children: children.get(c.id) ?? [] })) };
}

// ---- команды (транзакцию открывает вызывающий)

export async function createCategory(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<FinanceCategory> {
  guardManage(ctx, 'finance.category.created', null);
  const input = parse(createSchema, raw);
  if (input.parentId !== null) {
    // Родитель под блокировкой: параллельное «сделать его подкатегорией» не обойдёт проверку глубины.
    const parent = await loadCategory(tx, input.parentId, true);
    if (!parent) throw new AppError('VALIDATION_FAILED', 400, 'Нет такой категории', { field: 'parentId' });
    if (parent.parentId !== null) throw thirdLevel();
    if (parent.kind !== input.kind) throw new AppError('VALIDATION_FAILED', 400, 'Подкатегория того же вида, что и категория', { field: 'kind' });
    if (parent.status === 'archived') throw new AppError('CATEGORY_ARCHIVED', 422, 'Категория в архиве', { categoryId: parent.id });
  }
  const order =
    input.sortOrder ??
    Number(
      (
        await tx.query<{ next: number }>(
          `SELECT coalesce(max(sort_order), 0) + 10 AS next FROM app.finance_categories WHERE kind = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND code IS NULL`, // системные (0210) – в конце, порядок не задают
          [input.kind, input.parentId],
        )
      ).rows[0]!.next,
    );
  const r = await tx
    .query<CategoryRow>(`INSERT INTO app.finance_categories (kind, parent_id, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`, [
      input.kind,
      input.parentId,
      input.name,
      order,
    ])
    .catch(dbError);
  const c = toCategory(r.rows[0]!);
  await writeAudit(tx, meta, { action: 'finance.category.created', object: { type: 'finance_category', id: c.id }, after: c }, clock);
  return c;
}

/** Имя, порядок, архив и возврат из архива (K17 №46 PATCH). Удаления нет: использованная категория остаётся
 *  у своих операций навсегда (06 §7.2). Архив категории уводит в архив и её активные подкатегории. */
export async function updateCategory(
  tx: Tx,
  ctx: AccessContext,
  id: string,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<FinanceCategory> {
  const p = parse(patchSchema, raw);
  const action: AuditAction = p.status === 'archived' ? 'finance.category.archived' : 'finance.category.updated';
  guardManage(ctx, action, UUID_RE.test(id) ? id : null);
  const before = await loadCategory(tx, id, true);
  if (!before) throw notFound();
  if (before.rowVersion !== p.rowVersion) {
    throw new AppError('VERSION_CONFLICT', 409, 'Категорию уже изменили', { rowVersion: before.rowVersion });
  }
  if (p.status === 'active' && before.status === 'archived' && before.parentId) {
    const parent = await loadCategory(tx, before.parentId);
    if (parent?.status === 'archived') throw new AppError('CATEGORY_ARCHIVED', 422, 'Сначала верните из архива категорию', { categoryId: parent.id });
  }
  const r = await tx
    .query<CategoryRow>(
      `UPDATE app.finance_categories SET name = $2, sort_order = $3, status = $4, row_version = row_version + 1
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [before.id, p.name ?? before.name, p.sortOrder ?? before.sortOrder, p.status ?? before.status],
    )
    .catch(dbError);
  const after = toCategory(r.rows[0]!);
  let archivedChildren: string[] = [];
  if (p.status === 'archived' && before.status === 'active' && before.parentId === null) {
    const ch = await tx.query<{ id: string }>(
      `UPDATE app.finance_categories SET status = 'archived', row_version = row_version + 1 WHERE parent_id = $1 AND status = 'active' RETURNING id`,
      [before.id],
    );
    archivedChildren = ch.rows.map((x) => x.id).sort();
  }
  const changed = (['name', 'sortOrder', 'status'] as const).filter((k) => before[k] !== after[k]);
  if (changed.length > 0) {
    await writeAudit(
      tx,
      meta,
      {
        action: after.status === 'archived' && before.status === 'active' ? 'finance.category.archived' : 'finance.category.updated',
        object: { type: 'finance_category', id: after.id },
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: { ...Object.fromEntries(changed.map((k) => [k, after[k]])), ...(archivedChildren.length > 0 ? { archivedChildren } : {}) },
      },
      clock,
    );
  }
  return after;
}

// ---- проверка для операций кассы

/** Категория расхода (K17 §5): верхнего уровня, вида expense, не в архиве; подкатегория – её, не в архиве;
 *  у категории есть активные подкатегории, а подкатегория не выбрана → SUBCATEGORY_REQUIRED. */
export async function assertExpenseCategory(
  db: Db | Tx,
  categoryId: string,
  subcategoryId: string | null,
): Promise<{ categoryId: string; subcategoryId: string | null }> {
  const cat = await loadCategory(db, categoryId);
  if (!cat || cat.kind !== 'expense' || cat.parentId !== null) {
    throw new AppError('VALIDATION_FAILED', 400, 'Нет такой категории расхода', { field: 'categoryId' });
  }
  if (cat.status === 'archived') throw new AppError('CATEGORY_ARCHIVED', 422, 'Категория в архиве', { categoryId: cat.id });
  if (subcategoryId !== null) {
    const sub = await loadCategory(db, subcategoryId);
    if (!sub || sub.parentId !== cat.id) throw new AppError('VALIDATION_FAILED', 400, 'Подкатегория не из этой категории', { field: 'subcategoryId' });
    if (sub.status === 'archived') throw new AppError('CATEGORY_ARCHIVED', 422, 'Подкатегория в архиве', { categoryId: sub.id });
    return { categoryId: cat.id, subcategoryId: sub.id };
  }
  const has = await db.query(`SELECT 1 FROM app.finance_categories WHERE parent_id = $1 AND status = 'active' LIMIT 1`, [cat.id]);
  if (has.rows.length > 0) throw new AppError('SUBCATEGORY_REQUIRED', 422, 'Выберите подкатегорию', { categoryId: cat.id });
  return { categoryId: cat.id, subcategoryId: null };
}
