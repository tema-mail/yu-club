// S2-11: ядро кассы (K17 §2–§4, §6; 06 §17 п.3, 4, 9, 12, 16).
// Места денег – два счёта K3; формула 06 §3.2 по каждому месту на случайных операциях; начальный остаток один;
// минус при запрете – CASH_INSUFFICIENT, при разрешении – проходит; доход по сеансу – только оплатой (K10);
// гонка расходов на настоящем Postgres: остаток не уходит в минус.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { ensureAccount, getBalance, verifyBalance } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  financeDenialOf,
  getOperation,
  postMoneyOperation,
  previewBalance,
  recordExpense,
  recordIncome,
  recordOpeningBalance,
  recordWithdrawal,
  transferBetweenPlaces,
  type MoneyPlace,
} from '../../apps/api/src/modules/finance/cashbox.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:00:00Z';
const cat: Record<string, string> = {};

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

type Cmd = typeof recordIncome;
const run = (cmd: Cmd, body: Record<string, unknown>, who: AccessContext = owner, key = randomUUID()) =>
  tx((t) => cmd(t, who, body, meta(who), { idempotencyKey: key, clock }));
const newBranch = async () => (await createTestBranch(db.client)).id;
const balances = async (branchId: string): Promise<Record<MoneyPlace, number>> => {
  const r = await db.client.query<{ kind: string; balance: string }>(`SELECT kind, balance FROM app.ledger_accounts WHERE owner_id = $1`, [branchId]);
  const by = new Map(r.rows.map((x) => [x.kind, Number(x.balance)]));
  return { cash: by.get('cash_branch') ?? 0, noncash: by.get('cash_branch_noncash') ?? 0 };
};
const allowNegative = (branchId: string) =>
  db.client.query(
    `INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`,
    [branchId, randomUUID()],
  );
