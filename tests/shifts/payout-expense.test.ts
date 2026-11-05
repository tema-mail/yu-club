// S3-19: расход при выплате K18 §9, TC-19: двойной клик → одна связь, сумма операций = toPayKop, копейки остатка – филиалу с большей долей;
// параллельные выплаты с пересекающимися филиалами без deadlock; PAYOUT_EXPENSE_EXISTS; сторно в кассе → можно заново; привязка ручного расхода.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { recordExpense } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { linksOf } from '../../apps/api/src/modules/finance/links.ts';
import { createPayoutExpense, linkPayoutExpense, splitByBranch } from '../../apps/api/src/modules/shifts/payout-expense.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:00:00Z';
let a = '';
let b = '';
let salary = { categoryId: '', subcategoryId: '' };

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() };
}
const owner = ctx('owner');
const meta = (c: AccessContext = owner): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

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
async function newBranch(): Promise<string> {
  const id = (await createTestBranch(db.client)).id;
  await db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`, [id, randomUUID()]);
  return id;
}
/** Ведомость в нужном статусе: снимок итогов задан прямо, расчёт проверяет payroll.test.ts. */
async function statement(toPayKop: number, byBranch: Array<{ branchId: string; accruedKop: number }>, status = 'paid'): Promise<string> {
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  const p = await db.client.query<{ id: string }>(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) SELECT d, d, 'closed', now() FROM (SELECT coalesce(max(date_to), '2020-01-01'::date) + 1 AS d FROM app.payroll_periods) x RETURNING id`);
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.payroll_statements (period_id, staff_id, status, totals, actual_payout_date) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [p.rows[0]!.id, s.rows[0]!.id, status, JSON.stringify({ toPayKop, byBranch: byBranch.map((l) => ({ ...l, workedShifts: 1, paidMinutes: 60 })) }), status === 'paid' ? '2026-11-14' : null],
  );
  return r.rows[0]!.id;
}
const create = (id: string, extra: Record<string, unknown> = {}, who = owner, key = randomUUID()) =>
  tx((t) => createPayoutExpense(t, who, id, { place: 'cash', method: 'cash', split: 'by_branch', occurredAt: AT, ...extra }, meta(who), { idempotencyKey: key, clock }));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 24 });
  a = await newBranch();
  b = await newBranch();
  const r = await db.client.query<{ id: string; parent_id: string }>(`SELECT sub.id, sub.parent_id FROM app.finance_categories sub JOIN app.finance_categories c ON c.id = sub.parent_id WHERE c.name = 'Персонал' AND sub.name = 'Зарплата'`);
  salary = { categoryId: r.rows[0]!.parent_id, subcategoryId: r.rows[0]!.id };
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('splitByBranch', () => {
  it('пропорция, остаток – филиалу с большей долей, сумма = toPay; пустые филиалы не участвуют', () => {
    const lines = (x: Array<[string, number]>) => x.map(([branchId, accruedKop]) => ({ branchId, accruedKop, workedShifts: 1, paidMinutes: 1 }));
    expect(splitByBranch(100, lines([['b', 1], ['a', 2]]))).toEqual([{ branchId: 'a', amountKop: 67 }, { branchId: 'b', amountKop: 33 }]);
    expect(splitByBranch(1, lines([['a', 1], ['b', 1]]))).toEqual([{ branchId: 'a', amountKop: 1 }]);
    expect(splitByBranch(100, lines([['a', 0]]))).toEqual([]);
    expect(splitByBranch(1000, lines([['a', 3], ['b', 3], ['c', 3]])).reduce((s, p) => s + p.amountKop, 0)).toBe(1000);
  });
});

