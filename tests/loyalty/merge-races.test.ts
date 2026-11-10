// K9 «Слияние» × K15: коррекции баллов, которые стартовали во время слияния (ревизия 10.11, сценарии R1–R3).
// Обработчик читает клиента брони без замка (там ещё вторая карточка), ждёт её счёт, который держит слияние; после коммита
// слияния карточка уже merged. Требование (D5-09): работать со старым id нельзя – openAccount под замком видит merged и
// бросает CLIENT_MERGED, outbox повторяет обработчик, повтор читает уже основную. Итог: баллы не появляются из ничего,
// долг не остаётся на merged, предел −50 – по действующей основной.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { Tx } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bookingClientMerger } from '../../apps/api/src/modules/booking/merge.ts';
import { certificatesClientMerger } from '../../apps/api/src/modules/certificates/merge.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { clearClientMergers, mergeClients, registerClientMerger } from '../../apps/api/src/modules/clients/merge.ts';
import { eventsClientMerger } from '../../apps/api/src/modules/events/merge.ts';
import { financeClientMerger } from '../../apps/api/src/modules/finance/merge.ts';
import { createBatch, debitBatches, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { onVisitReverted, type AccrualDeps } from '../../apps/api/src/modules/loyalty/accrual.ts';
import { adjust } from '../../apps/api/src/modules/loyalty/adjust.ts';
import { issueGoods } from '../../apps/api/src/modules/loyalty/goods.ts';
import { loyaltyClientMerger } from '../../apps/api/src/modules/loyalty/merge.ts';
import { revertPenalty, type PenaltyDeps } from '../../apps/api/src/modules/loyalty/penalty.ts';
import { notificationsClientMerger } from '../../apps/api/src/modules/notifications/merge.ts';
import { createTestBooking } from '../helpers/booking.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestPayment } from '../helpers/payment.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-20T07:00:00Z');
const NOW = clock.now();
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let branchId = '';
let seq = 79240000000;
const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });
const addClient = async () =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`, [`+${++seq}`])).rows[0]!.id;
const bal = async (id: string) => (await getBalance(pool, id, NOW)).balanceCenti;
const merge = (p: string, s: string) => withTx(pool, (tx) => mergeClients(tx, owner, { primaryId: p, secondaryId: s, reason: 'same_person_confirmed' }, meta(), undefined, clock));

async function accrueVisit(clientId: string, amount: number): Promise<{ visitId: string; bookingId: string }> {
  const bookingId = await createTestBooking(db.client, { clientId, branchId, status: 'completed' });
  const visitId = (await db.client.query<{ id: string }>(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, now(), $4) RETURNING id`, [bookingId, branchId, clientId, owner.actor.staffId])).rows[0]!.id;
  const paymentId = await createTestPayment(db.client, bookingId);
  await withTx(pool, async (tx) => {
    await openAccount(tx, clientId, NOW);
    const p = await postPoints(tx, clientId, { amount, type: 'loyalty.accrual', branchId, occurredAt: NOW, ref: { type: 'visit', id: visitId } }, randomUUID(), SYSTEM_AUTHOR);
    await createBatch(tx, { clientId, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, source: 'visit', branchId, bookingId, visitId, expiresAt: null, accruedAt: NOW });
    await tx.query(`INSERT INTO app.loyalty_accruals (client_id, booking_id, visit_id, payment_id, ledger_entry_id, amount_centi, planned_minutes) VALUES ($1, $2, $3, $4, $5, $6, 60)`, [clientId, bookingId, visitId, paymentId, p.entryId, amount]);
  });
  return { visitId, bookingId };
}
async function penalize(clientId: string): Promise<string> {
  const bookingId = await createTestBooking(db.client, { clientId, branchId, status: 'no_show' });
  const noShowId = (await db.client.query<{ id: string }>(`INSERT INTO app.no_shows (booking_id, branch_id, client_id, marked_at, marked_by) VALUES ($1, $2, $3, now(), $4) RETURNING id`, [bookingId, branchId, clientId, owner.actor.staffId])).rows[0]!.id;
  await withTx(pool, async (tx) => {
    await openAccount(tx, clientId, NOW);
    const p = await postPoints(tx, clientId, { amount: -500, type: 'loyalty.penalty', branchId, occurredAt: NOW, ref: { type: 'no_show', id: noShowId } }, `loyalty-penalty:${noShowId}`, SYSTEM_AUTHOR);
    await debitBatches(tx, { clientId, entryId: p.entryId, amount: 500, balanceBefore: p.balanceBefore, kind: 'penalty' });
    await tx.query(`INSERT INTO app.loyalty_penalties (client_id, booking_id, no_show_id, branch_id, applied_centi, ledger_entry_id, status) VALUES ($1, $2, $3, $4, -500, $5, 'active')`, [clientId, bookingId, noShowId, branchId, p.entryId]);
  });
  return bookingId;
}