const expense = (branchId: string, amountKop: number, method = 'cash') => ({
  branchId, method, amountKop, categoryId: cat.other, occurredAt: AT, comment: 'мелочи',
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  const ids = await db.client.query<{ id: string; name: string }>(`SELECT id, name FROM app.finance_categories WHERE name IN ('Прочее', 'Коммунальные', 'Электричество')`);
  for (const r of ids.rows) cat[{ Прочее: 'other', Коммунальные: 'utilities', Электричество: 'power' }[r.name]!] = r.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('места денег и операции', () => {
  it('начальный остаток – отдельный тип; второй – OPENING_BALANCE_EXISTS без удвоения (06 §17 п.3)', async () => {
    const b = await newBranch();
    const first = await run(recordOpeningBalance, { branchId: b, place: 'cash', amountKop: 500_000, date: '2026-11-01', comment: 'пересчёт при запуске' });
    expect(first).toMatchObject({ kind: 'opening_balance', place: 'cash', direction: 'in', balanceAfterKop: 500_000, occurredAt: '2026-10-31T17:00:00.000Z' });
    const err = await fails(run(recordOpeningBalance, { branchId: b, place: 'cash', amountKop: 500_000, date: '2026-11-01', comment: 'ещё раз' }), 'OPENING_BALANCE_EXISTS');
    expect(err.details).toEqual({ operationId: first.id });
    expect((await balances(b)).cash).toBe(500_000);
    // у безнала свой начальный остаток
    await run(recordOpeningBalance, { branchId: b, place: 'noncash', amountKop: 10_000, date: '2026-11-01', comment: 'остаток на счёте' });
    expect(await balances(b)).toEqual({ cash: 500_000, noncash: 10_000 });
    const ob = await db.client.query(`SELECT place, status FROM app.finance_opening_balances WHERE branch_id = $1 ORDER BY place`, [b]);
    expect(ob.rows).toEqual([
      { place: 'cash', status: 'active' },
      { place: 'noncash', status: 'active' },
    ]);
  });

  it('доход увеличивает, расход уменьшает место своего способа: наличные – cash, карта и перевод – noncash (п.4)', async () => {
    const b = await newBranch();
    const cash = await run(recordIncome, { branchId: b, method: 'cash', amountKop: 30_000, source: 'event', occurredAt: AT, receiptIssued: true });
    expect(cash).toMatchObject({ kind: 'income', place: 'cash', method: 'cash', source: 'event', receiptIssued: true, balanceAfterKop: 30_000 });
    await run(recordIncome, { branchId: b, method: 'card', amountKop: 20_000, source: 'extra_service', occurredAt: AT });
    await run(recordIncome, { branchId: b, method: 'transfer', amountKop: 5_000, source: 'other', occurredAt: AT });
    const exp = await run(recordExpense, expense(b, 12_000));
    expect(exp).toMatchObject({ kind: 'expense', place: 'cash', direction: 'out', categoryId: cat.other, balanceAfterKop: 18_000 });
    await run(recordExpense, { ...expense(b, 4_000, 'card'), categoryId: cat.utilities, subcategoryId: cat.power, comment: 'свет за октябрь' });
    expect(await balances(b)).toEqual({ cash: 18_000, noncash: 21_000 });
  });

  it('доход без брони (п.12) и доход по сеансу – только оплатой: SESSION_INCOME_VIA_PAYMENT', async () => {
    const b = await newBranch();
    await fails(run(recordIncome, { branchId: b, method: 'cash', amountKop: 100, source: 'session', occurredAt: AT }), 'SESSION_INCOME_VIA_PAYMENT');
    await fails(run(recordIncome, { branchId: b, method: 'cash', amountKop: 100, source: 'certificate_sale', occurredAt: AT }), 'VALIDATION_FAILED');
    expect(await balances(b)).toEqual({ cash: 0, noncash: 0 });
  });

  it('расход без комментария – COMMENT_REQUIRED (п.9); без подкатегории при наличии – SUBCATEGORY_REQUIRED; сумма – INVALID_AMOUNT', async () => {
    const b = await newBranch();
    await allowNegative(b);
    await fails(run(recordExpense, { ...expense(b, 100), comment: '  ' }), 'COMMENT_REQUIRED');
    await fails(run(recordExpense, { ...expense(b, 100), categoryId: cat.utilities }), 'SUBCATEGORY_REQUIRED');
    for (const amountKop of [0, -100, 10.5]) await fails(run(recordExpense, expense(b, amountKop)), 'INVALID_AMOUNT');
    await fails(run(recordExpense, { ...expense(b, 100), occurredAt: '2026-11-15T00:00:00Z' }), 'VALIDATION_FAILED'); // в будущем
    expect(await balances(b)).toEqual({ cash: 0, noncash: 0 });
  });

  it('изъятие – только наличных; перевод между местами – одна операция, две записи K3, итог не меняется', async () => {
    const b = await newBranch();
    await run(recordIncome, { branchId: b, method: 'cash', amountKop: 50_000, source: 'other', occurredAt: AT });
    const w = await run(recordWithdrawal, { branchId: b, amountKop: 10_000, occurredAt: AT, comment: 'владелец забрал' });
    expect(w).toMatchObject({ kind: 'withdrawal', place: 'cash', method: 'cash', balanceAfterKop: 40_000 });
    const t = await run(transferBetweenPlaces, { branchId: b, from: 'cash', amountKop: 25_000, occurredAt: AT, comment: 'сдали на счёт' });
    expect(t).toMatchObject({ kind: 'place_transfer', place: 'cash', direction: 'out', balanceAfterKop: 15_000 });
    expect(await balances(b)).toEqual({ cash: 15_000, noncash: 25_000 });
    const entries = await db.client.query(`SELECT entry_type, amount FROM journal.ledger_entries WHERE posting_id = $1 ORDER BY id`, [t.postingId]);
    expect(entries.rows).toEqual([
      { entry_type: 'cash.transfer_out', amount: '-25000' },
      { entry_type: 'cash.transfer_in', amount: '25000' },
    ]);
    await fails(run(recordWithdrawal, { branchId: b, amountKop: 10_000, occurredAt: AT }), 'COMMENT_REQUIRED');
  });

  it('повтор с тем же ключом – та же операция; аудит finance.operation.created один раз', async () => {
    const b = await newBranch();
    const key = randomUUID();
    const body = { branchId: b, method: 'cash', amountKop: 7_000, source: 'other', occurredAt: AT };
    const a = await run(recordIncome, body, owner, key);
    const again = await run(recordIncome, body, owner, key);
    expect(again.id).toBe(a.id);
    expect((await balances(b)).cash).toBe(7_000);
    await fails(run(recordIncome, { ...body, amountKop: 8_000 }, owner, key), 'IDEMPOTENCY_KEY_REUSED');
    const audit = await db.client.query(`SELECT action, object_type, branch_id FROM journal.audit_events WHERE object_id = $1`, [a.id]);
    expect(audit.rows).toEqual([{ action: 'finance.operation.created', object_type: 'finance_operation', branch_id: b }]);
  });
});

describe('отрицательный остаток (06 §3.3, K17 §6)', () => {
  it('false (по умолчанию): расход больше остатка – CASH_INSUFFICIENT с числами; true – проходит в минус', async () => {
    const b = await newBranch();
    await run(recordIncome, { branchId: b, method: 'cash', amountKop: 1_000, source: 'other', occurredAt: AT });
    const err = await fails(run(recordExpense, expense(b, 1_500)), 'CASH_INSUFFICIENT');
    expect(err.details).toEqual({ place: 'cash', currentKop: 1_000, afterKop: -500 });
    // безнал проверяется отдельно: наличных хватает, безнала – нет
    await fails(run(recordExpense, expense(b, 500, 'card')), 'CASH_INSUFFICIENT');
    await fails(run(transferBetweenPlaces, { branchId: b, from: 'noncash', amountKop: 1, occurredAt: AT, comment: 'x' }), 'CASH_INSUFFICIENT');
    await fails(run(recordWithdrawal, { branchId: b, amountKop: 1_001, occurredAt: AT, comment: 'x' }), 'CASH_INSUFFICIENT');
    expect(await balances(b)).toEqual({ cash: 1_000, noncash: 0 });
    await allowNegative(b);
    const ok = await run(recordExpense, expense(b, 1_500));
    expect(ok.balanceAfterKop).toBe(-500);
  });

  it('предпросмотр: остаток после, allowed по правилу; ничего не пишет', async () => {
    const b = await newBranch();
    await run(recordIncome, { branchId: b, method: 'cash', amountKop: 2_000, source: 'other', occurredAt: AT });
    expect(await previewBalance(pool, owner, { branchId: b, place: 'cash', deltaKop: -1_500 }, clock)).toEqual({ currentKop: 2_000, afterKop: 500, allowed: true, reason: null });
    expect(await previewBalance(pool, owner, { branchId: b, place: 'cash', deltaKop: -2_500 }, clock)).toEqual({
      currentKop: 2_000, afterKop: -500, allowed: false, reason: 'negative_forbidden',
    });
    expect(await previewBalance(pool, owner, { branchId: b, place: 'noncash', deltaKop: 100 }, clock)).toMatchObject({ currentKop: 0, allowed: true });
    expect((await balances(b)).cash).toBe(2_000);
  });

  it('гонка: 10 параллельных расходов по 300 при остатке 1 000 – проходят ровно 3, остаток 100', async () => {
    const b = await newBranch();
    await run(recordIncome, { branchId: b, method: 'cash', amountKop: 1_000, source: 'other', occurredAt: AT });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => run(recordExpense, expense(b, 300))));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const codes = results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as AppError).code);
    expect(ok).toBe(3);
    expect(new Set(codes)).toEqual(new Set(['CASH_INSUFFICIENT']));
    expect((await balances(b)).cash).toBe(100);
  });
});

