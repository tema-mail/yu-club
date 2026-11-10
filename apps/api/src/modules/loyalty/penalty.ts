// K15 §5 (TC-10, TC-11): штраф за неявку. Обработчики outbox no_show.marked / no_show.reverted.
// Номинал −5 (07 §8.1), обрезка у предела под блокировкой счёта: applied = min(0, max(−500, −5000 − balance)) –
// при балансе −50 и ниже (ниже – только корректировкой Владельца) штраф 0: запись K3 не пишется, строка штрафа есть.
// Только неявки после loyalty.penalties_from (null – штрафы выключены до даты запуска Э2, строка 'skipped').
// penalty_scope 'visit' (Q-44): брони подряд в одном филиале – один штраф, остальные неявки цепочки – 'merged'.
// Порядок событий не гарантирован (K4): решение – по состоянию брони из базы под блокировкой счёта (счёт – до строки
// брони, K17 «Решения 02.11»):
// штраф стоит, пока бронь в статусе no_show; исправление – когда бронь из no_show вышла.
// Отмена клубом неявки не создаёт – штрафа нет (TC-11).
import type { Tx } from '../../core/ledger.ts';
import { listSubscriptions, subscribe, type EventEnvelope } from '../../core/outbox.ts';
import { resolveSettings } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { debitBatches, openAccount, openClientAccount, POINTS_MIN_BALANCE, postPoints, reverseWithBatches, SYSTEM_AUTHOR } from './account.ts';
import type { LoyaltyBookings } from './accrual.ts';
import { entryClientId, sweepMerged } from './merged.ts';

/** Номинал штрафа −5 баллов (07 §8.1) – константа подтверждённого правила. */
export const PENALTY_CENTI = 500;

export interface PenaltyBookings extends Pick<LoyaltyBookings, 'payableBooking' | 'bookingClient'> {
  /** Брони того же клиента подряд в том же филиале, включая саму (booking/providers.ts adjacentChain). */
  adjacentChain(tx: Tx, bookingId: string): Promise<string[]>;
}

export interface PenaltyDeps {
  bookings: PenaltyBookings;
  clock: Clock;
}

/** Обрезка штрафа у предела (K15 §5): никогда не положительна. */
export function clipPenalty(balance: number): number {
  return Math.min(0, Math.max(-PENALTY_CENTI, POINTS_MIN_BALANCE - balance));
}

type Outcome = 'active' | 'merged' | 'skipped' | 'none';