const bookings = {
  bookingClient: async (tx: Tx, id: string) => (await tx.query<{ client_id: string }>('SELECT client_id FROM app.bookings WHERE id = $1', [id])).rows[0]?.client_id ?? null,
  payableBooking: async (tx: Tx, id: string) => {
    const r = (await tx.query<{ client_id: string; status: string; branch_id: string }>('SELECT client_id, status, branch_id FROM app.bookings WHERE id = $1', [id])).rows[0];
    return r ? { bookingId: id, branchId: r.branch_id, branchTimezone: 'Asia/Novosibirsk', clientId: r.client_id, status: r.status, minutes: 60, resourceType: 'pc' } : null;
  },
  activeVisit: async () => null,
  adjacentChain: async () => [],
};
const accrualDeps = { clock, bookings, payments: { livePayment: async () => null, paymentStatus: async () => 'refunded' } } as unknown as AccrualDeps;
const penaltyDeps = { clock, bookings } as unknown as PenaltyDeps;
const reverted = (acc: { visitId: string; bookingId: string }) => ({ payload: { visitId: acc.visitId, bookingId: acc.bookingId } }) as Parameters<typeof onVisitReverted>[1];

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (r.rows[0]!.n > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('обработчик не ждёт замка');
}
/** Слияние в открытой транзакции; обработчик стартует, пока слияние держит замки; коммит слияния; ответ обработчика. */
async function duringMerge(p: string, s: string, handler: (tx: Tx) => Promise<unknown>): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await mergeClients(c, owner, { primaryId: p, secondaryId: s, reason: 'same_person_confirmed' }, meta(), undefined, clock);
    const h = codeOf(withTx(pool, (tx) => handler(tx as unknown as Tx)));
    await waitForLockWait();
    await c.query('COMMIT');
    return await h;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: NOW };
  branchId = (await createTestBranch(db.client)).id;
  clearClientMergers();
  for (const m of [bookingClientMerger, financeClientMerger, loyaltyClientMerger, certificatesClientMerger, eventsClientMerger, notificationsClientMerger]) registerClientMerger(m);
});
afterAll(async () => {
  clearClientMergers();
  await pool.end();
  await db.drop();
});

describe('коррекция, стартовавшая во время слияния', () => {
  it('R1 сторно начисления второй во время слияния: первая попытка – CLIENT_MERGED (повтор), повтор – на основную', async () => {
    const p = await addClient();
    const m = await addClient();
    await accrueVisit(p, 2000);
    const acc = await accrueVisit(m, 1000);
    expect(await duringMerge(p, m, (tx) => onVisitReverted(tx, reverted(acc), accrualDeps))).toBe('CLIENT_MERGED');
    expect(await bal(p)).toBe(3000);
    expect(await bal(m)).toBe(0);
    await withTx(pool, (tx) => onVisitReverted(tx as unknown as Tx, reverted(acc), accrualDeps)); // повтор outbox
    expect(await bal(p)).toBe(2000);
    expect(await bal(m)).toBe(0);
    expect((await db.client.query('SELECT status FROM app.loyalty_accruals WHERE visit_id = $1', [acc.visitId])).rows[0].status).toBe('reversed');
  });

  it('R2 снятие штрафа второй во время слияния: событие не съедено – повтор снимает штраф у основной', async () => {
    const p = await addClient();
    const m = await addClient();
    await accrueVisit(p, 2000);
    await accrueVisit(m, 1000);
    const nb = await penalize(m);
    await db.client.query(`UPDATE app.bookings SET status = 'completed' WHERE id = $1`, [nb]);
    expect(await duringMerge(p, m, (tx) => revertPenalty(tx, { bookingId: nb }, penaltyDeps))).toBe('CLIENT_MERGED');
    expect(await bal(p)).toBe(2500);
    expect(await withTx(pool, (tx) => revertPenalty(tx as unknown as Tx, { bookingId: nb }, penaltyDeps))).toBe('reversed');
    expect(await bal(p)).toBe(3000);
    expect(await bal(m)).toBe(0);
  });

  it('R3 цепочка: основную объединяют в третью во время сторно начисления второй – сторно у последней, предел по ней', async () => {
    const p = await addClient();
    const m = await addClient();
    const q = await addClient();
    await accrueVisit(p, 2000);
    const acc = await accrueVisit(m, 1000);
    await merge(p, m);
    expect(await duringMerge(q, p, (tx) => onVisitReverted(tx, reverted(acc), accrualDeps))).toBe('CLIENT_MERGED');
    expect(await bal(q)).toBe(3000);
    await withTx(pool, (tx) => onVisitReverted(tx as unknown as Tx, reverted(acc), accrualDeps));
    expect(await bal(q)).toBe(2000);
    expect(await bal(p)).toBe(0);
    expect(await bal(m)).toBe(0);
  });

  it('корректировка и выдача товара на вторую во время слияния – CLIENT_MERGED под замком, счёт второй не тронут', async () => {
    const p = await addClient();
    const m = await addClient();
    await accrueVisit(m, 3000);
    const goodsId = (await db.client.query<{ id: string }>(`INSERT INTO app.loyalty_goods (name, price_points_centi) VALUES ('Кружка', 400) RETURNING id`)).rows[0]!.id;
    await db.client.query(`INSERT INTO app.loyalty_goods_branches (goods_id, branch_id, stock) VALUES ($1, $2, NULL)`, [goodsId, branchId]);
    expect(await duringMerge(p, m, (tx) => adjust(tx, owner, { clientId: m, deltaCenti: 100, reason: 'тест' }, meta(), clock))).toBe('CLIENT_MERGED');
    const q = await addClient();
    await accrueVisit(q, 3000);
    const r = await addClient();
    expect(await duringMerge(r, q, (tx) => issueGoods(tx, owner, { clientId: q, goodsId, branchId, idempotencyKey: randomUUID() }, meta(), clock))).toBe('CLIENT_MERGED');
    expect([await bal(m), await bal(p), await bal(q), await bal(r)]).toEqual([0, 3000, 0, 3000]);
  });
});