describe('формула остатка 06 §3.2 (п.16), по каждому месту', () => {
  it('случайные операции: остаток места = начальный + доходы − расходы − изъятия ± переводы; кэш = Σ K3', async () => {
    const b = await newBranch();
    await allowNegative(b);
    let seed = 20261114;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const model: Record<MoneyPlace, number> = { cash: 0, noncash: 0 };
    await run(recordOpeningBalance, { branchId: b, place: 'cash', amountKop: 100_000, date: '2026-11-01', comment: 'старт' });
    model.cash += 100_000;
    for (let i = 0; i < 60; i++) {
      const amount = 1 + rnd(50_000);
      const method = (['cash', 'card', 'transfer'] as const)[rnd(3)]!;
      const place: MoneyPlace = method === 'cash' ? 'cash' : 'noncash';
      switch (rnd(4)) {
        case 0:
          await run(recordIncome, { branchId: b, method, amountKop: amount, source: 'other', occurredAt: AT });
          model[place] += amount;
          break;
        case 1:
          await run(recordExpense, expense(b, amount, method));
          model[place] -= amount;
          break;
        case 2:
          await run(recordWithdrawal, { branchId: b, amountKop: amount, occurredAt: AT, comment: 'изъятие' });
          model.cash -= amount;
          break;
        default: {
          const from: MoneyPlace = rnd(2) === 0 ? 'cash' : 'noncash';
          await run(transferBetweenPlaces, { branchId: b, from, amountKop: amount, occurredAt: AT, comment: 'перевод' });
          model[from] -= amount;
          model[from === 'cash' ? 'noncash' : 'cash'] += amount;
        }
      }
    }
    expect(await balances(b)).toEqual(model);
    // формула из операций (журнал кассы), а не из кэша счёта
    const f = await db.client.query<{ place: MoneyPlace; total: string }>(
      `SELECT p.place, sum(CASE
          WHEN fo.kind = 'place_transfer' AND fo.place = p.place THEN -fo.amount_kop
          WHEN fo.kind = 'place_transfer' THEN fo.amount_kop
          WHEN fo.place <> p.place THEN 0
          WHEN fo.direction = 'in' THEN fo.amount_kop ELSE -fo.amount_kop END)::text AS total
       FROM journal.finance_operations fo CROSS JOIN (VALUES ('cash'), ('noncash')) AS p(place)
       WHERE fo.branch_id = $1 GROUP BY p.place ORDER BY p.place`,
      [b],
    );
    expect(Object.fromEntries(f.rows.map((r) => [r.place, Number(r.total)]))).toEqual(model);
    for (const kind of ['cash_branch', 'cash_branch_noncash'] as const) {
      const acc = await ensureAccount(db.client, { kind, ownerType: 'branch', ownerId: b }, { unit: 'RUB_KOP', branchId: b, minBalance: null });
      expect((await verifyBalance(db.client, acc.id)).ok).toBe(true);
    }
  });
});

