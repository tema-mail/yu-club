// S2-12: категории доходов и расходов (K17 §5, 06 §7): два уровня, порядок, архив вместо удаления,
// подкатегория обязательна при наличии (06 §8), права finance.category.manage (только Владелец) и аудит.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  assertExpenseCategory,
  categoryDenialOf,
  createCategory,
  listCategories,
  updateCategory,
  type FinanceCategory,
} from '../../apps/api/src/modules/finance/categories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');

function ctx(role: StaffRole): AccessContext {
  return {
    actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() },
    role,
    network: role === 'owner',
    cityIds: new Set(),
    branchIds: new Set([randomUUID()]),
    at: clock.now(),
  };
}
const owner = ctx('owner');
const director = ctx('director');
const admin = ctx('admin');
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

const create = (body: Record<string, unknown>, who: AccessContext = owner) => tx((t) => createCategory(t, who, body, meta(who), clock));
const patch = (c: FinanceCategory, body: Record<string, unknown>, who: AccessContext = owner) =>
  tx((t) => updateCategory(t, who, c.id, { rowVersion: c.rowVersion, ...body }, meta(who), clock));
const byName = async (name: string) =>
  (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = $1`, [name])).rows[0]!.id;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 3 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('справочник', () => {
  it('дерево: стартовые категории расходов в порядке 06 §7.3, подкатегории внутри', async () => {
    const { items } = await listCategories(pool, admin, { kind: 'expense' });
    expect(items.map((c) => c.name)).toEqual([
      'Коммунальные', 'Аренда и содержание', 'Закупки и материалы', 'Персонал', 'Ремонт и обслуживание', 'Маркетинг', 'Подрядчики и услуги', 'Прочее',
    ]);
    expect(items[0]!.children.map((c) => c.name)).toEqual(['Электричество', 'Отопление', 'Вода', 'Вывоз мусора', 'Откачка ямы', 'Интернет']);
  });

  it('Владелец создаёт категорию и подкатегорию; порядок – в конец уровня; аудит', async () => {
    const cat = await create({ kind: 'expense', name: 'Связь' });
    expect(cat).toMatchObject({ kind: 'expense', parentId: null, status: 'active', sortOrder: 90, rowVersion: 1 });
    const sub = await create({ kind: 'expense', parentId: cat.id, name: 'Мобильная связь' });
    expect(sub).toMatchObject({ parentId: cat.id, sortOrder: 10 });
    const a = await db.client.query(`SELECT action, object_type FROM journal.audit_events WHERE object_id = $1`, [sub.id]);
    expect(a.rows).toEqual([{ action: 'finance.category.created', object_type: 'finance_category' }]);
  });

  it('третий уровень – отказ; подкатегория другого вида – отказ; дубль имени на уровне – отказ', async () => {
    const sub = await byName('Электричество');
    expect((await fails(create({ kind: 'expense', parentId: sub, name: 'Счётчик' }), 'VALIDATION_FAILED')).details).toMatchObject({ field: 'parentId' });
    const top = await byName('Коммунальные');
    await fails(create({ kind: 'income', parentId: top, name: 'Доход' }), 'VALIDATION_FAILED');
    await fails(create({ kind: 'expense', parentId: top, name: 'Вода' }), 'VALIDATION_FAILED');
  });

  it('Директор и Администратор не управляют справочником – FORBIDDEN, отказ для аудита', async () => {
    const err = await fails(create({ kind: 'expense', name: 'Чужая' }, director), 'FORBIDDEN');
    expect(categoryDenialOf(err)).toMatchObject({ action: 'finance.category.created', object: { type: 'finance_category', id: null } });
    await fails(create({ kind: 'expense', name: 'Чужая' }, admin), 'FORBIDDEN');
  });

  it('переименование и порядок; устаревший rowVersion – VERSION_CONFLICT', async () => {
    const cat = await create({ kind: 'income', name: 'Аренда зала' });
    const renamed = await patch(cat, { name: 'Аренда зала под праздник', sortOrder: 5 });
    expect(renamed).toMatchObject({ name: 'Аренда зала под праздник', sortOrder: 5, rowVersion: 2 });
    await fails(patch(cat, { name: 'снова' }), 'VERSION_CONFLICT');
    const a = await db.client.query(`SELECT action, before, after FROM journal.audit_events WHERE object_id = $1 AND action = 'finance.category.updated'`, [cat.id]);
    expect(a.rows).toEqual([
      { action: 'finance.category.updated', before: { name: 'Аренда зала', sortOrder: 10 }, after: { name: 'Аренда зала под праздник', sortOrder: 5 } },
    ]);
  });
});

describe('архив (06 §17 п.11)', () => {
  it('использованная категория – только архив: удаления нет, операции хранят её; архив уводит подкатегории', async () => {
    const cat = await create({ kind: 'expense', name: 'Охрана' });
    const sub = await create({ kind: 'expense', parentId: cat.id, name: 'Пульт' });
    const branch = await db.client.query<{ id: string }>(
      `WITH c AS (INSERT INTO app.cities (code, slug, name, timezone) VALUES ('t', 't', 't', 'Asia/Novosibirsk') RETURNING id)
       INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) SELECT id, 'b', 'b', 'b', 'адрес', 'Asia/Novosibirsk', 'active' FROM c RETURNING id`,
    );
    await db.client.query(
      `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, category_id, subcategory_id, comment, occurred_at, author_type, posting_id)
       VALUES ($1, 'expense', 'cash', 'cash', 'out', 100, $2, $3, 'пульт охраны', now(), 'system', gen_random_uuid())`,
      [branch.rows[0]!.id, cat.id, sub.id],
    );
    const archived = await patch(cat, { status: 'archived' });
    expect(archived.status).toBe('archived');
    const rows = await db.client.query(`SELECT name, status FROM app.finance_categories WHERE id IN ($1, $2) ORDER BY name`, [cat.id, sub.id]);
    expect(rows.rows).toEqual([
      { name: 'Охрана', status: 'archived' },
      { name: 'Пульт', status: 'archived' },
    ]);
    const op = await db.client.query(`SELECT category_id, subcategory_id FROM journal.finance_operations WHERE category_id = $1`, [cat.id]);
    expect(op.rows).toEqual([{ category_id: cat.id, subcategory_id: sub.id }]);
    const a = await db.client.query(`SELECT action, after FROM journal.audit_events WHERE object_id = $1 AND action = 'finance.category.archived'`, [cat.id]);
    expect(a.rows).toEqual([{ action: 'finance.category.archived', after: { status: 'archived', archivedChildren: [sub.id] } }]);
    // в списке по умолчанию архива нет, с includeArchived – есть
    expect((await listCategories(pool, admin, { kind: 'expense' })).items.map((c) => c.name)).not.toContain('Охрана');
    expect((await listCategories(pool, admin, { kind: 'expense', includeArchived: 'true' })).items.map((c) => c.name)).toContain('Охрана');
  });

  it('в архивную категорию нельзя добавить подкатегорию; подкатегорию не вернуть раньше категории', async () => {
    const cat = await create({ kind: 'expense', name: 'Старое' });
    const sub = await create({ kind: 'expense', parentId: cat.id, name: 'Старое-1' });
    const archived = await patch(cat, { status: 'archived' });
    await fails(create({ kind: 'expense', parentId: cat.id, name: 'Новое' }), 'CATEGORY_ARCHIVED');
    const subNow = (await listCategories(pool, owner, { includeArchived: true })).items.find((c) => c.id === cat.id)!.children[0]!;
    expect(subNow.id).toBe(sub.id);
    await fails(patch(subNow, { status: 'active' }), 'CATEGORY_ARCHIVED');
    const back = await patch(archived, { status: 'active' });
    expect(back.status).toBe('active');
  });
});

describe('категория расхода для операции', () => {
  it('подкатегория обязательна, если у категории есть активные (SUBCATEGORY_REQUIRED); у «Прочее» – нет', async () => {
    const top = await byName('Коммунальные');
    await fails(assertExpenseCategory(pool, top, null), 'SUBCATEGORY_REQUIRED');
    const sub = await byName('Электричество');
    expect(await assertExpenseCategory(pool, top, sub)).toEqual({ categoryId: top, subcategoryId: sub });
    const other = await byName('Прочее');
    expect(await assertExpenseCategory(pool, other, null)).toEqual({ categoryId: other, subcategoryId: null });
  });

  it('архивная категория или подкатегория – CATEGORY_ARCHIVED; чужая подкатегория и категория дохода – VALIDATION_FAILED', async () => {
    const cat = await create({ kind: 'expense', name: 'Сезонное' });
    const s1 = await create({ kind: 'expense', parentId: cat.id, name: 'Зима' });
    const s2 = await create({ kind: 'expense', parentId: cat.id, name: 'Лето' });
    await patch(s1, { status: 'archived' });
    await fails(assertExpenseCategory(pool, cat.id, s1.id), 'CATEGORY_ARCHIVED');
    expect(await assertExpenseCategory(pool, cat.id, s2.id)).toEqual({ categoryId: cat.id, subcategoryId: s2.id });
    await patch(s2, { status: 'archived' });
    // активных подкатегорий не осталось – подкатегория больше не обязательна
    expect(await assertExpenseCategory(pool, cat.id, null)).toEqual({ categoryId: cat.id, subcategoryId: null });
    await fails(assertExpenseCategory(pool, cat.id, await byName('Электричество')), 'VALIDATION_FAILED');
    const income = await create({ kind: 'income', name: 'Спонсоры' });
    await fails(assertExpenseCategory(pool, income.id, null), 'VALIDATION_FAILED');
    await fails(assertExpenseCategory(pool, s2.id, null), 'VALIDATION_FAILED'); // подкатегория вместо категории
    const archivedCat = await create({ kind: 'expense', name: 'Закрытое' });
    await patch(archivedCat, { status: 'archived' });
    await fails(assertExpenseCategory(pool, archivedCat.id, null), 'CATEGORY_ARCHIVED');
  });
});