/** no_show.marked: штраф, если бронь всё ещё в no_show и на ней (и на её цепочке) ещё нет штрафа. */
export async function applyPenalty(tx: Tx, input: { noShowId: string; bookingId: string; markedAt: Date }, deps: PenaltyDeps): Promise<Outcome> {
  const now = deps.clock.now();
  const clientId = await deps.bookings.bookingClient(tx, input.bookingId);
  if (!clientId) return 'none';
  const acc = await openClientAccount(tx, clientId, now); // счёт до брони (K17 02.11) → перечитать бронь → проверить; merged – повтор (D5-09)
  const b = await deps.bookings.payableBooking(tx, input.bookingId);
  if (!b || b.clientId !== acc.clientId) return 'none';
  if (b.status !== 'no_show') return 'none'; // неявку уже исправили – её событие устарело
  const seen = await tx.query(
    `SELECT 1 FROM app.loyalty_penalties WHERE no_show_id = $1 OR (booking_id = $2 AND status IN ('active','merged'))`,
    [input.noShowId, input.bookingId],
  );
  if (seen.rowCount) return 'none';
  const insert = (status: Outcome, applied: number, entryId: number | null, group: string | null) =>
    tx.query(
      `INSERT INTO app.loyalty_penalties (client_id, booking_id, no_show_id, branch_id, applied_centi, ledger_entry_id, group_booking_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [b.clientId, input.bookingId, input.noShowId, b.branchId, applied, entryId, group, status],
    );

  const s = await resolveSettings(tx, ['loyalty.penalties_from', 'loyalty.penalty_scope'], { branchId: b.branchId }, now);
  const from = s['loyalty.penalties_from'].value;
  if (from === null || input.markedAt.getTime() < Date.parse(from)) {
    await insert('skipped', 0, null, null); // план 4.3 п.10: только новые неявки после запуска Э2
    return 'skipped';
  }
  if (s['loyalty.penalty_scope'].value === 'visit') {
    const chain = (await deps.bookings.adjacentChain(tx, input.bookingId)).filter((id) => id !== input.bookingId);
    if (chain.length > 0) {
      const head = (await tx.query<{ booking_id: string }>(`SELECT booking_id FROM app.loyalty_penalties WHERE booking_id = ANY($1::uuid[]) AND status = 'active' LIMIT 1`, [chain])).rows[0];
      if (head) {
        await insert('merged', 0, null, head.booking_id); // один штраф на визит (07 §8.4, Q-44)
        return 'merged';
      }
    }
  }
  const applied = clipPenalty(acc.balance);
  if (applied === 0) {
    await insert('active', 0, null, null); // −50 и ниже: событие неявки фиксируется, баланс не меняется (07 §9.1)
    return 'active';
  }
  const p = await postPoints(
    tx,
    b.clientId,
    { amount: applied, type: 'loyalty.penalty', branchId: b.branchId, occurredAt: now, ref: { type: 'no_show', id: input.noShowId }, refs: { bookingId: input.bookingId } },
    `loyalty-penalty:${input.noShowId}`,
    SYSTEM_AUTHOR,
  );
  if (p.replayed) return 'none';
  await debitBatches(tx, { clientId: b.clientId, entryId: p.entryId, amount: -applied, balanceBefore: p.balanceBefore, kind: 'penalty', ref: { type: 'no_show', id: input.noShowId } });
  await insert('active', applied, p.entryId, null);
  return 'active';
}

interface PenaltyRow {
  id: string;
  booking_id: string;
  client_id: string;
  applied_centi: string;
  ledger_entry_id: string | null;
  status: 'active' | 'merged';
}

/** no_show.reverted: если бронь вышла из no_show – снять её штраф; штраф группы переходит на живую неявку цепочки. */
export async function revertPenalty(tx: Tx, input: { bookingId: string }, deps: PenaltyDeps): Promise<'reversed' | 'moved' | 'none'> {
  const now = deps.clock.now();
  const clientId = await deps.bookings.bookingClient(tx, input.bookingId);
  if (!clientId) return 'none';
  const acc = await openClientAccount(tx, clientId, now); // клиент брони прочитан без замка: слияние за это время – CLIENT_MERGED, повтор
  const b = await deps.bookings.payableBooking(tx, input.bookingId);
  if (!b || b.clientId !== acc.clientId) return 'none';
  if (b.status === 'no_show') return 'none'; // неявку отметили заново – штраф стоит
  const rows = (
    await tx.query<PenaltyRow>(
      `SELECT id, booking_id, client_id, applied_centi, ledger_entry_id, status FROM app.loyalty_penalties
       WHERE booking_id = $1 AND status IN ('active','merged') FOR UPDATE`,
      [input.bookingId],
    )
  ).rows;
  let result: 'reversed' | 'moved' | 'none' = 'none';
  for (const row of rows) {
    if (row.status === 'merged') {
      await tx.query(`UPDATE app.loyalty_penalties SET status = 'reversed' WHERE id = $1`, [row.id]);
      result = 'reversed';
      continue;
    }
    // штраф группы: есть ли ещё живая неявка, слитая с этой (брони цепочки в no_show)?
    const heirs = (
      await tx.query<{ id: string; booking_id: string }>(
        `SELECT id, booking_id FROM app.loyalty_penalties WHERE group_booking_id = $1 AND status = 'merged' ORDER BY created_at, id FOR UPDATE`,
        [row.booking_id],
      )
    ).rows;
    let heir: { id: string; booking_id: string } | undefined;
    for (const h of heirs) {
      if ((await deps.bookings.payableBooking(tx, h.booking_id))?.status === 'no_show') {
        heir = h;
        break;
      }
    }
    if (heir) {
      await tx.query(`UPDATE app.loyalty_penalties SET status = 'reversed' WHERE id = $1`, [row.id]);
      await tx.query(`UPDATE app.loyalty_penalties SET status = 'active', applied_centi = $2, ledger_entry_id = $3, group_booking_id = NULL WHERE id = $1`, [heir.id, row.applied_centi, row.ledger_entry_id]);
      await tx.query(`UPDATE app.loyalty_penalties SET group_booking_id = $2 WHERE group_booking_id = $1 AND status = 'merged'`, [row.booking_id, heir.booking_id]);
      result = 'moved';
      continue;
    }
    let reversalEntryId: number | null = null;
    if (row.ledger_entry_id !== null) {
      const key = `loyalty-penalty-reversal:${row.id}`;
      // штраф до слияния карточек – на объединённой (merged): её счёт после основной, сторно там, остаток – к основной (D5-09).
      // Карточка – владелец счёта записи K3, а не строки штрафа: штраф группы мог перейти на неявку другой карточки (heir).
      const entryOwner = (await entryClientId(tx, Number(row.ledger_entry_id))) ?? row.client_id;
      const merged = entryOwner !== acc.clientId;
      if (merged) await openAccount(tx, entryOwner, now);
      const r = await reverseWithBatches(tx, {
        clientId: entryOwner, entryId: Number(row.ledger_entry_id), reason: 'неявка исправлена', idempotencyKey: key, author: SYSTEM_AUTHOR, occurredAt: now,
      });
      if (merged) await sweepMerged(tx, entryOwner, acc.clientId, key, SYSTEM_AUTHOR, now);
      reversalEntryId = r.entryId;
    }
    await tx.query(`UPDATE app.loyalty_penalties SET status = 'reversed', reversal_entry_id = $2 WHERE id = $1`, [row.id, reversalEntryId]);
    result = 'reversed';
  }
  return result;
}

export const PENALTY_HANDLERS = {
  marked: 'loyalty.penalty.onNoShowMarked',
  reverted: 'loyalty.penalty.onNoShowReverted',
} as const;

/** Регистрация подписок (worker.ts, до startOutboxWorker). Повторный вызов ничего не делает. */
export function registerPenaltyHandlers(input: { bookings: PenaltyBookings; clock?: Clock }): void {
  if (listSubscriptions().some((x) => x.name === PENALTY_HANDLERS.marked)) return;
  const deps: PenaltyDeps = { bookings: input.bookings, clock: input.clock ?? systemClock };
  subscribe('no_show.marked', PENALTY_HANDLERS.marked, async (tx, e: EventEnvelope<'no_show.marked'>) => {
    await applyPenalty(tx, { noShowId: e.payload.noShowId, bookingId: e.payload.bookingId, markedAt: new Date(e.occurredAt) }, deps);
  });
  subscribe('no_show.reverted', PENALTY_HANDLERS.reverted, async (tx, e: EventEnvelope<'no_show.reverted'>) => {
    await revertPenalty(tx, { bookingId: e.payload.bookingId }, deps);
  });
}
