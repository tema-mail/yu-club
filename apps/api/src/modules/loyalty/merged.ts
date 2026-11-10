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
import { accountRef, createBatch, creditBatches, debitBatches, openAccount, openClientAccount, POINTS_MIN_BALANCE, postPoints, returnSpend, type Author } from './account.ts';

export const MERGE_BASIS = 'Слияние карточек клиента';
const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

interface BatchRow {
  id: string;
  accrual_entry_id: string;
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
        `SELECT id, accrual_entry_id, remaining_centi, branch_id, booking_id, visit_id, expires_at, accrued_at FROM app.loyalty_batches
         WHERE client_id = $1 AND status = 'active' AND remaining_centi > 0 ORDER BY expires_at NULLS LAST, accrued_at, id FOR UPDATE`,
        [from],
      )
    ).rows;
    const out = await postPoints(tx, from, { amount: -bFrom, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: o.now, refs: { ...o.refs, toClientId: to } }, o.key('out'), o.author);
    if (out.replayed) return { movedCenti: 0, debtWrittenOffCenti: 0, batches: 0 };
    await debitBatches(tx, { clientId: from, entryId: out.entryId, amount: bFrom, balanceBefore: out.balanceBefore, kind: 'merge', ref: o.ref });
    const carriers = new Set<string>(); // основные прошлых слияний, куда вернулся долг, – их остаток затем к to
    for (const b of rows) {
      const r = num(b.remaining_centi);
      const settled = await settledDebtOf(tx, b.accrual_entry_id);
      if (settled) {
        // часть долга второй, которую при слиянии взяла основная, вернулась (снят штраф): в те же партии основной с их сроком
        await restoreMergeDebt(tx, settled, r, from, b.id, o);
        if (settled.primaryId !== to) carriers.add(settled.primaryId);
        continue;
      }
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
    for (const c of carriers) {
      await openAccount(tx, c, o.now);
      await transferBalance(tx, c, to, { ...o, key: (part) => o.key(`carrier:${c}:${part}`) });
    }
    return { movedCenti: bFrom, debtWrittenOffCenti: 0, batches: rows.length };
  }
  if (bFrom < 0) {
    const debt = -bFrom;
    const take = Math.min(debt, Math.max(0, (await pointsBalance(tx, to)) - POINTS_MIN_BALANCE));
    const off = debt - take;
    // Долг второй закрывается двумя партиями (D5-02, ревизия): взятая основной часть – бессрочная «settle», списанная –
    // «settle-off» со сроком «сейчас». Снятый позже штраф восстанавливает сначала списанную (новее): она сразу истекает
    // снова – баллов из списанного долга нет; взятая возвращается в партии основной, из которых её покрыли (restoreMergeDebt).
    if (take > 0) {
      const s1 = await postPoints(tx, from, { amount: take, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: o.now, refs: { ...o.refs, toClientId: to } }, o.key('settle'), o.author);
      if (s1.replayed) return { movedCenti: 0, debtWrittenOffCenti: 0, batches: 0 };
      await createBatch(tx, { clientId: from, entryId: s1.entryId, amount: take, balanceBefore: s1.balanceBefore, source: 'manual', branchId: null, expiresAt: null, accruedAt: o.now });
    }
    if (off > 0) {
      const s2 = await postPoints(tx, from, { amount: off, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: o.now, refs: { ...o.refs, toClientId: to, writtenOff: 'true' } }, o.key('settle-off'), o.author);
      if (s2.replayed) return { movedCenti: 0, debtWrittenOffCenti: 0, batches: 0 };
      await createBatch(tx, { clientId: from, entryId: s2.entryId, amount: off, balanceBefore: s2.balanceBefore, source: 'manual', branchId: null, expiresAt: o.now, accruedAt: o.now });
    }
    if (take > 0) {
      const p = await postPoints(tx, to, { amount: -take, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: o.now, refs: { ...o.refs, fromClientId: from } }, o.key('debt'), o.author);
      await debitBatches(tx, { clientId: to, entryId: p.entryId, amount: take, balanceBefore: p.balanceBefore, kind: 'merge', ref: o.ref });
    }
    return { movedCenti: take > 0 ? -take : 0, debtWrittenOffCenti: off, batches: 0 };
  }
  return { movedCenti: 0, debtWrittenOffCenti: 0, batches: 0 };
}

