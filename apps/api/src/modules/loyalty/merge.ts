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
//   к основной (закрывает корректировка основной). История (начисления, штрафы, партии, товары) остаётся по id второй;
//   их коррекции после слияния – loyalty/merged.ts (D5-09). Сам перенос – transferBalance там же.
import type { Db, Tx as AuditTx } from '../../core/audit.ts';
import { ensureAccount, lockAccounts, type Tx } from '../../core/ledger.ts';
import type { ClientMerger, MergeContext } from '../clients/merge.ts';
import { accountRef, expireDue, getBalance, POINTS_MIN_BALANCE } from './account.ts';
import { transferBalance } from './merged.ts';

/** tx – клиент pg транзакции слияния: тип audit.ts уже типа ledger.ts, приводим один раз (как events/gift-booking). */
export async function reassignLoyalty(atx: AuditTx, from: string, to: string, ctx: MergeContext): Promise<Record<string, number>> {
  const tx = atx as unknown as Tx;
  const opts = { unit: 'POINT_CENTI' as const, branchId: null, minBalance: POINTS_MIN_BALANCE };
  const accFrom = await ensureAccount(tx, accountRef(from), opts);
  const accTo = await ensureAccount(tx, accountRef(to), opts);
  await lockAccounts(tx, [accFrom.id, accTo.id]);
  await expireDue(tx, from, ctx.now);
  await expireDue(tx, to, ctx.now);
  const moved = await transferBalance(tx, from, to, {
    key: (s) => `client-merge:${ctx.mergeId}:${s}`, refs: { mergeId: ctx.mergeId }, author: { type: 'staff', id: ctx.staffId }, now: ctx.now,
    ref: { type: 'client_merge', id: ctx.mergeId },
  });
  const reserves = (await tx.query(`UPDATE app.loyalty_reserves SET client_id = $2 WHERE client_id = $1 AND status IN ('hold','booking')`, [from, to])).rowCount ?? 0;
  const issues = (await tx.query(`UPDATE app.loyalty_issues SET client_id = $2 WHERE client_id = $1 AND status = 'open'`, [from, to])).rowCount ?? 0;
  return { ...moved, reserves, issues };
}

export const loyaltyClientMerger: ClientMerger = {
  name: 'loyalty',
  /** Счета обеих карточек – до броней и клиентов (K17: счёт раньше строки брони). */
  async prelock(atx: AuditTx, from: string, to: string): Promise<void> {
    const tx = atx as unknown as Tx;
    const opts = { unit: 'POINT_CENTI' as const, branchId: null, minBalance: POINTS_MIN_BALANCE };
    const a = await ensureAccount(tx, accountRef(from), opts);
    const b = await ensureAccount(tx, accountRef(to), opts);
    await lockAccounts(tx, [a.id, b.id]);
  },
  async preview(db: Db, clientId: string, now: Date) {
    const b = await getBalance(db as unknown as Tx, clientId, now);
    return { balanceCenti: b.balanceCenti, availableCenti: b.availableCenti, reservedCenti: b.reservedCenti, preBookingBlocked: b.preBookingBlocked };
  },
  reassign: reassignLoyalty,
};
