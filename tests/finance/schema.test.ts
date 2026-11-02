// S2-10: миграция 0202 – касса филиала (K17 §2–§6, model-dannyh 0202).
// Два места денег на филиал, третье – UNIQUE; операции кассы – только вставка; закрытый месяц не открыть;
// стартовый справочник 06 §7.3 засеян; вверх/вниз/вверх.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAccount, post, type AccountRef } from '../../apps/api/src/core/ledger.ts';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
let branchId: string;
const at = new Date('2026-11-15T07:00:00Z');

const code = (p: Promise<unknown>) => p.then(() => 'ok', (err: { code?: string }) => err.code ?? String(err));
const asApp = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};

/** Операция кассы владельцем миграций (без кода модуля): проводка K3 + заголовок. */
async function insertOperation(place: 'cash' | 'noncash', amount: number): Promise<string> {
  const ref: AccountRef = { kind: place === 'cash' ? 'cash_branch' : 'cash_branch_noncash', ownerType: 'branch', ownerId: branchId };
  await ensureAccount(db.client, ref, { unit: 'RUB_KOP', branchId, minBalance: null });
  const p = await post(db.client, {
    entries: [{ account: ref, amount, type: 'cash.income', branchId, occurredAt: at }],
    idempotencyKey: randomUUID(),
    author: { type: 'system', id: null },
  });
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, source, occurred_at, author_type, posting_id)
     VALUES ($1, 'income', $2, $3, 'in', $4, 'other', $5, 'system', $6) RETURNING id`,
    [branchId, place, place === 'cash' ? 'cash' : 'card', amount, at, p.postingId],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 3 });
  branchId = (await createTestBranch(db.client)).id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('0202: места денег', () => {
  it('у филиала два места денег (наличные и безнал); третье того же вида – UNIQUE', async () => {
    const cash = await asApp((c) => ensureAccount(c, { kind: 'cash_branch', ownerType: 'branch', ownerId: branchId }, { unit: 'RUB_KOP', branchId, minBalance: null }));
    const noncash = await asApp((c) =>
      ensureAccount(c, { kind: 'cash_branch_noncash', ownerType: 'branch', ownerId: branchId }, { unit: 'RUB_KOP', branchId, minBalance: null }),
    );
    expect(cash.id).not.toBe(noncash.id);
    const dup = asApp((c) =>
      c.query(`INSERT INTO app.ledger_accounts (kind, unit, branch_id, owner_type, owner_id) VALUES ('cash_branch_noncash', 'RUB_KOP', $1, 'branch', $1)`, [branchId]),
    );
    expect(await code(dup)).toBe('23505');
    const n = await db.client.query(`SELECT kind FROM app.ledger_accounts WHERE owner_id = $1 ORDER BY kind`, [branchId]);
    expect(n.rows.map((r) => r.kind)).toEqual(['cash_branch', 'cash_branch_noncash']);
  });

  it('безнал в баллах невозможен: CHECK вида и единицы счёта из 0004', async () => {
    const bad = db.client.query(
      `INSERT INTO app.ledger_accounts (kind, unit, branch_id, owner_type, owner_id) VALUES ('cash_branch_noncash', 'POINT_CENTI', $1, 'branch', gen_random_uuid())`,
      [branchId],
    );
    expect(await code(bad)).toBe('23514');
  });
});

describe('0202: операции кассы', () => {
  it('UPDATE и DELETE finance_operations от yu_app → 42501; вставка и чтение – можно', async () => {
    const id = await insertOperation('cash', 1000);
    expect(await code(asApp((c) => c.query(`UPDATE journal.finance_operations SET amount_kop = 1 WHERE id = $1`, [id])))).toBe('42501');
    expect(await code(asApp((c) => c.query(`DELETE FROM journal.finance_operations WHERE id = $1`, [id])))).toBe('42501');
    const r = await asApp((c) => c.query(`SELECT amount_kop FROM journal.finance_operations WHERE id = $1`, [id]));
    expect(r.rows).toEqual([{ amount_kop: '1000' }]);
    const v = await db.client.query('SELECT * FROM journal.append_only_violations()');
    expect(v.rows).toEqual([]);
  });

  it('второе сторно одной операции – UNIQUE (reversal_of); номер операции сквозной', async () => {
    const orig = await insertOperation('noncash', 500);
    const reversal = (postingId: string) =>
      db.client.query(
        `INSERT INTO journal.finance_operations (branch_id, kind, place, direction, amount_kop, comment, occurred_at, author_type, posting_id, reversal_of)
         VALUES ($1, 'reversal', 'noncash', 'out', 500, 'ошибка', $2, 'system', $3, $4)`,
        [branchId, at, postingId, orig],
      );
    await reversal(randomUUID());
    expect(await code(reversal(randomUUID()))).toBe('23505');
    const nums = await db.client.query<{ number: string }>(`SELECT number FROM journal.finance_operations ORDER BY number`);
    expect(nums.rows.map((r) => Number(r.number))).toEqual([1, 2, 3]);
  });

  it('CHECK: расход без категории и комментария, изъятие с безнала, карта на наличные – отклоняются', async () => {
    const ins = (kind: string, place: string, method: string | null, extra: { comment?: string; source?: string } = {}) =>
      db.client.query(
        `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, source, comment, occurred_at, author_type, posting_id)
         VALUES ($1, $2, $3, $4, 'out', 100, $5, $6, $7, 'system', gen_random_uuid())`,
        [branchId, kind, place, method, extra.source ?? null, extra.comment ?? null, at],
      );
    expect(await code(ins('expense', 'cash', 'cash', { comment: 'свет' }))).toBe('23514'); // без категории
    expect(await code(ins('withdrawal', 'cash', 'cash'))).toBe('23514'); // без комментария
    expect(await code(ins('withdrawal', 'noncash', null, { comment: 'изъятие' }))).toBe('23514');
    expect(await code(ins('income', 'cash', 'card', { source: 'other' }))).toBe('23514');
    expect(await code(ins('income', 'noncash', 'transfer'))).toBe('23514'); // доход без источника
  });

  it('начальный остаток: один действующий на место денег', async () => {
    const op1 = await insertOperation('cash', 100);
    const op2 = await insertOperation('cash', 200);
    const open = (op: string) =>
      db.client.query(`INSERT INTO app.finance_opening_balances (branch_id, place, operation_id, balance_date) VALUES ($1, 'cash', $2, '2026-11-01')`, [branchId, op]);
    await open(op1);
    expect(await code(open(op2))).toBe('23505');
    await db.client.query(`UPDATE app.finance_opening_balances SET status = 'reversed' WHERE operation_id = $1`, [op1]);
    await open(op2);
  });

  it('закрытый месяц: у yu_app нет UPDATE и DELETE; месяц – первое число', async () => {
    const owner = randomUUID();
    await asApp((c) => c.query(`INSERT INTO app.finance_periods (branch_id, month, closed_at, closed_by) VALUES ($1, '2026-10-01', $2, $3)`, [branchId, at, owner]));
    expect(await code(asApp((c) => c.query(`DELETE FROM app.finance_periods WHERE branch_id = $1`, [branchId])))).toBe('42501');
    expect(await code(asApp((c) => c.query(`UPDATE app.finance_periods SET closed_at = now() WHERE branch_id = $1`, [branchId])))).toBe('42501');
    const mid = asApp((c) => c.query(`INSERT INTO app.finance_periods (branch_id, month, closed_at, closed_by) VALUES ($1, '2026-09-15', $2, $3)`, [branchId, at, owner]));
    expect(await code(mid)).toBe('23514');
  });
});

describe('0202: категории', () => {
  it('стартовый справочник 06 §7.3: 8 категорий расходов, подкатегории по списку', async () => {
    const top = await db.client.query<{ name: string; n: number }>(
      `SELECT c.name, (SELECT count(*)::int FROM app.finance_categories s WHERE s.parent_id = c.id) AS n
       FROM app.finance_categories c WHERE c.parent_id IS NULL AND c.kind = 'expense' AND c.code IS NULL ORDER BY c.sort_order`, // системные (0210) – отдельно
    );
    expect(top.rows).toEqual([
      { name: 'Коммунальные', n: 6 },
      { name: 'Аренда и содержание', n: 3 },
      { name: 'Закупки и материалы', n: 4 },
      { name: 'Персонал', n: 3 },
      { name: 'Ремонт и обслуживание', n: 4 },
      { name: 'Маркетинг', n: 3 },
      { name: 'Подрядчики и услуги', n: 3 },
      { name: 'Прочее', n: 0 },
    ]);
    const sub = await db.client.query(
      `SELECT s.name FROM app.finance_categories s JOIN app.finance_categories c ON c.id = s.parent_id WHERE c.name = 'Коммунальные' ORDER BY s.sort_order`,
    );
    expect(sub.rows.map((r) => r.name)).toEqual(['Электричество', 'Отопление', 'Вода', 'Вывоз мусора', 'Откачка ямы', 'Интернет']);
  });

  it('третий уровень и подкатегория другого вида – отказ триггером', async () => {
    const sub = await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Электричество'`);
    const third = asApp((c) => c.query(`INSERT INTO app.finance_categories (kind, parent_id, name) VALUES ('expense', $1, 'Счётчик')`, [sub.rows[0]!.id]));
    expect(await third.catch((e: { constraint?: string }) => e.constraint)).toBe('finance_categories_depth');
    const top = await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Коммунальные'`);
    const wrongKind = asApp((c) => c.query(`INSERT INTO app.finance_categories (kind, parent_id, name) VALUES ('income', $1, 'Доход')`, [top.rows[0]!.id]));
    expect(await wrongKind.catch((e: { constraint?: string }) => e.constraint)).toBe('finance_categories_kind');
    // категория с подкатегориями не может стать подкатегорией
    const other = await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Маркетинг'`);
    const nest = asApp((c) => c.query(`UPDATE app.finance_categories SET parent_id = $1 WHERE id = $2`, [other.rows[0]!.id, top.rows[0]!.id]));
    expect(await nest.catch((e: { constraint?: string }) => e.constraint)).toBe('finance_categories_depth');
  });

  it('использованную категорию удалить нельзя (FK из операции)', async () => {
    const cat = await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее'`);
    await db.client.query(
      `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, category_id, comment, occurred_at, author_type, posting_id)
       VALUES ($1, 'expense', 'cash', 'cash', 'out', 100, $2, 'мелочи', $3, 'system', gen_random_uuid())`,
      [branchId, cat.rows[0]!.id, at],
    );
    expect(await code(asApp((c) => c.query(`DELETE FROM app.finance_categories WHERE id = $1`, [cat.rows[0]!.id])))).toBe('23503');
  });
});

describe('0202: вверх/вниз/вверх', () => {
  it('на чистой базе: вниз убирает таблицы и вид безнала, вверх возвращает', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      // Откат до 0202 включительно (младшие миграции Э2 – первыми), потом все обратно.
      const later = await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0202'`);
      const down = await migrateDown(clean.client, later.rows[0]!.n);
      expect(down.at(-1)).toBe('0202');
      const t = await clean.client.query(`SELECT to_regclass('journal.finance_operations') AS fo, to_regclass('app.finance_categories') AS fc`);
      expect(t.rows).toEqual([{ fo: null, fc: null }]);
      const noncash = clean.client.query(
        `INSERT INTO app.ledger_accounts (kind, unit, owner_type, owner_id) VALUES ('cash_branch_noncash', 'RUB_KOP', 'branch', gen_random_uuid())`,
      );
      expect(await code(noncash)).toBe('23514');
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
      const n = await clean.client.query(`SELECT count(*)::int AS n FROM app.finance_categories`);
      expect(n.rows[0].n).toBe(36); // 34 стартовых (0202) + 2 системных (0210)
    } finally {
      await clean.drop();
    }
  });
});