/** Партия второй – «settle» слияния (взятая основной часть её долга)? Тогда: id слияния, основная и запись её долга. */
async function settledDebtOf(tx: Tx, accrualEntryId: string): Promise<{ mergeId: string; primaryId: string; debtEntryId: number } | null> {
  const e = (
    await tx.query<{ idempotency_key: string; merge_id: string | null }>(
      `SELECT idempotency_key, refs ->> 'mergeId' AS merge_id FROM journal.ledger_entries WHERE id = $1`,
      [accrualEntryId],
    )
  ).rows[0];
  if (!e?.merge_id || !/^client-merge:[0-9a-f-]+:settle#0$/.test(e.idempotency_key)) return null;
  const d = (
    await tx.query<{ id: string; owner_id: string }>(
      `SELECT e.id, a.owner_id FROM journal.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id WHERE e.idempotency_key = $1`,
      [`client-merge:${e.merge_id}:debt#0`],
    )
  ).rows[0];
  return d ? { mergeId: e.merge_id, primaryId: d.owner_id, debtEntryId: Number(d.id) } : null;
}

/** Вернуть r в партии основной, из которых при слиянии покрыт долг второй (их срок), сверх – в её долг (creditBatches). */
async function restoreMergeDebt(tx: Tx, s: { mergeId: string; primaryId: string; debtEntryId: number }, r: number, from: string, batchId: string, o: TransferOptions): Promise<void> {
  const ref = { type: 'merge_debt_return', id: s.mergeId };
  const moved = (
    await tx.query<{ batch_id: string; moved: string; returned: string }>(
      `SELECT m.batch_id, -sum(m.delta_centi) AS moved,
              coalesce((SELECT sum(x.delta_centi) FROM journal.loyalty_batch_moves x
                        WHERE x.batch_id = m.batch_id AND x.kind = 'return' AND x.ref_type = $2 AND x.ref_id = $3::uuid), 0) AS returned
       FROM journal.loyalty_batch_moves m WHERE m.ledger_entry_id = $1 AND m.kind = 'merge' GROUP BY m.batch_id ORDER BY m.batch_id`,
      [s.debtEntryId, ref.type, ref.id],
    )
  ).rows;
  let left = r;
  const targets: Array<{ batchId: string; centi: number }> = [];
  for (const m of moved) {
    const c = Math.min(left, num(m.moved) - num(m.returned));
    if (c > 0) targets.push({ batchId: m.batch_id, centi: c });
    left -= Math.max(0, c);
  }
  const p = await postPoints(
    tx, s.primaryId,
    { amount: r, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: o.now, refs: { ...o.refs, fromBatchId: batchId, fromClientId: from, mergeDebtOf: s.mergeId } },
    o.key(`in:${batchId}`), o.author,
  );
  if (p.replayed) return;
  await creditBatches(tx, { clientId: s.primaryId, entryId: p.entryId, amount: r, balanceBefore: p.balanceBefore, targets, ref, now: o.now, reexpireKey: o.key(`reexpire:${batchId}`), author: o.author });
}

/** Партия у владельца, в которую при слиянии (или переносе после коррекции) переехала партия batchId – цепочкой. */
export async function batchCarriedTo(tx: Tx, batchId: string, ownerId: string): Promise<string | null> {
  let frontier = [batchId];
  for (let depth = 0; depth < 32 && frontier.length > 0; depth++) {
    const r = (
      await tx.query<{ id: string; client_id: string; remaining_centi: string }>(
        `SELECT b.id, b.client_id, b.remaining_centi FROM app.loyalty_batches b JOIN journal.ledger_entries e ON e.id = b.accrual_entry_id
         WHERE e.refs ? 'fromBatchId' AND e.refs ->> 'fromBatchId' = ANY($1::text[]) ORDER BY b.remaining_centi DESC, b.id`,
        [frontier],
      )
    ).rows;
    const own = r.find((x) => x.client_id === ownerId && num(x.remaining_centi) > 0);
    if (own) return own.id;
    frontier = r.map((x) => x.id);
  }
  return null;
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

/** Перед расходом с объединённой карточки – мост: владелец −amount (сначала preferBatchId – куда переехала исходная партия,
 *  затем FEFO; предел проверяет вызывающий), карточка +amount. Срок не удлиняется: списывается перенесённая партия, а не чужая. */
export async function bridgeToMerged(tx: Tx, ownerId: string, mergedId: string, amount: number, opKey: string, author: Author, now: Date, preferBatchId?: string | null): Promise<void> {
  const refs = { reason: 'correction_after_merge', mergedClientId: mergedId };
  const out = await postPoints(tx, ownerId, { amount: -amount, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: now, refs }, `merged-bridge:${opKey}:out`, author);
  if (out.replayed) return;
  await debitBatches(tx, { clientId: ownerId, entryId: out.entryId, amount, balanceBefore: out.balanceBefore, kind: 'merge', ref: { type: 'merged_correction', id: mergedId }, ...(preferBatchId ? { preferBatchId } : {}) });
  const inn = await postPoints(tx, mergedId, { amount, type: 'loyalty.manual', basis: MERGE_BASIS, branchId: null, occurredAt: now, refs: { ...refs, toClientId: mergedId } }, `merged-bridge:${opKey}:in`, author);
  await createBatch(tx, { clientId: mergedId, entryId: inn.entryId, amount, balanceBefore: inn.balanceBefore, source: 'manual', branchId: null, expiresAt: null, accruedAt: now });
}

/** Клиент, на чьём счёте баллов лежит запись K3 (карточка операции; после слияния – возможно, объединённая). */
export async function entryClientId(tx: Tx, entryId: number): Promise<string | null> {
  const r = await tx.query<{ owner_id: string }>(
    `SELECT a.owner_id FROM journal.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id WHERE e.id = $1 AND a.kind = 'loyalty_client'`,
    [entryId],
  );
  return r.rows[0]?.owner_id ?? null;
}

/** Возврат списания (оплата баллами, товар) с учётом слияния: счёт владельца раньше счёта карточки списания, возврат – в её
 *  исходные партии (returnSpend), затем остаток объединённой карточки – к владельцу. Без слияния – обычный returnSpend. */
export async function returnSpendToOwner(tx: Tx, input: Parameters<typeof returnSpend>[1]): ReturnType<typeof returnSpend> {
  const entryOwner = await entryClientId(tx, input.originalEntryId);
  if (!entryOwner) return returnSpend(tx, input); // NOT_FOUND отдаст returnSpend
  const ownerId = await openWithOwner(tx, entryOwner, input.occurredAt);
  const r = await returnSpend(tx, input);
  await sweepMerged(tx, entryOwner, ownerId, input.idempotencyKey, input.author, input.occurredAt);
  return r;
}
