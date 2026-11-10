// K9 «Слияние» × K15: коррекции операций, сделанных до слияния, после слияния (D5-09) – на настоящей Postgres и настоящих
// командах loyalty. Начисление, штраф, оплата баллами и товар записаны на вторую карточку; после слияния:
// сторно начисления, снятие штрафа, возврат оплаты баллами, возврат товара → у объединённой карточки баланс 0 и нет
// остатка партий, основная получает (или теряет) ровно сумму коррекции; основную потом объединили ещё раз – коррекция
// доходит до последней в цепочке. Баланс K3 и партии сходятся (Σ remaining = max(0, баланс)).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { verifyBalance, type Tx } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bookingClientMerger } from '../../apps/api/src/modules/booking/merge.ts';
import { certificatesClientMerger } from '../../apps/api/src/modules/certificates/merge.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { clearClientMergers, mergeClients, registerClientMerger } from '../../apps/api/src/modules/clients/merge.ts';
import { eventsClientMerger } from '../../apps/api/src/modules/events/merge.ts';
import { financeClientMerger } from '../../apps/api/src/modules/finance/merge.ts';
import type { PaymentLine } from '../../apps/api/src/modules/finance/methods.ts';
import { createBatch, debitBatches, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { reverseAccrual } from '../../apps/api/src/modules/loyalty/accrual.ts';
import { issueGoods, returnGoods } from '../../apps/api/src/modules/loyalty/goods.ts';
import { loyaltyClientMerger } from '../../apps/api/src/modules/loyalty/merge.ts';
import { refundPoints } from '../../apps/api/src/modules/loyalty/payment-method.ts';
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
let seq = 79230000000;
const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });

const addClient = async () =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`, [`+${++seq}`])).rows[0]!.id;
const bal = async (id: string) => (await getBalance(pool, id, NOW)).balanceCenti;
async function consistent(id: string): Promise<void> {
  const rem = Number((await db.client.query<{ s: string | null }>(`SELECT sum(remaining_centi) AS s FROM app.loyalty_batches WHERE client_id = $1 AND status = 'active'`, [id])).rows[0]!.s ?? 0);
  expect(rem).toBe(Math.max(0, await bal(id)));
  const acc = (await db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_id = $1`, [id])).rows[0];
  if (acc) expect((await verifyBalance(db.client, acc.id)).ok).toBe(true);
}
const merge = (p: string, s: string) => withTx(pool, (tx) => mergeClients(tx, owner, { primaryId: p, secondaryId: s, reason: 'same_person_confirmed' }, meta(), undefined, clock));

