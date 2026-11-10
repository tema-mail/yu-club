// K9 «Слияние», обработчик модуля loyalty (K15 §2, 03 §11.2 «нельзя просто складывать балансы»). Правило – решение D5-02:
// • Остаток второй карточки > 0: переносится партиями. На второй – одна запись K3 loyalty.manual −остаток и движения
//   партий вида merge (все партии → 0); на основной – по записи +r на каждую партию и новая партия с тем же сроком,
//   филиалом и посещением (refs.fromBatchId). Если у основной долг – новые партии сначала гасят его (debt_cover, как
//   любое начисление K15 §2). Итог: баланс основной = B1 + B2, срок каждой части не продлевается.
// • Остаток второй < 0 (долг от штрафов): на основную переносится долг с обрезкой у предела −50, как у штрафа (K15 §5):
//   перенесено = min(долг, max(0, B1 + 50)); остальное списывается (debtWrittenOffCenti в итогах). На второй долг
//   закрывается записью +долг. Итог: баланс основной = max(B1 + B2, −50) при B1 ≥ −50; ниже −50 не уводит никогда.
// • Вторая карточка после слияния – баланс 0, партий с остатком нет. Счета блокируются вместе в порядке id (K3).
// • Живые резервы (удержание, бронь) едут вместе с бронями (booking переносит брони первым); открытые «требует решения» –
//   к основной (закрывает корректировка основной). История (начисления, штрафы, партии, товары) остаётся по id второй.
import type { Db, Tx } from '../../core/audit.ts';
import { ensureAccount, lockAccounts } from '../../core/ledger.ts';
import type { ClientMerger, MergeContext } from '../clients/merge.ts';
import { accountRef, createBatch, debitBatches, expireDue, getBalance, POINTS_MIN_BALANCE, postPoints } from './account.ts';

const BASIS = 'Слияние карточек клиента';
const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

interface BatchRow {
  id: string;
  remaining_centi: string;
  branch_id: string | null;
  booking_id: string | null;
  visit_id: string | null;
  expires_at: Date | null;
  accrued_at: Date;
}

async function balanceOf(tx: Tx, accountId: string): Promise<number> {
  return num((await tx.query<{ balance: string }>('SELECT balance FROM app.ledger_accounts WHERE id = $1', [accountId])).rows[0]?.balance);
}

export async function reassignLoyalty(tx: Tx, from: string, to: string, ctx: MergeContext): Promise<Record<string, number>> {
  const opts = { unit: 'POINT_CENTI' as const, branchId: null, minBalance: POINTS_MIN_BALANCE };
  const accFrom = await ensureAccount(tx, accountRef(from), opts);
  const accTo = await ensureAccount(tx, accountRef(to), opts);
  await lockAccounts(tx, [accFrom.id, accTo.id]);
  await expireDue(tx, from, ctx.now);
  await expireDue(tx, to, ctx.now);
  const author = { type: 'staff' as const, id: ctx.staffId };
  const refs = { mergeId: ctx.mergeId };
  const key = (s: string) => `client-merge:${ctx.mergeId}:${s}`;
  const bFrom = await balanceOf(tx, accFrom.id);
  let movedCenti = 0;
  let debtWrittenOffCenti = 0;
  let batches = 0;

  if (bFrom > 0) {
    const rows = (
      await tx.query<BatchRow>(
        `SELECT id, remaining_centi, branch_id, booking_id, visit_id, expires_at, accrued_at FROM app.loyalty_batches
         WHERE client_id = $1 AND status = 'active' AND remaining_centi > 0 ORDER BY expires_at NULLS LAST, accrued_at, id FOR UPDATE`,
        [from],
      )
    ).rows;
    const out = await postPoints(tx, from, { amount: -bFrom, type: 'loyalty.manual', basis: BASIS, branchId: null, occurredAt: ctx.now, refs: { ...refs, toClientId: to } }, key('out'), author);
    await debitBatches(tx, { clientId: from, entryId: out.entryId, amount: bFrom, balanceBefore: out.balanceBefore, kind: 'merge', ref: { type: 'client_merge', id: ctx.mergeId } });
    for (const b of rows) {
      const r = num(b.remaining_centi);
      const p = await postPoints(
        tx, to,
        { amount: r, type: 'loyalty.manual', basis: BASIS, branchId: b.branch_id, occurredAt: ctx.now, refs: { ...refs, fromBatchId: b.id, fromClientId: from } },
        key(`in:${b.id}`), author,
      );
      await createBatch(tx, {
        clientId: to, entryId: p.entryId, amount: r, balanceBefore: p.balanceBefore, source: 'manual', branchId: b.branch_id,
        bookingId: b.booking_id, visitId: b.visit_id, expiresAt: b.expires_at, accruedAt: b.accrued_at,
      });
      batches++;
    }
    movedCenti = bFrom;
  } else if (bFrom < 0) {
    const debt = -bFrom;
    const bTo = await balanceOf(tx, accTo.id);
    const take = Math.min(debt, Math.max(0, bTo - POINTS_MIN_BALANCE));
    debtWrittenOffCenti = debt - take;
    const settle = await postPoints(tx, from, { amount: debt, type: 'loyalty.manual', basis: BASIS, branchId: null, occurredAt: ctx.now, refs: { ...refs, toClientId: to } }, key('settle'), author);
    await createBatch(tx, { clientId: from, entryId: settle.entryId, amount: debt, balanceBefore: settle.balanceBefore, source: 'manual', branchId: null, expiresAt: null, accruedAt: ctx.now });
    if (take > 0) {
      const p = await postPoints(tx, to, { amount: -take, type: 'loyalty.manual', basis: BASIS, branchId: null, occurredAt: ctx.now, refs: { ...refs, fromClientId: from } }, key('debt'), author);
      await debitBatches(tx, { clientId: to, entryId: p.entryId, amount: take, balanceBefore: p.balanceBefore, kind: 'merge', ref: { type: 'client_merge', id: ctx.mergeId } });
    }
    movedCenti = -take;
  }

  const reserves = (await tx.query(`UPDATE app.loyalty_reserves SET client_id = $2 WHERE client_id = $1 AND status IN ('hold','booking')`, [from, to])).rowCount ?? 0;
  const issues = (await tx.query(`UPDATE app.loyalty_issues SET client_id = $2 WHERE client_id = $1 AND status = 'open'`, [from, to])).rowCount ?? 0;
  return { movedCenti, debtWrittenOffCenti, batches, reserves, issues };
}

export const loyaltyClientMerger: ClientMerger = {
  name: 'loyalty',
  /** Счета обеих карточек – до броней и клиентов (K17: счёт раньше строки брони). */
  async prelock(tx: Tx, from: string, to: string): Promise<void> {
    const opts = { unit: 'POINT_CENTI' as const, branchId: null, minBalance: POINTS_MIN_BALANCE };
    const a = await ensureAccount(tx, accountRef(from), opts);
    const b = await ensureAccount(tx, accountRef(to), opts);
    await lockAccounts(tx, [a.id, b.id]);
  },
  async preview(db: Db, clientId: string, now: Date) {
    const b = await getBalance(db, clientId, now);
    return { balanceCenti: b.balanceCenti, availableCenti: b.availableCenti, reservedCenti: b.reservedCenti, preBookingBlocked: b.preBookingBlocked };
  },
  reassign: reassignLoyalty,
};
