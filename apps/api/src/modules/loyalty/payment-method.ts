// K10 §5, K15 §6: обработчик способа оплаты points. finance вызывает его по реестру способов (finance/methods.ts),
// регистрирует server.ts – модули друг друга не импортируют (ADR 0002).
// charge: минуты брони × 100 (1 балл = 1 минута, 07 §6.1), доступно для этой брони = max(0, баланс) − резервы других
// удержаний и броней (резерв самой брони и удержания, из которого она создана, – не вычитаются: worker мог ещё не
// обработать booking.confirmed; позже convertReserves закроет резерв удержания, на оплаченную бронь не создаст); меньше – POINTS_INSUFFICIENT с двумя числами, доплата не предлагается (07 §6.2). Расход FEFO,
// loyalty.spend_time, резерв брони → spent. Списание никогда не уводит баланс ниже 0 (минус бывает только от штрафа).
// refund: только целиком (частичный режет finance – REFUND_PARTIAL_NOT_ALLOWED); возврат в исходные партии (§7):
// истёкшая часть – «не возвращено»; всё истекло – outcome 'not_restored'.
// Порядок: openAccount (блокировка счёта) → перечитать резервы и остаток → проверить → провести.
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { resolveSetting } from '../../core/settings.ts';
import type { ChargeInput, ChargeResult, PaymentMethodHandler, RefundInput, RefundResult } from '../finance/methods.ts';
import { debitBatches, openAccount, postPoints, reservedCenti, returnSpend } from './account.ts';
import { settleStaleReserves } from './reserve.ts';

async function postingOf(tx: Tx, entryId: number): Promise<string> {
  return (await tx.query<{ posting_id: string }>('SELECT posting_id FROM journal.ledger_entries WHERE id = $1', [entryId])).rows[0]!.posting_id;
}

export async function chargePoints(tx: Tx, input: ChargeInput): Promise<ChargeResult> {
  const { session } = input;
  const acc = await openAccount(tx, session.clientId, input.occurredAt);
  const allowed = (await resolveSetting(tx, 'loyalty.points_resource_types', { branchId: session.branchId }, input.occurredAt)).value;
  if (!allowed.includes(input.resourceType)) {
    throw new AppError('POINTS_NOT_ALLOWED', 422, 'Этот вид посещения баллами не оплачивается', { resourceType: input.resourceType });
  }
  if (!Number.isSafeInteger(input.minutes) || input.minutes <= 0) throw new AppError('VALIDATION_FAILED', 400, 'Минуты сеанса – целое > 0', { minutes: input.minutes });
  const required = input.minutes * 100;
  // повтор с тем же ключом – прежняя проводка (K3), без повторной проверки остатка
  const prior = (await tx.query<{ id: string; posting_id: string }>('SELECT id, posting_id FROM journal.ledger_entries WHERE idempotency_key = $1', [`${input.idempotencyKey}#0`])).rows[0];
  if (prior) return { postingId: prior.posting_id, amountKop: input.amountKop, pointsCenti: required };
  await settleStaleReserves(tx, acc.clientId, input.occurredAt);
  const available = Math.max(0, Math.max(0, acc.balance) - (await reservedCenti(tx, acc.clientId, input.occurredAt, { bookingId: session.bookingId, ...(input.holdId ? { holdId: input.holdId } : {}) })));
  if (available < required) {
    throw new AppError('POINTS_INSUFFICIENT', 409, 'Баллов недостаточно для оплаты сеанса', { availableCenti: available, requiredCenti: required });
  }
  const p = await postPoints(
    tx,
    acc.clientId,
    { amount: -required, type: 'loyalty.spend_time', branchId: session.branchId, occurredAt: input.occurredAt, ref: { type: 'booking', id: session.bookingId }, refs: { sessionId: session.id, lineNo: String(input.lineNo) } },
    input.idempotencyKey,
    input.author,
  );
  await debitBatches(tx, { clientId: acc.clientId, entryId: p.entryId, amount: required, balanceBefore: p.balanceBefore, kind: 'spend_time', ref: { type: 'booking', id: session.bookingId } });
  await tx.query(`UPDATE app.loyalty_reserves SET status = 'spent', closed_at = $2 WHERE booking_id = $1 AND status = 'booking'`, [session.bookingId, input.occurredAt]);
  return { postingId: await postingOf(tx, p.entryId), amountKop: input.amountKop, pointsCenti: required };
}

export async function refundPoints(tx: Tx, input: RefundInput): Promise<RefundResult> {
  const orig = (await tx.query<{ id: string }>(`SELECT id FROM journal.ledger_entries WHERE posting_id = $1 AND entry_type = 'loyalty.spend_time'`, [input.line.ledgerPostingId])).rows[0];
  if (!orig) throw new AppError('NOT_FOUND', 404, 'Списание баллов по строке платежа не найдено', { postingId: input.line.ledgerPostingId });
  const r = await returnSpend(tx, { originalEntryId: Number(orig.id), reason: input.reason, idempotencyKey: input.idempotencyKey, author: input.author, occurredAt: input.occurredAt });
  if (r.entryId === null) return { postingId: null, outcome: 'not_restored' };
  return { postingId: await postingOf(tx, r.entryId), outcome: 'returned' };
}

export const pointsPaymentMethod: PaymentMethodHandler = { method: 'points', charge: chargePoints, refund: refundPoints };
