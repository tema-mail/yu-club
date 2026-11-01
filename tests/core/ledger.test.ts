import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureAccount,
  getBalance,
  listEntries,
  lockAccounts,
  pointsForMinutes,
  post,
  reverse,
  verifyBalance,
  type AccountRef,
  type EntryInput,
  type PostingInput,
  type Tx,
  type Unit,
} from '../../apps/api/src/core/ledger.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;

const at = new Date('2026-11-15T07:00:00Z');
const system = { type: 'system', id: null } as const;
const staff = { type: 'staff', id: randomUUID() } as const;

/** Транзакция от роли yu_app (как рантайм). */
async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
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

const cert = (): AccountRef => ({ kind: 'certificate', ownerType: 'certificate', ownerId: randomUUID() });
const points = (): AccountRef => ({ kind: 'loyalty_client', ownerType: 'client', ownerId: randomUUID() });
const cash = (): AccountRef => ({ kind: 'cash_branch', ownerType: 'branch', ownerId: randomUUID() });

async function open(ref: AccountRef, unit: Unit, minBalance: number | null) {
  return inTx((tx) => ensureAccount(tx, ref, { unit, branchId: null, minBalance }));
}

function entry(account: AccountRef, amount: number, type: EntryInput['type'], extra: Partial<EntryInput> = {}): EntryInput {
  return { account, amount, type, branchId: null, occurredAt: at, ...extra };
}

const postOne = (account: AccountRef, amount: number, type: EntryInput['type'], extra: Partial<PostingInput> = {}) =>
  inTx((tx) => post(tx, { entries: [entry(account, amount, type)], idempotencyKey: randomUUID(), author: system, ...extra }));

