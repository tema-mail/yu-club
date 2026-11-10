// K9 «Слияние» × K15: перенос баллов по правилу D5-02 на настоящей Postgres под yu_app. Баланс K3 сходится с партиями
// (Σ remaining = max(0, баланс)), у второй карточки 0 и нет остатка партий, сроки частей не продлеваются, долг – с обрезкой −50,
// резервы живых броней и открытые «требует решения» едут к основной, повтор ключа K3 не задваивает.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBalance, type Tx } from '../../apps/api/src/core/ledger.ts';
import { createBatch, debitBatches, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { loyaltyClientMerger, reassignLoyalty } from '../../apps/api/src/modules/loyalty/merge.ts';
import { createTestBooking } from '../helpers/booking.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const STAFF = 'cccccccc-0000-4000-8000-00000000000c';
const NOW = new Date('2026-11-20T07:00:00Z');
const DAY = 86_400_000;
let db: TestDatabase;
let pool: pg.Pool;
let branchId = '';
let seq = 79190000000;

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
const newClient = async () =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'Т', 'active', 'system', now()) RETURNING id`, [`+${++seq}`])).rows[0]!.id;

async function accrue(clientId: string, amount: number, expiresAt: Date | null = null): Promise<string> {
  return inTx(async (tx) => {
    await openAccount(tx, clientId, NOW);
    const p = await postPoints(tx, clientId, { amount, type: 'loyalty.accrual', branchId: null, occurredAt: NOW }, randomUUID(), SYSTEM_AUTHOR);
    return createBatch(tx, { clientId, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt, accruedAt: NOW });
  });
}
async function penalty(clientId: string, amount: number): Promise<void> {
  await inTx(async (tx) => {
    await openAccount(tx, clientId, NOW);
    const p = await postPoints(tx, clientId, { amount: -amount, type: 'loyalty.penalty', branchId: null, occurredAt: NOW }, randomUUID(), SYSTEM_AUTHOR);
    await debitBatches(tx, { clientId, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, kind: 'penalty' });
  });
}
const ctx = () => ({ mergeId: randomUUID(), staffId: STAFF, reason: 'same_person_confirmed' as const, now: NOW });
const bal = async (id: string) => (await getBalance(pool, id, NOW)).balanceCenti;
const remaining = async (id: string) =>
  Number((await db.client.query<{ s: string | null }>(`SELECT sum(remaining_centi) AS s FROM app.loyalty_batches WHERE client_id = $1 AND status = 'active'`, [id])).rows[0]!.s ?? 0);
async function consistent(id: string): Promise<void> {
  expect(await remaining(id)).toBe(Math.max(0, await bal(id)));
  const acc = (await db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_id = $1`, [id])).rows[0];
  if (acc) expect((await verifyBalance(db.client, acc.id)).ok).toBe(true);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  branchId = (await createTestBranch(db.client)).id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('перенос баллов при слиянии (D5-02)', () => {
  it('плюс к плюсу: баланс основной = сумма, партии со своими сроками, у второй 0; движения merge', async () => {
    const a = await newClient();
    const b = await newClient();
    await accrue(a, 3000);
    const exp = new Date(NOW.getTime() + 30 * DAY);
    const b1 = await accrue(b, 2000, exp);
    await accrue(b, 1500);
    await penalty(b, 500); // FEFO: из партии со сроком
    const before = (await bal(a)) + (await bal(b));
    expect(before).toBe(3000 + 3000);

    const r = await inTx((tx) => reassignLoyalty(tx, b, a, ctx()));
    expect(r).toEqual({ movedCenti: 3000, debtWrittenOffCenti: 0, batches: 2, reserves: 0, issues: 0 });
    expect(await bal(a)).toBe(before);
    expect(await bal(b)).toBe(0);
    expect(await remaining(b)).toBe(0);
    await consistent(a);
    await consistent(b);
    // часть со сроком переехала с тем же сроком, не продлилась
    const moved = (await db.client.query(`SELECT amount_centi, expires_at, source FROM app.loyalty_batches WHERE client_id = $1 AND source = 'manual' ORDER BY expires_at NULLS LAST`, [a])).rows;
    expect(moved).toEqual([{ amount_centi: '1500', expires_at: exp, source: 'manual' }, { amount_centi: '1500', expires_at: null, source: 'manual' }]);
    const moves = (await db.client.query(`SELECT batch_id, delta_centi FROM journal.loyalty_batch_moves WHERE kind = 'merge' AND batch_id IN (SELECT id FROM app.loyalty_batches WHERE client_id = $1) ORDER BY id`, [b])).rows;
    expect(moves.reduce((s, m) => s + Number(m.delta_centi), 0)).toBe(-3000);
    expect(moves.some((m) => m.batch_id === b1)).toBe(true);
  });

  it('плюс второй гасит долг основной: баланс основной = B1 + B2', async () => {
    const a = await newClient();
    const b = await newClient();
    await penalty(a, 2000); // −20
    await accrue(b, 3500);
    await inTx((tx) => reassignLoyalty(tx, b, a, ctx()));
    expect(await bal(a)).toBe(1500);
    await consistent(a);
    expect(await bal(b)).toBe(0);
  });

  it('долг второй переносится с обрезкой у −50: −30 и −40 → −50, списано 20 баллов', async () => {
    const a = await newClient();
    const b = await newClient();
    await penalty(a, 3000);
    await penalty(b, 4000);
    const r = await inTx((tx) => reassignLoyalty(tx, b, a, ctx()));
    expect(r).toMatchObject({ movedCenti: -2000, debtWrittenOffCenti: 2000 });
    expect(await bal(a)).toBe(-5000);
    expect(await bal(b)).toBe(0);
    await consistent(a);
    await consistent(b);
  });

  it('долг второй, у основной плюс: долг съедает партии основной; без обрезки баланс = B1 + B2', async () => {
    const a = await newClient();
    const b = await newClient();
    await accrue(a, 1000);
    await penalty(b, 2500);
    const r = await inTx((tx) => reassignLoyalty(tx, b, a, ctx()));
    expect(r).toMatchObject({ movedCenti: -2500, debtWrittenOffCenti: 0 });
    expect(await bal(a)).toBe(-1500);
    await consistent(a);
  });

  it('пустые счета и счёта нет – ничего не пишется; резервы живых броней и открытые issues едут к основной', async () => {
    const a = await newClient();
    const b = await newClient();
    const bk = await createTestBooking(db.client, { clientId: b, branchId });
    await db.client.query(`INSERT INTO app.loyalty_reserves (client_id, amount_centi, booking_id, status) VALUES ($1, 600, $2, 'booking')`, [b, bk]);
    await db.client.query(`INSERT INTO app.loyalty_issues (client_id, kind, ref_type, ref_id, amount_centi) VALUES ($1, 'accrual_reversal_below_limit', 'visit', gen_random_uuid(), 100)`, [b]);
    const r = await inTx((tx) => reassignLoyalty(tx, b, a, ctx()));
    expect(r).toEqual({ movedCenti: 0, debtWrittenOffCenti: 0, batches: 0, reserves: 1, issues: 1 });
    expect((await db.client.query(`SELECT count(*)::int AS n FROM journal.ledger_entries e JOIN app.ledger_accounts x ON x.id = e.account_id WHERE x.owner_id = ANY($1::uuid[])`, [[a, b]])).rows[0].n).toBe(0);
    expect((await getBalance(pool, a, NOW)).reservedCenti).toBe(600);
  });

  it('предпросмотр отдаёт баланс, доступно и резерв без истории', async () => {
    const a = await newClient();
    await accrue(a, 1200);
    expect(await loyaltyClientMerger.preview(pool, a, NOW)).toEqual({ balanceCenti: 1200, availableCenti: 1200, reservedCenti: 0, preBookingBlocked: false });
  });
});
