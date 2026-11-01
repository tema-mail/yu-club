// S2-13: сторно, исправление, закрытие месяца (K17 §4, §6; 06 §17 п.15; 18 §6.3 п.10).
// Исходная операция цела; второе сторно – ALREADY_REVERSED (и в гонке – UNIQUE); операция в закрытом месяце –
// PERIOD_CLOSED; приход по сеансу и от продажи сертификата – USE_PAYMENT_REFUND / USE_CERTIFICATE_CANCEL;
// сторно прихода, уводящее место в минус при запрете, – CASH_INSUFFICIENT.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  getOperation,
  postMoneyOperation,
  recordExpense,
  recordIncome,
  recordOpeningBalance,
  transferBetweenPlaces,
  type FinanceOperationDto,
} from '../../apps/api/src/modules/finance/cashbox.ts';
import { closeMonth, correctOperation, reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:00:00Z';
let otherCat: string;

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

const run = <T>(cmd: (t: pg.PoolClient, c: AccessContext, raw: unknown, m: AuditRequestMeta, o: { idempotencyKey: string; clock: typeof clock }) => Promise<T>,
  body: Record<string, unknown>, who: AccessContext = owner, key = randomUUID()) => tx((t) => cmd(t, who, body, meta(who), { idempotencyKey: key, clock }));
const income = (branchId: string, amountKop: number, method = 'cash') => run(recordIncome, { branchId, method, amountKop, source: 'other', occurredAt: AT });
const balances = async (branchId: string) => {
  const r = await db.client.query<{ kind: string; balance: string }>(`SELECT kind, balance FROM app.ledger_accounts WHERE owner_id = $1`, [branchId]);
  const by = new Map(r.rows.map((x) => [x.kind, Number(x.balance)]));
  return { cash: by.get('cash_branch') ?? 0, noncash: by.get('cash_branch_noncash') ?? 0 };
};
const newBranch = async () => (await createTestBranch(db.client)).id;

/** Приход чужого модуля (K10 оплата, K16 продажа) – системным автором через ядро кассы. */
const foreignIncome = (branchId: string, source: 'session' | 'certificate_sale') =>
  tx((t) =>
    postMoneyOperation(
      t,
      { kind: 'system', process: 'test' },
      {
        branchId, kind: 'income', place: 'cash', method: 'cash', amountKop: 10_000, source,
        ref: source === 'session' ? { type: 'payment', id: randomUUID() } : { type: 'certificate', id: randomUUID() }, occurredAt: new Date(AT),
      },
      { idempotencyKey: randomUUID() },
      { actor: { kind: 'system', process: 'test' }, source: 'system', requestId: randomUUID() },
      clock,
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  otherCat = (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее'`)).rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('сторно', () => {
  it('исходная операция цела, сторно – новая со ссылкой и причиной; остаток вернулся; второе – ALREADY_REVERSED', async () => {
    const b = await newBranch();
    await income(b, 5_000);
    const exp = await run(recordExpense, { branchId: b, method: 'cash', amountKop: 1_200, categoryId: otherCat, occurredAt: AT, comment: 'лишний чек' });
    const rev = await run(reverseOperation, { operationId: exp.id, reason: 'внесли дважды' });
    expect(rev).toMatchObject({ kind: 'reversal', place: 'cash', direction: 'in', amountKop: 1_200, reversalOf: exp.id, comment: 'внесли дважды', ref: { type: 'operation', id: exp.id } });
    expect(rev.occurredAt).toBe(clock.now().toISOString());
    const orig = (await getOperation(db.client, exp.id))!;
    expect({ ...orig, reversedBy: null }).toEqual(exp); // исходная не изменилась, кроме ссылки на сторно
    expect(orig.reversedBy).toBe(rev.id);
    expect((await balances(b)).cash).toBe(5_000);
    await fails(run(reverseOperation, { operationId: exp.id, reason: 'ещё раз' }), 'ALREADY_REVERSED');
    await fails(run(reverseOperation, { operationId: rev.id, reason: 'сторно сторно' }), 'CANNOT_REVERSE_REVERSAL');
    await fails(run(reverseOperation, { operationId: exp.id }), 'COMMENT_REQUIRED');
    const a = await db.client.query(`SELECT action, reason FROM journal.audit_events WHERE object_id = $1 AND action = 'finance.operation.reversed'`, [exp.id]);
    expect(a.rows).toEqual([{ action: 'finance.operation.reversed', reason: 'внесли дважды' }]);
  });

  it('гонка: 8 параллельных сторно одной операции – одно проходит, остальные ALREADY_REVERSED', async () => {
    const b = await newBranch();
    const inc = await income(b, 3_000);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => run(reverseOperation, { operationId: inc.id, reason: 'ошибка' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const codes = results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as AppError).code);
    expect(new Set(codes)).toEqual(new Set(['ALREADY_REVERSED']));
    expect((await balances(b)).cash).toBe(0);
  });

  it('повтор с тем же ключом – то же сторно', async () => {
    const b = await newBranch();
    const inc = await income(b, 1_000);
    const key = randomUUID();
    const a = await run(reverseOperation, { operationId: inc.id, reason: 'ошибка' }, owner, key);
    const again = await run(reverseOperation, { operationId: inc.id, reason: 'ошибка' }, owner, key);
    expect(again.id).toBe(a.id);
  });

  it('приход по сеансу – USE_PAYMENT_REFUND, от продажи сертификата – USE_CERTIFICATE_CANCEL (сторно и исправление)', async () => {
    const b = await newBranch();
    const session = await foreignIncome(b, 'session');
    const sale = await foreignIncome(b, 'certificate_sale');
    await fails(run(reverseOperation, { operationId: session.id, reason: 'x' }), 'USE_PAYMENT_REFUND');
    await fails(run(reverseOperation, { operationId: sale.id, reason: 'x' }), 'USE_CERTIFICATE_CANCEL');
    const replacement = { kind: 'income', method: 'cash', amountKop: 9_000, source: 'other', occurredAt: AT };
    await fails(run(correctOperation, { operationId: session.id, reason: 'x', replacement }), 'USE_PAYMENT_REFUND');
    await fails(run(correctOperation, { operationId: sale.id, reason: 'x', replacement }), 'USE_CERTIFICATE_CANCEL');
    expect((await balances(b)).cash).toBe(20_000);
  });

  it('возврат (refund) не сторнируется и не исправляется – USE_PAYMENT_REFUND', async () => {
    const b = await newBranch();
    const session = await foreignIncome(b, 'session');
    const refund = await tx((t) =>
      postMoneyOperation(
        t,
        { kind: 'system', process: 'test' },
        { branchId: b, kind: 'refund', place: 'cash', method: 'cash', amountKop: 4_000, comment: 'возврат клиенту', ref: { type: 'operation', id: session.id }, occurredAt: new Date(AT) },
        { idempotencyKey: randomUUID() },
        { actor: { kind: 'system', process: 'test' }, source: 'system', requestId: randomUUID() },
        clock,
      ),
    );
    await fails(run(reverseOperation, { operationId: refund.id, reason: 'x' }), 'USE_PAYMENT_REFUND');
    const replacement = { kind: 'income', method: 'cash', amountKop: 100, source: 'other', occurredAt: AT };
    await fails(run(correctOperation, { operationId: refund.id, reason: 'x', replacement }), 'USE_PAYMENT_REFUND');
    expect((await balances(b)).cash).toBe(6_000);
  });

  it('сторно прихода, уводящее место в минус при запрете, – CASH_INSUFFICIENT; сторно перевода проверяет место-получатель', async () => {
    const b = await newBranch();
    const inc = await income(b, 1_000);
    await run(recordExpense, { branchId: b, method: 'cash', amountKop: 800, categoryId: otherCat, occurredAt: AT, comment: 'закупка' });
    const err = await fails(run(reverseOperation, { operationId: inc.id, reason: 'ошибка' }), 'CASH_INSUFFICIENT');
    expect(err.details).toEqual({ place: 'cash', currentKop: 200, afterKop: -800 });
    await income(b, 2_000);
    const t = await run(transferBetweenPlaces, { branchId: b, from: 'cash', amountKop: 2_000, occurredAt: AT, comment: 'на счёт' });
    await run(recordExpense, { branchId: b, method: 'card', amountKop: 1_500, categoryId: otherCat, occurredAt: AT, comment: 'оплата картой' });
    expect(await balances(b)).toEqual({ cash: 200, noncash: 500 });
    await fails(run(reverseOperation, { operationId: t.id, reason: 'не сдавали' }), 'CASH_INSUFFICIENT');
    await run(recordIncome, { branchId: b, method: 'card', amountKop: 1_500, source: 'other', occurredAt: AT });
    const rev = await run(reverseOperation, { operationId: t.id, reason: 'не сдавали' });
    expect(await balances(b)).toEqual({ cash: 2_200, noncash: 0 });
    const entries = await db.client.query(`SELECT entry_type, amount FROM journal.ledger_entries WHERE posting_id = $1 ORDER BY id`, [rev.postingId]);
    expect(entries.rows).toEqual([
      { entry_type: 'reversal', amount: '2000' },
      { entry_type: 'reversal', amount: '-2000' },
    ]);
  });

  it('Директор не сторнирует (finance.correct – Владелец): 403; чужой филиал – 404', async () => {
    const b = await newBranch();
    const inc = await income(b, 1_000);
    await fails(run(reverseOperation, { operationId: inc.id, reason: 'x' }, ctx('director', [b])), 'FORBIDDEN');
    await fails(run(reverseOperation, { operationId: inc.id, reason: 'x' }, ctx('director', [randomUUID()])), 'NOT_FOUND');
    await fails(run(reverseOperation, { operationId: randomUUID(), reason: 'x' }), 'NOT_FOUND');
  });
});

describe('исправление', () => {
  it('сторно + новая операция одной транзакцией; новая проходит правила своей формы', async () => {
    const b = await newBranch();
    await income(b, 10_000);
    const exp = await run(recordExpense, { branchId: b, method: 'cash', amountKop: 3_000, categoryId: otherCat, occurredAt: AT, comment: 'опечатка в сумме' });
    const res = await run(correctOperation, {
      operationId: exp.id, reason: 'сумма 300, не 3000',
      replacement: { kind: 'expense', method: 'cash', amountKop: 300, categoryId: otherCat, occurredAt: AT, comment: 'та же покупка' },
    });
    expect(res.reversal).toMatchObject({ kind: 'reversal', reversalOf: exp.id });
    expect(res.replacement).toMatchObject({ kind: 'expense', amountKop: 300, branchId: b });
    expect((await balances(b)).cash).toBe(9_700);
    const a = await db.client.query(`SELECT action, after FROM journal.audit_events WHERE object_id = $1 AND action LIKE 'finance.operation.%' ORDER BY id`, [exp.id]);
    expect(a.rows.map((r) => r.action)).toEqual(['finance.operation.created', 'finance.operation.corrected']);
    expect(a.rows[1].after).toEqual({ reversalId: res.reversal.id, replacementId: res.replacement.id });
    // новая с нарушением правил – всё откатывается, исходная не сторнирована
    const exp2 = await run(recordExpense, { branchId: b, method: 'cash', amountKop: 100, categoryId: otherCat, occurredAt: AT, comment: 'x' });
    await fails(
      run(correctOperation, { operationId: exp2.id, reason: 'x', replacement: { kind: 'income', method: 'cash', amountKop: 100, source: 'session', occurredAt: AT } }),
      'SESSION_INCOME_VIA_PAYMENT',
    );
    expect((await getOperation(db.client, exp2.id))!.reversedBy).toBeNull();
  });

  it('тот же ключ после сторно №44 – исправление не выдаёт его за повтор: ALREADY_REVERSED', async () => {
    const b = await newBranch();
    const inc = await income(b, 2_000);
    const key = randomUUID();
    await run(reverseOperation, { operationId: inc.id, reason: 'ошибка' }, owner, key);
    const replacement = { kind: 'income', method: 'cash', amountKop: 200, source: 'other', occurredAt: AT };
    await fails(run(correctOperation, { operationId: inc.id, reason: 'x', replacement }, owner, key), 'ALREADY_REVERSED');
    expect((await balances(b)).cash).toBe(0);
  });

  it('замена начального остатка: сторно прежнего освобождает место для нового', async () => {
    const b = await newBranch();
    const ob = await run(recordOpeningBalance, { branchId: b, place: 'cash', amountKop: 50_000, date: '2026-11-01', comment: 'пересчёт' });
    const res = await run(correctOperation, {
      operationId: ob.id, reason: 'пересчитали заново',
      replacement: { kind: 'opening_balance', place: 'cash', amountKop: 48_000, date: '2026-11-01', comment: 'повторный пересчёт' },
    });
    expect((await balances(b)).cash).toBe(48_000);
    const rows = await db.client.query(`SELECT operation_id, status FROM app.finance_opening_balances WHERE branch_id = $1 ORDER BY created_at, status`, [b]);
    expect(new Map(rows.rows.map((r) => [r.operation_id, r.status]))).toEqual(new Map([[ob.id, 'reversed'], [res.replacement.id, 'active']]));
  });
});

describe('закрытие месяца', () => {
  it('операция в закрытом месяце – PERIOD_CLOSED; сторно операции закрытого месяца – текущей датой; открыть нельзя', async () => {
    const b = await newBranch();
    const oct: FinanceOperationDto = await run(recordIncome, { branchId: b, method: 'cash', amountKop: 4_000, source: 'other', occurredAt: '2026-10-20T05:00:00Z' });
    const closed = await tx((t) => closeMonth(t, owner, { branchId: b, month: '2026-10' }, meta(owner), { clock }));
    expect(closed).toMatchObject({ branchId: b, month: '2026-10-01', closedBy: owner.actor.staffId });
    await fails(run(recordIncome, { branchId: b, method: 'cash', amountKop: 100, source: 'other', occurredAt: '2026-10-31T16:59:00Z' }), 'PERIOD_CLOSED'); // 23:59 по Новосибирску
    await run(recordIncome, { branchId: b, method: 'cash', amountKop: 100, source: 'other', occurredAt: '2026-10-31T17:00:00Z' }); // уже 1 ноября там
    const rev = await run(reverseOperation, { operationId: oct.id, reason: 'исправление прошлого' });
    expect(rev.occurredAt).toBe(clock.now().toISOString());
    expect((await fails(tx((t) => closeMonth(t, owner, { branchId: b, month: '2026-10' }, meta(owner), { clock })), 'PERIOD_CLOSED')).details).toMatchObject({ month: '2026-10-01' });
    await fails(tx((t) => closeMonth(t, owner, { branchId: b, month: '2026-11' }, meta(owner), { clock })), 'VALIDATION_FAILED'); // текущий
    await fails(tx((t) => closeMonth(t, ctx('director', [b]), { branchId: b, month: '2026-09' }, meta(owner), { clock })), 'FORBIDDEN');
    const a = await db.client.query(`SELECT action, after FROM journal.audit_events WHERE object_id = $1 AND action = 'finance.period.closed'`, [b]);
    expect(a.rows).toEqual([{ action: 'finance.period.closed', after: { month: '2026-10-01' } }]);
  });
});
