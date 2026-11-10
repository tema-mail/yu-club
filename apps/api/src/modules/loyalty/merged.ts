// K15 × K9 «Слияние»: баллы объединённой (merged) карточки. Записи K3 до слияния остаются на её счёте (журнал только на
// вставку, сторно – на счёт исходной записи), а действующий владелец – основная (merged_into_id цепочкой). Решение D5-09:
// коррекция операции до слияния проводится обычным путём на счёте второй карточки, а баланс второй тут же возвращается к 0
// переносом на основную – тем же правилом, что при слиянии (партиями с исходным сроком):
//   • приход на вторую (снятие штрафа, возврат оплаты баллами, возврат товара) → после него остаток второй переносится
//     на основную (sweepMerged); основная получает ровно сумму коррекции;
//   • расход со второй (сторно начисления) → сначала мост: основная −сумма, вторая +сумма (bridgeToMerged), затем
//     сторно на второй; предел −50 проверяет вызывающий по балансу основной.
// Замки: счёт основной раньше счёта второй (openWithOwner) – тот же порядок у всех коррекций, слияние второй не трогает.
import { effectiveClientId } from '../clients/merge.ts';
import type { Tx } from '../../core/ledger.ts';
import { accountRef, createBatch, debitBatches, openAccount, openClientAccount, POINTS_MIN_BALANCE, postPoints, returnSpend, type Author } from './account.ts';

export const MERGE_BASIS = 'Слияние карточек клиента';
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

export async function pointsBalance(tx: Tx, clientId: string): Promise<number> {
  const r = await tx.query<{ balance: string }>(
    `SELECT balance FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_type = 'client' AND owner_id = $1`,
    [accountRef(clientId).ownerId],
  );
  return num(r.rows[0]?.balance);
}

export interface TransferOptions {
  key: (part: string) => string;
  refs: Record<string, string>;
  author: Author;
  now: Date;
  /** Ссылка движений партий вида merge (журнал слияния или коррекция). */
  ref: { type: string; id: string };
}

/**
 * Перенос всего баланса from → to (счета уже заблокированы вызывающим, D5-02):
 * плюс – партиями (на from движения merge, на to по записи и партии на каждую часть с исходным сроком и посещением);
 * минус (долг) – на to с обрезкой у −50, как штраф (K15 §5), остаток списывается. После – баланс from = 0.
 */
export async function transferBalance(tx: Tx, from: string, to: string, o: TransferOptions): Promise<{ movedCenti: number; debtWrittenOffCenti: number; batches: number }> {
  const bFrom = await pointsBalance(tx, from);
  if (bFrom > 0) {
    const rows = (
      await tx.query<BatchRow>(
        `SELECT id, remaining_centi, branch_id, booking_id, visit_id, expires_at, accrued_at FROM app.loyalty_batches
         WHERE client_id = $1 AND status = 'active' AND remaining_centi > 0 ORDER BY expires_at NULLS LAST, accrued_at, id FOR UPDATE`,
        [from],
      )
    ).rows;
    const out = await postPoints(tx, from, { amount: -bFrom, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: o.now, refs: { ...o.refs, toClientId: to } }, o.key('out'), o.author);
    if (out.replayed) return { movedCenti: 0, debtWrittenOffCenti: 0, batches: 0 };
    await debitBatches(tx, { clientId: from, entryId: out.entryId, amount: bFrom, balanceBefore: out.balanceBefore, kind: 'merge', ref: o.ref });
    for (const b of rows) {
      const r = num(b.remaining_centi);
      const p = await postPoints(
        tx, to,
        { amount: r, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: b.branch_id, occurredAt: o.now, refs: { ...o.refs, fromBatchId: b.id, fromClientId: from } },
        o.key(`in:${b.id}`), o.author,
      );
      await createBatch(tx, {
        clientId: to, entryId: p.entryId, amount: r, balanceBefore: p.balanceBefore, source: 'manual', branchId: b.branch_id,
        bookingId: b.booking_id, visitId: b.visit_id, expiresAt: b.expires_at, accruedAt: b.accrued_at,
      });
    }
    return { movedCenti: bFrom, debtWrittenOffCenti: 0, batches: rows.length };
  }
  if (bFrom < 0) {
    const debt = -bFrom;
    const take = Math.min(debt, Math.max(0, (await pointsBalance(tx, to)) - POINTS_MIN_BALANCE));
    const settle = await postPoints(tx, from, { amount: debt, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: o.now, refs: { ...o.refs, toClientId: to } }, o.key('settle'), o.author);
    if (settle.replayed) return { movedCenti: 0, debtWrittenOffCenti: 0, batches: 0 };
    await createBatch(tx, { clientId: from, entryId: settle.entryId, amount: debt, balanceBefore: settle.balanceBefore, source: 'manual', branchId: null, expiresAt: null, accruedAt: o.now });
    if (take > 0) {
      const p = await postPoints(tx, to, { amount: -take, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: o.now, refs: { ...o.refs, fromClientId: from } }, o.key('debt'), o.author);
      await debitBatches(tx, { clientId: to, entryId: p.entryId, amount: take, balanceBefore: p.balanceBefore, kind: 'merge', ref: o.ref });
    }
    return { movedCenti: -take, debtWrittenOffCenti: debt - take, batches: 0 };
  }
  return { movedCenti: 0, debtWrittenOffCenti: 0, batches: 0 };
}