/** Начисление за посещение «как accrual.ts»: запись K3, партия, строка loyalty_accruals. */
async function accrueVisit(clientId: string, amount: number): Promise<{ visitId: string; bookingId: string }> {
  const bookingId = await createTestBooking(db.client, { clientId, branchId, status: 'completed' });
  const visitId = (await db.client.query<{ id: string }>(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, now(), $4) RETURNING id`, [bookingId, branchId, clientId, owner.actor.staffId])).rows[0]!.id;
  const paymentId = await createTestPayment(db.client, bookingId);
  await withTx(pool, async (tx) => {
    await openAccount(tx, clientId, NOW);
    const p = await postPoints(tx, clientId, { amount, type: 'loyalty.accrual', branchId, occurredAt: NOW, ref: { type: 'visit', id: visitId } }, randomUUID(), SYSTEM_AUTHOR);
    await createBatch(tx, { clientId, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, source: 'visit', branchId, bookingId, visitId, expiresAt: null, accruedAt: NOW });
    await tx.query(
      `INSERT INTO app.loyalty_accruals (client_id, booking_id, visit_id, payment_id, ledger_entry_id, amount_centi, planned_minutes) VALUES ($1, $2, $3, $4, $5, $6, 60)`,
      [clientId, bookingId, visitId, paymentId, p.entryId, amount],
    );
  });
  return { visitId, bookingId };
}

/** Штраф за неявку «как penalty.ts»: no_show, запись K3, расход партий, строка loyalty_penalties. */
async function penalize(clientId: string): Promise<string> {
  const bookingId = await createTestBooking(db.client, { clientId, branchId, status: 'no_show' });
  const noShowId = (await db.client.query<{ id: string }>(`INSERT INTO app.no_shows (booking_id, branch_id, client_id, marked_at, marked_by) VALUES ($1, $2, $3, now(), $4) RETURNING id`, [bookingId, branchId, clientId, owner.actor.staffId])).rows[0]!.id;
  await withTx(pool, async (tx) => {
    await openAccount(tx, clientId, NOW);
    const p = await postPoints(tx, clientId, { amount: -500, type: 'loyalty.penalty', branchId, occurredAt: NOW, ref: { type: 'no_show', id: noShowId } }, `loyalty-penalty:${noShowId}`, SYSTEM_AUTHOR);
    await debitBatches(tx, { clientId, entryId: p.entryId, amount: 500, balanceBefore: p.balanceBefore, kind: 'penalty' });
    await tx.query(
      `INSERT INTO app.loyalty_penalties (client_id, booking_id, no_show_id, branch_id, applied_centi, ledger_entry_id, status) VALUES ($1, $2, $3, $4, -500, $5, 'active')`,
      [clientId, bookingId, noShowId, branchId, p.entryId],
    );
  });
  return bookingId;
}

/** Оплата сеанса баллами – запись spend_time (posting_id – строка платежа). */
async function spend(clientId: string, amount: number): Promise<string> {
  return withTx(pool, async (tx) => {
    await openAccount(tx, clientId, NOW);
    const p = await postPoints(tx, clientId, { amount: -amount, type: 'loyalty.spend_time', branchId, occurredAt: NOW }, randomUUID(), SYSTEM_AUTHOR);
    await debitBatches(tx, { clientId, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, kind: 'spend_time' });
    return (await tx.query<{ posting_id: string }>('SELECT posting_id FROM journal.ledger_entries WHERE id = $1', [p.entryId])).rows[0]!.posting_id;
  });
}

const penaltyDeps: PenaltyDeps = {
  clock,
  bookings: {
    bookingClient: async (tx, id) => (await tx.query<{ client_id: string }>('SELECT client_id FROM app.bookings WHERE id = $1', [id])).rows[0]?.client_id ?? null,
    payableBooking: async (tx, id) => {
      const r = (await tx.query<{ client_id: string; status: string; branch_id: string }>('SELECT client_id, status, branch_id FROM app.bookings WHERE id = $1', [id])).rows[0];
      return r ? { bookingId: id, branchId: r.branch_id, branchTimezone: 'Asia/Novosibirsk', clientId: r.client_id, status: r.status, minutes: 60, resourceType: 'pc' } : null;
    },
    adjacentChain: async () => [],
  },
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
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

describe('коррекции операций до слияния (D5-09)', () => {
  it('сторно начисления, снятие штрафа, возврат оплаты баллами и товара: вторая = 0, основная ± ровно сумма', async () => {
    const p = await addClient();
    const m = await addClient();
    await accrueVisit(p, 2000);
    const acc = await accrueVisit(m, 1000);
    await accrueVisit(m, 3000);
    const noShowBooking = await penalize(m);
    const posting = await spend(m, 600);
    const goodsId = (await db.client.query<{ id: string }>(`INSERT INTO app.loyalty_goods (name, price_points_centi) VALUES ('Кружка', 400) RETURNING id`)).rows[0]!.id;
    await db.client.query(`INSERT INTO app.loyalty_goods_branches (goods_id, branch_id, stock) VALUES ($1, $2, NULL)`, [goodsId, branchId]);
    const order = await withTx(pool, (tx) => issueGoods(tx as unknown as Tx, owner, { clientId: m, goodsId, branchId, idempotencyKey: randomUUID() }, meta(), clock));
    expect(await bal(m)).toBe(1000 + 3000 - 500 - 600 - 400);

    await merge(p, m);
    expect(await bal(m)).toBe(0);
    let expected = 2000 + 2500;
    expect(await bal(p)).toBe(expected);

    // 1. сторно начисления (посещение исправлено): бронь уже у основной – основная −1000
    const r1 = await withTx(pool, (tx) => reverseAccrual(tx as unknown as Tx, p, { visitId: acc.visitId }, 'visit_reverted', { type: 'visit', id: acc.visitId }, clock));
    expect(r1).toBe('reversed');
    expected -= 1000;
    expect(await bal(p)).toBe(expected);
    expect(await bal(m)).toBe(0);
    expect((await db.client.query(`SELECT status FROM app.loyalty_accruals WHERE visit_id = $1`, [acc.visitId])).rows[0].status).toBe('reversed');

    // 2. снятие штрафа (неявку исправили): основная +500
    await db.client.query(`UPDATE app.bookings SET status = 'completed' WHERE id = $1`, [noShowBooking]);
    expect(await withTx(pool, (tx) => revertPenalty(tx as unknown as Tx, { bookingId: noShowBooking }, penaltyDeps))).toBe('reversed');
    expected += 500;
    expect(await bal(p)).toBe(expected);
    expect(await bal(m)).toBe(0);

    // 3. возврат оплаты баллами: основная +600
    const line = { lineNo: 1, method: 'points', amountKop: 0, ledgerPostingId: posting } as PaymentLine;
    const r3 = await withTx(pool, (tx) => refundPoints(tx as unknown as Tx, { line, amountKop: 0, idempotencyKey: randomUUID(), author: { type: 'staff', id: owner.actor.staffId }, occurredAt: NOW, reason: 'возврат' }));
    expect(r3.outcome).toBe('returned');
    expected += 600;
    expect(await bal(p)).toBe(expected);
    expect(await bal(m)).toBe(0);

    // 4. основную объединили ещё раз – возврат товара доходит до последней в цепочке: +400
    const q = await addClient();
    await merge(q, p);
    expect(await bal(q)).toBe(expected);
    await withTx(pool, (tx) => returnGoods(tx as unknown as Tx, owner, { orderId: order.orderId, reason: 'не выдан' }, meta(), clock));
    expect(await bal(q)).toBe(expected + 400);
    expect(await bal(p)).toBe(0);
    expect(await bal(m)).toBe(0);
    for (const id of [m, p, q]) await consistent(id);
  });

  it('сторно начисления ниже −50 у основной – «требует решения» на основной, баланс не меняется', async () => {
    const p = await addClient();
    const m = await addClient();
    const acc = await accrueVisit(m, 1000);
    await merge(p, m);
    await withTx(pool, async (tx) => {
      await openAccount(tx, p, NOW);
      const e = await postPoints(tx, p, { amount: -5500, type: 'loyalty.penalty', branchId, occurredAt: NOW }, randomUUID(), SYSTEM_AUTHOR);
      await debitBatches(tx, { clientId: p, entryId: e.entryId, amount: 5500, balanceBefore: e.balanceBefore, kind: 'penalty' });
    });
    expect(await bal(p)).toBe(-4500);
    const r = await withTx(pool, (tx) => reverseAccrual(tx as unknown as Tx, p, { visitId: acc.visitId }, 'visit_reverted', { type: 'visit', id: acc.visitId }, clock));
    expect(r).toBe('issue');
    expect(await bal(p)).toBe(-4500);
    expect(await bal(m)).toBe(0);
    expect((await db.client.query(`SELECT client_id FROM app.loyalty_issues WHERE ref_id = $1`, [acc.visitId])).rows).toEqual([{ client_id: p }]);
  });
});
