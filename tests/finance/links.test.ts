// S3-05: связи операций кассы с объектами Э3 (K17 §14) и возврат по поступлению (refundIncome).
// Одна операция – одна живая связь (гарантия – индекс 0301, 20 параллельных привязок → одна); роль по виду операции;
// сторнированная не привязывается; возврат не больше поступления; связи не меняют кассу (касса = операции, K17 §9).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { verifyBalance } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { postMoneyOperation, recordExpense, recordIncome, type FinanceOperationDto } from '../../apps/api/src/modules/finance/cashbox.ts';
import { correctOperation, reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { createLinkedOperation, linkOperation, linksOf, refundIncome, unlink } from '../../apps/api/src/modules/finance/links.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:00:00Z';
let otherCategory = '';

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return {
    actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() },
    role,
    network: role === 'owner',
    cityIds: new Set(),
    branchIds: new Set(branchIds),
    at: clock.now(),
  };
}
const owner = ctx('owner');
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

/** Новый филиал с разрешённым минусом кассы: остатки здесь не проверяются (это K17 §6), проверяются связи. */
async function newBranch(): Promise<string> {
  const id = (await createTestBranch(db.client)).id;
  await db.client.query(
    `INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`,
    [id, randomUUID()],
  );
  return id;
}
const income = (branchId: string, amountKop: number, method = 'cash', who = owner) =>
  tx((t) => recordIncome(t, who, { branchId, method, amountKop, source: 'event', occurredAt: AT, comment: 'предоплата праздника' }, meta(who), { idempotencyKey: randomUUID(), clock }));
const expense = (branchId: string, amountKop: number, who = owner) =>
  tx((t) =>
    recordExpense(t, who, { branchId, method: 'cash', amountKop, categoryId: otherCategory, occurredAt: AT, comment: 'запчасть' }, meta(who), { idempotencyKey: randomUUID(), clock }),
  );
const link = (operationId: string, ref: { type: 'event' | 'repair' | 'payroll_statement'; id: string }, role: 'income' | 'refund' | 'expense' | 'payout_expense', who = owner) =>
  tx((t) => linkOperation(t, who, { operationId, ref, role }, meta(who), clock));
const refund = (body: Record<string, unknown>, who = owner, key = randomUUID()) => tx((t) => refundIncome(t, who, body, meta(who), { idempotencyKey: key, clock }));
const liveLinks = async (operationId: string) =>
  Number((await db.client.query(`SELECT count(*) AS n FROM app.finance_operation_links WHERE operation_id = $1 AND unlinked_at IS NULL`, [operationId])).rows[0].n);
async function placeBalances(branchId: string): Promise<Array<{ ok: boolean; cached: number }>> {
  const r = await db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE owner_type = 'branch' AND owner_id = $1 ORDER BY kind`, [branchId]);
  return Promise.all(r.rows.map(async (a) => verifyBalance(db.client, a.id)));
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 24 });
  otherCategory = (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее' AND kind = 'expense'`)).rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('0301: схема', () => {
  it('вверх/вниз/вверх на чистой базе', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const later = await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0301'`);
      const down = await migrateDown(clean.client, later.rows[0]!.n);
      expect(down.at(-1)).toBe('0301');
      expect((await clean.client.query(`SELECT to_regclass('app.finance_operation_links') AS t`)).rows).toEqual([{ t: null }]);
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
      expect((await clean.client.query(`SELECT to_regclass('app.finance_operation_links')::text AS t`)).rows).toEqual([{ t: 'app.finance_operation_links' }]);
    } finally {
      await clean.drop();
    }
  });

  it('у yu_app меняются только поля отвязки; DELETE запрещён (42501)', async () => {
    const b = await newBranch();
    const op = await expense(b, 1000);
    await link(op.id, { type: 'repair', id: randomUUID() }, 'expense');
    const c = await pool.connect();
    try {
      await expect(c.query(`UPDATE app.finance_operation_links SET ref_id = gen_random_uuid() WHERE operation_id = $1`, [op.id])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`DELETE FROM app.finance_operation_links WHERE operation_id = $1`, [op.id])).rejects.toMatchObject({ code: '42501' });
    } finally {
      c.release();
    }
  });
});