/** Действующий владелец баллов: объединённая карточка → основная (цепочкой). */
export async function ownerOf(tx: Tx, clientId: string): Promise<string> {
  return effectiveClientId(tx, clientId);
}

/** Счёт действующего владельца, затем счёт самой карточки (если она объединена). Возвращает id владельца. */
export async function openWithOwner(tx: Tx, clientId: string, now: Date): Promise<string> {
  const owner = await ownerOf(tx, clientId); // без замка: если владельца объединили, пока ждали, – CLIENT_MERGED, повтор
  if (owner !== clientId.toLowerCase()) {
    await openClientAccount(tx, owner, now);
    await openAccount(tx, clientId, now);
  } else {
    await openClientAccount(tx, clientId, now);
  }
  return owner;
}

/** После прихода на объединённую карточку – её остаток к владельцу (ключи от ключа коррекции: повтор ничего не задваивает). */
export async function sweepMerged(tx: Tx, mergedId: string, ownerId: string, opKey: string, author: Author, now: Date): Promise<number> {
  if (mergedId.toLowerCase() === ownerId) return 0;
  const r = await transferBalance(tx, mergedId, ownerId, {
    key: (s) => `merged-sweep:${opKey}:${s}`, refs: { reason: 'correction_after_merge' }, author, now, ref: { type: 'merged_correction', id: mergedId },
  });
  return r.movedCenti;
}

/** Перед расходом с объединённой карточки – мост: владелец −amount (FEFO, предел проверяет вызывающий), карточка +amount. */
export async function bridgeToMerged(tx: Tx, ownerId: string, mergedId: string, amount: number, opKey: string, author: Author, now: Date): Promise<void> {
  const refs = { reason: 'correction_after_merge', mergedClientId: mergedId };
  const out = await postPoints(tx, ownerId, { amount: -amount, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: now, refs }, `merged-bridge:${opKey}:out`, author);
  if (out.replayed) return;
  await debitBatches(tx, { clientId: ownerId, entryId: out.entryId, amount, balanceBefore: out.balanceBefore, kind: 'merge', ref: { type: 'merged_correction', id: mergedId } });
  const inn = await postPoints(tx, mergedId, { amount, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: now, refs: { ...refs, toClientId: mergedId } }, `merged-bridge:${opKey}:in`, author);
  await createBatch(tx, { clientId: mergedId, entryId: inn.entryId, amount, balanceBefore: inn.balanceBefore, source: 'manual', branchId: null, expiresAt: null, accruedAt: now });
}

/** Возврат списания (оплата баллами, товар) с учётом слияния: счёт владельца раньше счёта карточки списания, возврат – в её
 *  исходные партии (returnSpend), затем остаток объединённой карточки – к владельцу. Без слияния – обычный returnSpend. */
export async function returnSpendToOwner(tx: Tx, input: Parameters<typeof returnSpend>[1]): ReturnType<typeof returnSpend> {
  const row = (
    await tx.query<{ owner_id: string }>(
      `SELECT a.owner_id FROM journal.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id WHERE e.id = $1 AND a.kind = 'loyalty_client'`,
      [input.originalEntryId],
    )
  ).rows[0];
  if (!row) return returnSpend(tx, input); // NOT_FOUND отдаст returnSpend
  const ownerId = await openWithOwner(tx, row.owner_id, input.occurredAt);
  const r = await returnSpend(tx, input);
  await sweepMerged(tx, row.owner_id, ownerId, input.idempotencyKey, input.author, input.occurredAt);
  return r;
}