/** Детерминированный ГПСЧ (mulberry32) – случайные, но воспроизводимые последовательности. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, max: 25 });
  pool.on('connect', (c) => {
    void c.query('SET ROLE yu_app');
  });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S0-07 журнал операций: схема и права', () => {
  it('после миграций журнальные таблицы только на вставку', async () => {
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
  });

  it('yu_app не может UPDATE/DELETE записей и UPDATE balance; status – может', async () => {
    const ref = cert();
    const acc = await open(ref, 'RUB_KOP', 0);
    await postOne(ref, 1000, 'certificate.issue');
    const c = await pool.connect();
    try {
      await expect(c.query('UPDATE journal.ledger_entries SET amount = 1')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('DELETE FROM journal.ledger_entries')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('UPDATE app.ledger_accounts SET balance = 999 WHERE id = $1', [acc.id])).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        c.query(
          "INSERT INTO app.ledger_accounts (kind, unit, owner_type, owner_id, balance) VALUES ('certificate','RUB_KOP','certificate',$1, 500)",
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query("UPDATE app.ledger_accounts SET status = 'active' WHERE id = $1", [acc.id]);
    } finally {
      c.release();
    }
    expect(await getBalance(pool, acc.id)).toBe(1000);
  });

  it('balance_after из INSERT игнорируется – ставит триггер', async () => {
    const ref = cash();
    const acc = await open(ref, 'RUB_KOP', null);
    const r = await pool.query(
      `INSERT INTO journal.ledger_entries (posting_id, account_id, amount, balance_after, entry_type, occurred_at, author_type)
       VALUES ($1, $2, 700, 123456, 'cash.income', $3, 'system') RETURNING balance_after`,
      [randomUUID(), acc.id, at],
    );
    expect(r.rows[0].balance_after).toBe('700');
    expect(await getBalance(pool, acc.id)).toBe(700);
  });
});

describe('S0-07 проводки', () => {
  it('pointsForMinutes: до 0,5 балла вниз, целочисленно', () => {
    expect([15, 20, 30, 45, 50, 60, 0, 2, 5, 6].map(pointsForMinutes)).toEqual([250, 300, 500, 750, 800, 1000, 0, 0, 50, 100]);
    expect(() => pointsForMinutes(1.5)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('ensureAccount: повтор возвращает тот же счёт; другая единица – UNIT_MISMATCH', async () => {
    const ref = points();
    const a = await open(ref, 'POINT_CENTI', -5000);
    const b = await open(ref, 'POINT_CENTI', -5000);
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ balance: 0, minBalance: -5000, status: 'active' });
    await expect(open({ ...ref, kind: 'cash_branch', ownerType: 'branch' }, 'POINT_CENTI', null)).rejects.toMatchObject({
      code: '23514',
    });
    const c = cash();
    await open(c, 'RUB_KOP', null);
    await expect(open(c, 'POINT_CENTI', null)).rejects.toMatchObject({ code: 'UNIT_MISMATCH' });
  });

  it('сумма – целое ненулевое безопасное, иначе INVALID_AMOUNT', async () => {
    const ref = cash();
    await open(ref, 'RUB_KOP', null);
    for (const bad of [0, 1.5, 2 ** 53, Number.NaN]) {
      await expect(postOne(ref, bad, 'cash.income')).rejects.toMatchObject({ code: 'INVALID_AMOUNT', httpStatus: 422 });
    }
  });

  it('расход и корректировка без основания – VALIDATION_FAILED', async () => {
    const ref = cash();
    await open(ref, 'RUB_KOP', null);
    await expect(postOne(ref, -100, 'cash.expense')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(postOne(ref, 100, 'cash.correction')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('перевод между кассами – одна проводка из двух записей; разные единицы – UNIT_MISMATCH', async () => {
    const from = cash();
    const to = cash();
    const a = await open(from, 'RUB_KOP', 0);
    const b = await open(to, 'RUB_KOP', 0);
    await postOne(from, 5000, 'cash.income');
    const r = await inTx((tx) =>
      post(tx, {
        entries: [entry(from, -3000, 'cash.transfer_out'), entry(to, 3000, 'cash.transfer_in')],
        idempotencyKey: randomUUID(),
        author: staff,
      }),
    );
    expect(r.entries.map((e) => [e.postingId === r.postingId, e.balanceAfter])).toEqual([
      [true, 2000],
      [true, 3000],
    ]);
    expect([await getBalance(pool, a.id), await getBalance(pool, b.id)]).toEqual([2000, 3000]);

    const p = points();
    await open(p, 'POINT_CENTI', -5000);
    await expect(
      inTx((tx) =>
        post(tx, {
          entries: [entry(from, 100, 'cash.income'), entry(p, 100, 'loyalty.accrual')],
          idempotencyKey: randomUUID(),
          author: system,
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNIT_MISMATCH' });
  });

  it('повтор с ключом – без дубля; тот же ключ, другие записи – IDEMPOTENCY_KEY_REUSED', async () => {
    const ref = points();
    const acc = await open(ref, 'POINT_CENTI', -5000);
    const key = `loyalty-accrual:${randomUUID()}`;
    const input = { entries: [entry(ref, 300, 'loyalty.accrual')], idempotencyKey: key, author: system };
    const first = await inTx((tx) => post(tx, input));
    const second = await inTx((tx) => post(tx, input));
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(await getBalance(pool, acc.id)).toBe(300);
    await expect(
      inTx((tx) => post(tx, { ...input, entries: [entry(ref, 500, 'loyalty.accrual')] })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 409 });
    const keys = await pool.query('SELECT idempotency_key FROM journal.ledger_entries WHERE posting_id = $1', [first.postingId]);
    expect(keys.rows).toEqual([{ idempotency_key: `${key}#0` }]);
  });

  it('20 параллельных post с одним ключом → одна проводка, 19 replayed', async () => {
    const ref = points();
    const acc = await open(ref, 'POINT_CENTI', -5000);
    const key = `loyalty-accrual:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        inTx((tx) => post(tx, { entries: [entry(ref, 250, 'loyalty.accrual')], idempotencyKey: key, author: system })),
      ),
    );
    expect(results.filter((r) => r.replayed)).toHaveLength(19);
    expect(new Set(results.map((r) => r.postingId)).size).toBe(1);
    expect(await getBalance(pool, acc.id)).toBe(250);
  });

  it('два параллельных списания с сертификата: каждое в остатке, вместе нет → одно BALANCE_BELOW_LIMIT', async () => {
    const ref = cert();
    const acc = await open(ref, 'RUB_KOP', 0);
    await postOne(ref, 10_000, 'certificate.issue');
    const settled = await Promise.allSettled([
      postOne(ref, -7000, 'certificate.redeem'),
      postOne(ref, -6000, 'certificate.redeem'),
    ]);
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'BALANCE_BELOW_LIMIT',
      httpStatus: 409,
      details: { accountKind: 'certificate', minBalance: 0 },
    });
    const balance = await getBalance(pool, acc.id);
    expect([3000, 4000]).toContain(balance);
    expect((await verifyBalance(pool, acc.id)).ok).toBe(true);
  });

  it('allowBelowLimit: сотрудник с причиной – ниже границы, limit_override; иначе отказ', async () => {
    const ref = points();
    const acc = await open(ref, 'POINT_CENTI', -5000);
    await expect(postOne(ref, -6000, 'loyalty.penalty')).rejects.toMatchObject({
      code: 'BALANCE_BELOW_LIMIT',
      details: { balance: 0, minBalance: -5000, attempted: -6000 },
    });
    await expect(
      postOne(ref, -6000, 'loyalty.penalty', { allowBelowLimit: { reason: 'спор' }, author: { type: 'client', id: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'LIMIT_OVERRIDE_NOT_ALLOWED', httpStatus: 403 });
    await expect(
      inTx((tx) =>
        post(tx, {
          entries: [entry(ref, -6000, 'loyalty.manual', { basis: 'спор' })],
          idempotencyKey: randomUUID(),
          author: staff,
          allowBelowLimit: { reason: '  ' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_OVERRIDE_NOT_ALLOWED' });
    const ok = await inTx((tx) =>
      post(tx, {
        entries: [entry(ref, -6000, 'loyalty.penalty', { basis: 'неявка 15.11' })],
        idempotencyKey: randomUUID(),
        author: staff,
        allowBelowLimit: { reason: 'решение директора' },
      }),
    );
    expect(await getBalance(pool, acc.id)).toBe(-6000);
    const row = await pool.query('SELECT limit_override, limit_override_reason, basis FROM journal.ledger_entries WHERE id = $1', [
      ok.entries[0]!.id,
    ]);
    expect(row.rows[0]).toEqual({ limit_override: true, limit_override_reason: 'решение директора', basis: 'неявка 15.11' });
  });

  it('тип записи вне реестра K3 – отказ базы', async () => {
    const acc = await open(cash(), 'RUB_KOP', null);
    await expect(
      pool.query(
        `INSERT INTO journal.ledger_entries (posting_id, account_id, amount, balance_after, entry_type, occurred_at, author_type)
         VALUES ($1, $2, 100, 0, 'cash.gift', $3, 'system')`,
        [randomUUID(), acc.id, at],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ledger_entry_type_known' });
  });

  it('закрытый счёт – ACCOUNT_CLOSED', async () => {
    const ref = cash();
    const acc = await open(ref, 'RUB_KOP', null);
    await pool.query("UPDATE app.ledger_accounts SET status = 'closed' WHERE id = $1", [acc.id]);
    await expect(postOne(ref, 100, 'cash.income')).rejects.toMatchObject({ code: 'ACCOUNT_CLOSED' });
  });

  it('несуществующий счёт – NOT_FOUND', async () => {
    await expect(postOne(cash(), 100, 'cash.income')).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    await expect(inTx((tx) => lockAccounts(tx, [randomUUID()]))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('S0-07 сторно', () => {
  it('сторно – новая запись, исходная не меняется; второе – ALREADY_REVERSED; сторно сторно – запрещено', async () => {
    const ref = points();
    const acc = await open(ref, 'POINT_CENTI', -5000);
    const accrual = await postOne(ref, 500, 'loyalty.accrual');
    const orig = accrual.entries[0]!;
    const key = `visit-revert:${randomUUID()}`;
    const rev = await inTx((tx) => reverse(tx, { entryId: orig.id, reason: 'ошибочный приход', idempotencyKey: key, author: staff, occurredAt: at }));
    expect(rev.entries[0]).toMatchObject({ amount: -500, type: 'reversal', reversalOf: orig.id, balanceAfter: 0 });
    const origNow = await pool.query('SELECT amount, balance_after FROM journal.ledger_entries WHERE id = $1', [orig.id]);
    expect(origNow.rows[0]).toEqual({ amount: '500', balance_after: '500' });
    expect(await getBalance(pool, acc.id)).toBe(0);

    // тот же ключ – повтор без дубля
    const again = await inTx((tx) => reverse(tx, { entryId: orig.id, reason: 'ошибочный приход', idempotencyKey: key, author: staff, occurredAt: at }));
    expect(again).toEqual({ ...rev, replayed: true });

    // новый ключ – ловит UNIQUE(reversal_of)
    await expect(
      inTx((tx) => reverse(tx, { entryId: orig.id, reason: 'ещё раз', idempotencyKey: randomUUID(), author: staff, occurredAt: at })),
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED', httpStatus: 409 });
    // и в обход кода – та же защита в базе
    await expect(
      pool.query(
        `INSERT INTO journal.ledger_entries (posting_id, account_id, amount, balance_after, entry_type, basis, reversal_of, occurred_at, author_type)
         VALUES ($1, $2, -500, 0, 'reversal', 'x', $3, $4, 'system')`,
        [randomUUID(), acc.id, orig.id, at],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'ledger_entries_reversal_of_key' });

    await expect(
      inTx((tx) => reverse(tx, { entryId: rev.entries[0]!.id, reason: 'x', idempotencyKey: randomUUID(), author: staff, occurredAt: at })),
    ).rejects.toMatchObject({ code: 'CANNOT_REVERSE_REVERSAL' });
    await expect(
      pool.query(
        `INSERT INTO journal.ledger_entries (posting_id, account_id, amount, balance_after, entry_type, basis, reversal_of, occurred_at, author_type)
         VALUES ($1, $2, 500, 0, 'reversal', 'x', $3, $4, 'system')`,
        [randomUUID(), acc.id, rev.entries[0]!.id, at],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ledger_reversal_of_reversal' });
    expect((await verifyBalance(pool, acc.id)).ok).toBe(true);
  });

  it('сторно без причины – VALIDATION_FAILED; неверная форма в обход кода – отказ базы', async () => {
    const ref = cash();
    const acc = await open(ref, 'RUB_KOP', null);
    const p = await postOne(ref, 900, 'cash.income');
    await expect(
      inTx((tx) => reverse(tx, { entryId: p.entries[0]!.id, reason: ' ', idempotencyKey: randomUUID(), author: staff, occurredAt: at })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      pool.query(
        `INSERT INTO journal.ledger_entries (posting_id, account_id, amount, balance_after, entry_type, basis, reversal_of, occurred_at, author_type)
         VALUES ($1, $2, -100, 0, 'reversal', 'x', $3, $4, 'system')`,
        [randomUUID(), acc.id, p.entries[0]!.id, at],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ledger_reversal_mismatch' });
  });

  it('история: порядок (occurred_at, id), курсор не теряет записи с одинаковым временем', async () => {
    const ref = cash();
    const acc = await open(ref, 'RUB_KOP', null);
    const early = new Date('2026-11-14T07:00:00Z');
    await inTx((tx) => post(tx, { entries: [entry(ref, 1, 'cash.income')], idempotencyKey: randomUUID(), author: system }));
    await inTx((tx) => post(tx, { entries: [entry(ref, 2, 'cash.income')], idempotencyKey: randomUUID(), author: system }));
    await inTx((tx) =>
      post(tx, { entries: [entry(ref, 3, 'cash.income', { occurredAt: early })], idempotencyKey: randomUUID(), author: system }),
    );
    const page1 = await listEntries(pool, acc.id, { limit: 2 });
    const last = page1.at(-1)!;
    const page2 = await listEntries(pool, acc.id, { limit: 2, after: { occurredAt: last.occurredAt, id: last.id } });
    expect([...page1, ...page2].map((e) => e.amount)).toEqual([3, 1, 2]);
  });
});

describe('S0-07 инвариант: баланс = сумма записей (случайные последовательности)', () => {
  it.each([1, 2, 3, 4, 5])('seed %i: 40 проводок и сторно на 3 счетах', async (seed) => {
    const rand = rng(seed);
    const refs = [cert(), cert(), cash()];
    const accs = [await open(refs[0]!, 'RUB_KOP', 0), await open(refs[1]!, 'RUB_KOP', 0), await open(refs[2]!, 'RUB_KOP', null)];
    const posted: number[] = [];
    const model = [0, 0, 0];
    for (let step = 0; step < 40; step++) {
      const i = Math.floor(rand() * 3);
      try {
        if (posted.length > 0 && rand() < 0.25) {
          const entryId = posted[Math.floor(rand() * posted.length)]!;
          const r = await inTx((tx) => reverse(tx, { entryId, reason: 'тест', idempotencyKey: randomUUID(), author: staff, occurredAt: at }));
          model[accs.findIndex((a) => a.id === r.entries[0]!.accountId)]! += r.entries[0]!.amount;
        } else {
          const amount = Math.floor(rand() * 2000) - 800 || 1;
          const r = await postOne(refs[i]!, amount, amount > 0 ? 'cash.income' : 'cash.refund');
          model[i]! += amount;
          posted.push(r.entries[0]!.id);
        }
      } catch (err) {
        // ожидаемые отказы не меняют баланс
        expect((err as { code?: string }).code).toMatch(/^(BALANCE_BELOW_LIMIT|ALREADY_REVERSED)$/);
      }
    }
    for (const [k, acc] of accs.entries()) {
      const v = await verifyBalance(pool, acc.id);
      expect(v).toEqual({ cached: model[k], computed: model[k], ok: true });
      if (acc.minBalance !== null) expect(v.cached).toBeGreaterThanOrEqual(acc.minBalance);
      const chain = await listEntries(pool, acc.id, { limit: 500 });
      let running = 0;
      for (const e of [...chain].sort((a, b) => a.id - b.id)) {
        running += e.amount;
        expect(e.balanceAfter).toBe(running);
      }
    }
  });
});