describe('linkOperation', () => {
  it('связь видна в linksOf; повтор той же связи – без второй строки; к другому объекту – OPERATION_ALREADY_LINKED', async () => {
    const b = await newBranch();
    const op = await expense(b, 15_000);
    const repair = { type: 'repair' as const, id: randomUUID() };
    await link(op.id, repair, 'expense');
    await link(op.id, repair, 'expense'); // двойной клик
    expect(await liveLinks(op.id)).toBe(1);
    const links = await linksOf(pool, repair);
    expect(links.map((l) => [l.operation.id, l.role, l.inCost])).toEqual([[op.id, 'expense', false]]);
    const err = await fails(link(op.id, { type: 'event', id: randomUUID() }, 'expense'), 'OPERATION_ALREADY_LINKED');
    expect(err.details).toMatchObject({ ref: repair, role: 'expense' });
    await fails(link(op.id, { type: 'payroll_statement', id: randomUUID() }, 'payout_expense'), 'OPERATION_ALREADY_LINKED');
  });

  it('ревизия: исправление №45 связанной операции – OPERATION_ALREADY_LINKED, ни сторно, ни новой операции; сторно №44 и исправление после отвязки работают', async () => {
    const b = await newBranch();
    const op = await expense(b, 700);
    const event = { type: 'event' as const, id: randomUUID() };
    await link(op.id, event, 'expense');
    const fix = (operationId: string, key = randomUUID()) =>
      tx((t) => correctOperation(t, owner, { operationId, reason: 'ошибка суммы', replacement: { kind: 'expense', method: 'cash', amountKop: 800, categoryId: otherCategory, occurredAt: AT, comment: 'исправлено' } }, meta(owner), { idempotencyKey: key, clock }));
    const err = await fails(fix(op.id), 'OPERATION_ALREADY_LINKED');
    expect(err.details).toMatchObject({ ref: event, role: 'expense' });
    const count = async () => Number((await db.client.query('SELECT count(*) AS n FROM journal.finance_operations WHERE branch_id = $1', [b])).rows[0].n);
    const before = await count();
    await fails(fix(op.id), 'OPERATION_ALREADY_LINKED');
    expect(await count()).toBe(before);
    expect((await linksOf(pool, event)).map((l) => l.operation.id)).toEqual([op.id]);
    await tx((t) => unlink(t, owner, { operationId: op.id, reason: 'не то мероприятие' }, meta(owner), clock));
    const done = await fix(op.id);
    expect(done.replacement.amountKop).toBe(800);
  });

  it('ревизия: 20 гонок «привязка против исправления» – либо связь без сторно, либо сторно без связи; двойного учёта нет', async () => {
    const b = await newBranch();
    for (let i = 0; i < 20; i++) {
      const op = await expense(b, 100);
      const event = { type: 'event' as const, id: randomUUID() };
      const [linked, fixed] = await Promise.allSettled([
        link(op.id, event, 'expense'),
        tx((t) => correctOperation(t, owner, { operationId: op.id, reason: 'гонка', replacement: { kind: 'expense', method: 'cash', amountKop: 200, categoryId: otherCategory, occurredAt: AT, comment: 'гонка' } }, meta(owner), { idempotencyKey: randomUUID(), clock })),
      ]);
      expect([linked.status, fixed.status].filter((x) => x === 'fulfilled')).toHaveLength(1);
      const live = await linksOf(pool, event);
      expect(live.length).toBe(linked.status === 'fulfilled' ? 1 : 0);
    }
  });

  it('20 параллельных привязок одной операции к разным объектам → ровно одна связь (индекс базы)', async () => {
    const b = await newBranch();
    const op = await expense(b, 2_000);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => link(op.id, { type: 'event', id: randomUUID() }, 'expense')));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const codes = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as AppError).code] : []));
    expect(ok).toHaveLength(1);
    expect(new Set(codes)).toEqual(new Set(['OPERATION_ALREADY_LINKED']));
    expect(await liveLinks(op.id)).toBe(1);
  });

  it('роль не по виду операции и чужой источник прихода → OPERATION_LINK_INVALID', async () => {
    const b = await newBranch();
    const exp = await expense(b, 500);
    const inc = await income(b, 700);
    expect((await fails(link(exp.id, { type: 'event', id: randomUUID() }, 'income'), 'OPERATION_LINK_INVALID')).details).toEqual({ reason: 'role' });
    await fails(link(inc.id, { type: 'event', id: randomUUID() }, 'expense'), 'OPERATION_LINK_INVALID');
    await fails(link(inc.id, { type: 'event', id: randomUUID() }, 'refund'), 'OPERATION_LINK_INVALID');
    await fails(
      tx((t) => linkOperation(t, owner, { operationId: inc.id, ref: { type: 'event', id: randomUUID() }, role: 'income', inCost: true }, meta(owner), clock)),
      'OPERATION_LINK_INVALID',
    );
    const session = await tx((t) =>
      postMoneyOperation(t, owner, { branchId: b, kind: 'income', place: 'cash', method: 'cash', amountKop: 900, source: 'session', occurredAt: new Date(AT) }, { idempotencyKey: `t:${randomUUID()}` }, meta(owner), clock),
    );
    expect((await fails(link(session.id, { type: 'event', id: randomUUID() }, 'income'), 'OPERATION_LINK_INVALID')).details).toEqual({ reason: 'source' });
  });

  it('сторнированная операция не привязывается; сторно уже связанной убирает её из linksOf', async () => {
    const b = await newBranch();
    const a = await expense(b, 300);
    await tx((t) => reverseOperation(t, owner, { operationId: a.id, reason: 'ошибка' }, meta(owner), { idempotencyKey: randomUUID(), clock }));
    expect((await fails(link(a.id, { type: 'repair', id: randomUUID() }, 'expense'), 'OPERATION_LINK_INVALID')).details).toEqual({ reason: 'reversed' });

    const linked = await expense(b, 400);
    const repair = { type: 'repair' as const, id: randomUUID() };
    await link(linked.id, repair, 'expense');
    await tx((t) => reverseOperation(t, owner, { operationId: linked.id, reason: 'двойной ввод' }, meta(owner), { idempotencyKey: randomUUID(), clock }));
    expect(await linksOf(pool, repair)).toEqual([]);
  });

  it('филиал операции вне зоны → NOT_FOUND; связь не меняет кассу (касса = операции)', async () => {
    const b = await newBranch();
    const other = await newBranch();
    const op = await expense(b, 1_234);
    await fails(link(op.id, { type: 'repair', id: randomUUID() }, 'expense', ctx('admin', [other])), 'NOT_FOUND');
    const before = await placeBalances(b);
    await link(op.id, { type: 'repair', id: randomUUID() }, 'expense', ctx('admin', [b]));
    const after = await placeBalances(b);
    expect(after).toEqual(before);
    expect(after.every((x) => x.ok)).toBe(true);
    const ops = await db.client.query<{ n: string }>(`SELECT count(*) AS n FROM journal.finance_operations WHERE branch_id = $1`, [b]);
    expect(Number(ops.rows[0]!.n)).toBe(1);
  });

  it('createLinkedOperation: повтор с тем же ключом – одна операция и одна связь; права ручной формы', async () => {
    const b = await newBranch();
    const ev = { type: 'event' as const, id: randomUUID() };
    const key = randomUUID();
    const body = { branchId: b, method: 'card', amountKop: 3_000, categoryId: otherCategory, occurredAt: AT, comment: 'кейтеринг' };
    const run = (who: AccessContext) =>
      tx((t) => createLinkedOperation(t, who, { kind: 'expense', operation: body, link: { ref: ev, role: 'expense', inCost: true } }, meta(who), { idempotencyKey: key, clock }));
    const first = await run(owner);
    const again = await run(owner);
    expect(again.id).toBe(first.id);
    expect(await linksOf(pool, ev)).toMatchObject([{ operation: { id: first.id }, role: 'expense', inCost: true }]);
    await fails(
      tx((t) => createLinkedOperation(t, ctx('admin', [b]), { kind: 'income', operation: { ...body, source: 'event' }, link: { ref: ev, role: 'income' } }, meta(owner), { idempotencyKey: randomUUID(), clock })),
      'FORBIDDEN', // ручной доход Администратору нельзя (K17 §8)
    );
  });

  it('unlink: только finance.correct, причина обязательна; после отвязки операцию можно связать заново', async () => {
    const b = await newBranch();
    const op = await expense(b, 800);
    const wrong = { type: 'repair' as const, id: randomUUID() };
    await link(op.id, wrong, 'expense');
    const director = ctx('director', [b]);
    await fails(tx((t) => unlink(t, director, { operationId: op.id, reason: 'не тот ремонт' }, meta(director), clock)), 'FORBIDDEN');
    await fails(tx((t) => unlink(t, owner, { operationId: op.id, reason: ' ' }, meta(owner), clock)), 'COMMENT_REQUIRED');
    await tx((t) => unlink(t, owner, { operationId: op.id, reason: 'не тот ремонт' }, meta(owner), clock));
    expect(await linksOf(pool, wrong)).toEqual([]);
    const right = { type: 'repair' as const, id: randomUUID() };
    await link(op.id, right, 'expense');
    expect((await linksOf(pool, right)).map((l) => l.operation.id)).toEqual([op.id]);
    const audit = await db.client.query<{ action: string }>(`SELECT action FROM journal.audit_events WHERE object_id = $1 AND action LIKE 'finance.operation.%linked' ORDER BY id`, [op.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['finance.operation.linked', 'finance.operation.unlinked', 'finance.operation.linked']);
  });
});

