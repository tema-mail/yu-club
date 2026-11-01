// S2-07: миграция 0201 – предел счёта K3 только для списаний (K3 правило 7, K15 §1).
// Счёт баллов: min_balance −5000 (−50). Ниже предела – только записью Владельца с allowBelowLimit.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAccount, getBalance, post, reverse, type AccountRef, type EntryInput, type Tx } from '../../apps/api/src/core/ledger.ts';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const at = new Date('2026-11-15T07:00:00Z');
const system = { type: 'system', id: null } as const;
const owner = { type: 'staff', id: randomUUID() } as const;

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
const e = (account: AccountRef, amount: number, type: EntryInput['type'], basis?: string): EntryInput => ({ account, amount, type, branchId: null, occurredAt: at, ...(basis ? { basis } : {}) });
const one = (account: AccountRef, amount: number, type: EntryInput['type'], extra: { override?: string } = {}) =>
  inTx((tx) =>
    post(tx, {
      entries: [e(account, amount, type, extra.override)],
      idempotencyKey: randomUUID(),
      author: extra.override ? owner : system,
      ...(extra.override ? { allowBelowLimit: { reason: extra.override } } : {}),
    }),
  );

/** Счёт баллов на −60 баллов: штраф −5 (запись, которую потом сторнируем) и корректировка Владельца ниже предела. */
async function accountAtMinus60(): Promise<{ ref: AccountRef; id: string; penaltyEntryId: number }> {
  const ref: AccountRef = { kind: 'loyalty_client', ownerType: 'client', ownerId: randomUUID() };
  const acc = await inTx((tx) => ensureAccount(tx, ref, { unit: 'POINT_CENTI', branchId: null, minBalance: -5000 }));
  const penalty = await one(ref, -500, 'loyalty.penalty');
  await one(ref, -5500, 'loyalty.manual', { override: 'корректировка Владельца ниже −50' });
  expect(await getBalance(pool, acc.id)).toBe(-6000);
  return { ref, id: acc.id, penaltyEntryId: penalty.entries[0]!.id };
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (err: { code?: string }) => err.code ?? String(err));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  pool.on('connect', (c) => {
    void c.query('SET ROLE yu_app');
  });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('0201: предел только для списаний', () => {
  it('при −60: проходят +5, возврат и сторно штрафа; баланс остаётся ниже предела', async () => {
    const a = await accountAtMinus60();
    await inTx((tx) => reverse(tx, { entryId: a.penaltyEntryId, reason: 'неявка исправлена', idempotencyKey: randomUUID(), author: system, occurredAt: at }));
    expect(await getBalance(pool, a.id)).toBe(-5500);
    await one(a.ref, 500, 'loyalty.accrual'); // +5 баллов за посещение
    expect(await getBalance(pool, a.id)).toBe(-5000); // ровно на пределе
    await one(a.ref, 100, 'loyalty.return'); // возврат в партию
    expect(await getBalance(pool, a.id)).toBe(-4900);
  });

  it('приход, после которого баланс всё ещё ниже предела, тоже проходит', async () => {
    const a = await accountAtMinus60();
    await one(a.ref, 500, 'loyalty.accrual');
    expect(await getBalance(pool, a.id)).toBe(-5500);
  });

  it('списание −1 ниже предела без права – BALANCE_BELOW_LIMIT; с allowBelowLimit – проходит', async () => {
    const a = await accountAtMinus60();
    expect(await code(one(a.ref, -1, 'loyalty.spend_time'))).toBe('BALANCE_BELOW_LIMIT');
    expect(await getBalance(pool, a.id)).toBe(-6000);
    await one(a.ref, -1, 'loyalty.manual', { override: 'Владелец' });
    expect(await getBalance(pool, a.id)).toBe(-6001);
  });

  it('выше предела поведение прежнее: списание за предел – отказ, до предела – проходит', async () => {
    const ref: AccountRef = { kind: 'certificate', ownerType: 'certificate', ownerId: randomUUID() };
    const acc = await inTx((tx) => ensureAccount(tx, ref, { unit: 'RUB_KOP', branchId: null, minBalance: 0 }));
    await one(ref, 1000, 'certificate.issue');
    expect(await code(one(ref, -1001, 'certificate.redeem'))).toBe('BALANCE_BELOW_LIMIT');
    await one(ref, -1000, 'certificate.redeem');
    expect(await getBalance(pool, acc.id)).toBe(0);
  });

  it('вниз – прежнее правило (приход ниже предела отклонялся), снова вверх – новое', async () => {
    const a = await accountAtMinus60();
    // Откат до 0201 включительно: младшие миграции Э2 (0202+) откатываются первыми и возвращаются следом.
    const later = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0201'`);
    const applied = await migrateDown(db.client, later.rows[0]!.n);
    expect(applied.at(-1)).toBe('0201');
    expect(await code(one(a.ref, 500, 'loyalty.accrual'))).toBe('BALANCE_BELOW_LIMIT');
    expect(await migrateUp(db.client)).toEqual([...applied].reverse());
    await one(a.ref, 500, 'loyalty.accrual');
    expect(await getBalance(pool, a.id)).toBe(-5500);
    const fn = await db.client.query(`SELECT prosecdef FROM pg_proc WHERE proname = 'ledger_apply_balance'`);
    expect(fn.rows).toEqual([{ prosecdef: true }]);
  });
});