describe('права и чужие модули', () => {
  it('Администратор вносит расход своего филиала; чужой – 404; ручной доход и начальный остаток – 403', async () => {
    const b = await newBranch();
    const other = await newBranch();
    const admin = ctx('admin', [b]);
    await run(recordIncome, { branchId: b, method: 'cash', amountKop: 1_000, source: 'other', occurredAt: AT });
    expect((await run(recordExpense, expense(b, 100), admin)).authorId).toBe(admin.actor.staffId);
    const foreign = await fails(run(recordExpense, expense(other, 100), admin), 'NOT_FOUND');
    expect(financeDenialOf(foreign)).toMatchObject({ action: 'finance.operation.created', branchId: other, reason: 'NOT_FOUND: finance.expense.create' });
    await fails(run(recordIncome, { branchId: b, method: 'cash', amountKop: 1, source: 'other', occurredAt: AT }, admin), 'FORBIDDEN');
    await fails(run(recordOpeningBalance, { branchId: b, place: 'cash', amountKop: 1, date: '2026-11-01', comment: 'x' }, ctx('director', [b])), 'FORBIDDEN');
    await fails(run(recordWithdrawal, { branchId: b, amountKop: 1, occurredAt: AT, comment: 'x' }, admin), 'FORBIDDEN');
  });

  it('postMoneyOperation для K16: приход certificate_sale и связанная запись certificate.issue одной проводкой', async () => {
    const b = await newBranch();
    const certId = randomUUID();
    const certRef = { kind: 'certificate' as const, ownerType: 'certificate' as const, ownerId: certId };
    const sys = { kind: 'system' as const, process: 'test' };
    const op = await tx(async (t) => {
      const acc = await ensureAccount(t, certRef, { unit: 'RUB_KOP', branchId: b, minBalance: 0 });
      return {
        acc,
        dto: await postMoneyOperation(
          t,
          sys,
          { branchId: b, kind: 'income', place: 'noncash', method: 'card', amountKop: 500_000, source: 'certificate_sale', ref: { type: 'certificate', id: certId }, occurredAt: new Date(AT) },
          { idempotencyKey: `certificate-sale:${certId}`, linkedEntries: [{ account: certRef, amount: 500_000, type: 'certificate.issue', branchId: b, occurredAt: new Date(AT) }] },
          { actor: { kind: 'system', process: 'test' }, source: 'system', requestId: randomUUID() },
          clock,
        ),
      };
    });
    expect(op.dto).toMatchObject({ source: 'certificate_sale', authorId: null, balanceAfterKop: 500_000, ref: { type: 'certificate', id: certId } });
    expect(await getBalance(db.client, op.acc.id)).toBe(500_000);
    const e = await db.client.query(`SELECT entry_type, ref_type, refs FROM journal.ledger_entries WHERE posting_id = $1 ORDER BY id`, [op.dto.postingId]);
    expect(e.rows).toEqual([
      { entry_type: 'cash.income', ref_type: 'certificate', refs: { financeOperationId: op.dto.id } },
      { entry_type: 'certificate.issue', ref_type: null, refs: {} },
    ]);
    expect((await getOperation(db.client, op.dto.id))!.id).toBe(op.dto.id);
  });
});