describe('refundIncome', () => {
  it('возврат частями не больше поступления; остаток в details; возврат связывается с объектом поступления', async () => {
    const b = await newBranch();
    const inc = await income(b, 10_000, 'card');
    const ev = { type: 'event' as const, id: randomUUID() };
    await link(inc.id, ev, 'income');
    const r1 = await refund({ incomeOperationId: inc.id, amountKop: 6_000, method: 'cash', reason: 'отмена части меню' });
    expect(r1).toMatchObject({ kind: 'refund', place: 'cash', method: 'cash', amountKop: 6_000, ref: { type: 'operation', id: inc.id } });
    const err = await fails(refund({ incomeOperationId: inc.id, amountKop: 5_000, method: 'card', reason: 'ещё' }), 'EVENT_REFUND_EXCEEDS_INCOME');
    expect(err.details).toMatchObject({ availableKop: 4_000 });
    await refund({ incomeOperationId: inc.id, amountKop: 4_000, method: 'card', reason: 'остаток' });
    const links = await linksOf(pool, ev);
    expect(links.map((l) => [l.role, l.operation.amountKop]).sort()).toEqual([['income', 10_000], ['refund', 4_000], ['refund', 6_000]]);
  });

  it('повтор с тем же ключом – тот же возврат; параллельные возвраты не превышают поступление', async () => {
    const b = await newBranch();
    const inc = await income(b, 5_000);
    const key = randomUUID();
    const a = await refund({ incomeOperationId: inc.id, amountKop: 1_000, method: 'cash', reason: 'повтор' }, owner, key);
    const again = await refund({ incomeOperationId: inc.id, amountKop: 1_000, method: 'cash', reason: 'повтор' }, owner, key);
    expect(again.id).toBe(a.id);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => refund({ incomeOperationId: inc.id, amountKop: 1_000, method: 'cash', reason: 'гонка' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    const sum = await db.client.query<{ s: string }>(`SELECT sum(amount_kop) AS s FROM journal.finance_operations WHERE kind = 'refund' AND ref_id = $1`, [inc.id]);
    expect(Number(sum.rows[0]!.s)).toBe(5_000);
  });

  it('сеанс → USE_PAYMENT_REFUND; сторнированное поступление → OPERATION_REVERSED; расход → OPERATION_LINK_INVALID; Администратору – FORBIDDEN', async () => {
    const b = await newBranch();
    const session = await tx((t) =>
      postMoneyOperation(t, owner, { branchId: b, kind: 'income', place: 'cash', method: 'cash', amountKop: 900, source: 'session', occurredAt: new Date(AT) }, { idempotencyKey: `t:${randomUUID()}` }, meta(owner), clock),
    );
    await fails(refund({ incomeOperationId: session.id, amountKop: 100, method: 'cash', reason: 'x' }), 'USE_PAYMENT_REFUND');
    const inc: FinanceOperationDto = await income(b, 2_000);
    await tx((t) => reverseOperation(t, owner, { operationId: inc.id, reason: 'ошибка ввода' }, meta(owner), { idempotencyKey: randomUUID(), clock }));
    await fails(refund({ incomeOperationId: inc.id, amountKop: 100, method: 'cash', reason: 'x' }), 'OPERATION_REVERSED');
    const exp = await expense(b, 100);
    await fails(refund({ incomeOperationId: exp.id, amountKop: 100, method: 'cash', reason: 'x' }), 'OPERATION_LINK_INVALID');
    const live = await income(b, 1_000);
    await fails(refund({ incomeOperationId: live.id, amountKop: 100, method: 'cash', reason: 'x' }, ctx('admin', [b])), 'FORBIDDEN');
    await fails(refund({ incomeOperationId: live.id, amountKop: 100, method: 'cash', reason: '' }), 'COMMENT_REQUIRED');
  });
});