describe('createPayoutExpense', () => {
  it('TC-19: по филиалам; расход категории Персонал/Зарплата со ссылкой на сотрудника; сумма = toPayKop; копейки – филиалу с большей долей', async () => {
    const st = await statement(100_001, [{ branchId: a, accruedKop: 200_000 }, { branchId: b, accruedKop: 100_000 }]);
    const { operations } = await create(st);
    expect(new Map(operations.map((o) => [o.branchId, o.amountKop]))).toEqual(new Map([[a, 66_668], [b, 33_333]]));
    expect(operations.reduce((s, o) => s + o.amountKop, 0)).toBe(100_001);
    for (const o of operations) expect(o).toMatchObject({ kind: 'expense', method: 'cash', ...salary, ref: { type: 'staff' } });
    const links = await linksOf(pool, { type: 'payroll_statement', id: st });
    expect(links.map((l) => l.role)).toEqual(['payout_expense', 'payout_expense']);
    const audit = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'payroll.payout_expense.created' AND object_id = $1`, [st]);
    expect(audit.rows).toHaveLength(1);
  });

  it('из одного филиала; второй вызов – PAYOUT_EXPENSE_EXISTS с id операций', async () => {
    const st = await statement(50_000, [{ branchId: a, accruedKop: 50_000 }]);
    const { operations } = await create(st, { split: { branchId: b }, method: 'card', place: 'noncash' });
    expect(operations.map((o) => [o.branchId, o.amountKop, o.place])).toEqual([[b, 50_000, 'noncash']]);
    const err = await create(st).catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'PAYOUT_EXPENSE_EXISTS', details: { operationIds: [operations[0]!.id] } });
  });

  it('двойной клик параллельно (10 раз): одна связь и сумма = toPayKop, в том числе при разных формах', async () => {
    const st = await statement(90_000, [{ branchId: a, accruedKop: 60_000 }, { branchId: b, accruedKop: 30_000 }]);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => create(st, i % 2 ? { split: { branchId: a } } : {})));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as AppError).code).toBe('PAYOUT_EXPENSE_EXISTS');
    const links = await linksOf(pool, { type: 'payroll_statement', id: st });
    expect(links.reduce((s, l) => s + l.operation.amountKop, 0)).toBe(90_000);
  });

  it('две параллельные выплаты с пересекающимися филиалами в разном порядке – обе проходят, без deadlock (20 пар)', async () => {
    for (let i = 0; i < 20; i++) {
      const s1 = await statement(30_000, [{ branchId: a, accruedKop: 2 }, { branchId: b, accruedKop: 1 }]);
      const s2 = await statement(30_000, [{ branchId: b, accruedKop: 2 }, { branchId: a, accruedKop: 1 }]);
      const [one, two] = await Promise.all([create(s1), create(s2)]);
      expect(one.operations).toHaveLength(2);
      expect(two.operations).toHaveLength(2);
    }
  });

  it('сторно расхода в кассе → можно создать заново', async () => {
    const st = await statement(20_000, [{ branchId: a, accruedKop: 20_000 }]);
    const { operations } = await create(st);
    await tx((t) => reverseOperation(t, owner, { operationId: operations[0]!.id, reason: 'ошибка кассы' }, meta(), { idempotencyKey: randomUUID(), clock }));
    expect(await linksOf(pool, { type: 'payroll_statement', id: st })).toEqual([]);
    const again = await create(st);
    expect(again.operations.map((o) => o.amountKop)).toEqual([20_000]);
    expect((await linksOf(pool, { type: 'payroll_statement', id: st })).map((l) => l.operation.id)).toEqual([again.operations[0]!.id]);
  });

  it('без paid – отказ; нечего платить – отказ; нет филиалов в разбивке – BRANCH_REQUIRED; Директор – 403, чужая ведомость – 404', async () => {
    const ready = await statement(10_000, [{ branchId: a, accruedKop: 10_000 }], 'ready');
    await expect(create(ready)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'statement_not_paid' } });
    const zero = await statement(0, [{ branchId: a, accruedKop: 0 }]);
    await expect(create(zero)).rejects.toMatchObject({ details: { reason: 'nothing_paid' } });
    const noLines = await statement(10_000, []);
    await expect(create(noLines)).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' });
    const st = await statement(10_000, [{ branchId: a, accruedKop: 10_000 }]);
    await expect(create(st, {}, ctx('director', [a]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(create(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(create(st, { method: 'card', place: 'cash' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('linkPayoutExpense', () => {
  const manual = (branchId: string, amountKop: number) =>
    tx((t) => recordExpense(t, owner, { branchId, method: 'cash', amountKop, ...salary, occurredAt: AT, comment: 'зарплата вручную' }, meta(), { idempotencyKey: randomUUID(), clock }));
  const link = (st: string, operationIds: string[]) => tx((t) => linkPayoutExpense(t, owner, st, { operationIds }, meta(), clock));

  it('сумма совпала – привязан, второго расхода нет; другая сумма – PAYOUT_AMOUNT_MISMATCH', async () => {
    const st = await statement(40_000, [{ branchId: a, accruedKop: 40_000 }]);
    const wrong = await manual(a, 39_000);
    await expect(link(st, [wrong.id])).rejects.toMatchObject({ code: 'PAYOUT_AMOUNT_MISMATCH' });
    const op = await manual(a, 40_000);
    const res = await link(st, [op.id]);
    expect(res.operations.map((o) => o.id)).toEqual([op.id]);
    await expect(create(st)).rejects.toMatchObject({ code: 'PAYOUT_EXPENSE_EXISTS' });
    await expect(link(st, [op.id])).rejects.toMatchObject({ code: 'PAYOUT_EXPENSE_EXISTS' });
  });

  it('операция уже связана с другим объектом – OPERATION_ALREADY_LINKED; без paid – отказ', async () => {
    const st1 = await statement(5_000, [{ branchId: a, accruedKop: 5_000 }]);
    const st2 = await statement(5_000, [{ branchId: a, accruedKop: 5_000 }]);
    const op = await manual(a, 5_000);
    await link(st1, [op.id]);
    await expect(link(st2, [op.id])).rejects.toMatchObject({ code: 'OPERATION_ALREADY_LINKED' });
    const ready = await statement(5_000, [{ branchId: a, accruedKop: 5_000 }], 'ready');
    await expect(link(ready, [op.id])).rejects.toMatchObject({ details: { reason: 'statement_not_paid' } });
  });
});
