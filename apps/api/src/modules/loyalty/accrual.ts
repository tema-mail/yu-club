// K15 §4 (TC-09): начисление за посещение и его сторно. Обработчики outbox: payment.recorded, visit.confirmed –
// начислить, visit.reverted, payment.refunded (полный возврат) – сторнировать.
// Условие начисления (решение K15 §4, K10 §1): у брони есть активное посещение И живой платёж, способ которого не points.
// Порядок событий outbox не гарантирован (K4): каждый обработчик берёт блокировку счёта клиента и перечитывает из базы
// посещение, живой платёж и его способ – payload только указывает, какую бронь проверить.
// Одно начисление на бронь: частичный UNIQUE loyalty_accruals_one_active + ключ K3 loyalty-accrual:<visitId>:<paymentId>.
// Модули booking и finance loyalty не импортирует (ADR 0002): их провайдеры передаёт процесс (worker.ts).
import { writeAudit, type AuditRequestMeta } from '../../core/audit.ts';
import { pointsForMinutes, type Tx } from '../../core/ledger.ts';
import { listSubscriptions, subscribe, type EventEnvelope } from '../../core/outbox.ts';
import { resolveSettings } from '../../core/settings.ts';
import { addDays, branchDay, instantToLocal, systemClock, type Clock, type TimeZone } from '../../core/time.ts';
import type { PaymentMethod } from '../finance/methods.ts';
import { createBatch, openAccount, POINTS_MIN_BALANCE, postPoints, reverseWithBatches, SYSTEM_AUTHOR } from './account.ts';

/** Чтение брони и посещения (реализация – booking/providers.ts paymentBookingProvider, S2-05). */
export interface LoyaltyBookings {
  /** Клиент брони без блокировки – чтобы открыть счёт до строки брони (K17 «Решения 02.11»). */
  bookingClient(tx: Tx, bookingId: string): Promise<string | null>;
  payableBooking(tx: Tx, bookingId: string): Promise<{
    bookingId: string; branchId: string; branchTimezone: string; clientId: string; status: string; minutes: number; resourceType: string;
  } | null>;
  activeVisit(tx: Tx, bookingId: string): Promise<{ visitId: string } | null>;
}

/** Чтение оплаты сеанса (реализация – finance, K10 §4; подключается после S2-20). Состояние – из базы, не из payload. */
export interface PaymentLookup {
  /** Живой платёж брони (active | partially_refunded) и способы его строк; нет – null. */
  livePayment(tx: Tx, bookingId: string): Promise<{ paymentId: string; methods: PaymentMethod[] } | null>;
  /** Статус платежа по id; нет – null. */
  paymentStatus(tx: Tx, paymentId: string): Promise<'active' | 'partially_refunded' | 'refunded' | null>;
}

export interface AccrualDeps {
  bookings: LoyaltyBookings;
  payments: PaymentLookup;
  clock: Clock;
}

export const SYSTEM_META: AuditRequestMeta = { actor: { kind: 'system', process: 'loyalty' }, source: 'system', requestId: 'loyalty' };

/** Срок новой партии (K15 §2): accruedAt + N дней, конец суток по зоне филиала; null – бессрочно (Q-43). */
export function batchExpiry(accruedAt: Date, ttlDays: number | null, tz: TimeZone): Date | null {
  if (ttlDays === null) return null;
  return branchDay(addDays(instantToLocal(accruedAt, tz).date, ttlDays), tz).end;
}

/** Начислить за бронь, если выполнены все условия K15 §4. Идемпотентно: второе начисление невозможно. */
export async function tryAccrue(tx: Tx, bookingId: string, deps: AccrualDeps): Promise<{ accrualId: string; amountCenti: number } | null> {
  const now = deps.clock.now();
  const clientId = await deps.bookings.bookingClient(tx, bookingId);
  if (!clientId) return null;
  await openAccount(tx, clientId, now); // счёт до брони (K17 02.11) → перечитать бронь под FOR SHARE → проверить
  const b = await deps.bookings.payableBooking(tx, bookingId);
  if (!b || b.clientId !== clientId.toLowerCase()) return null;
  const visit = await deps.bookings.activeVisit(tx, bookingId);
  const payment = await deps.payments.livePayment(tx, bookingId);
  if (!visit || !payment) return null;
  const s = await resolveSettings(tx, ['loyalty.accrue_for_points', 'loyalty.accrue_for_certificate', 'loyalty.batch_ttl_days'], { branchId: b.branchId }, now);
  if (payment.methods.includes('points') && !s['loyalty.accrue_for_points'].value) return null; // Q-40
  if (payment.methods.includes('certificate') && !s['loyalty.accrue_for_certificate'].value) return null;
  const existing = await tx.query('SELECT 1 FROM app.loyalty_accruals WHERE booking_id = $1 AND status = $2', [bookingId, 'active']);
  if (existing.rowCount) return null;
  const amount = pointsForMinutes(b.minutes);
  if (amount === 0) return null;
  const key = `loyalty-accrual:${visit.visitId}:${payment.paymentId}`;
  const p = await postPoints(
    tx,
    b.clientId,
    { amount, type: 'loyalty.accrual', branchId: b.branchId, occurredAt: now, ref: { type: 'visit', id: visit.visitId }, refs: { bookingId, paymentId: payment.paymentId } },
    key,
    SYSTEM_AUTHOR,
  );
  if (p.replayed) return null; // эта пара посещение/платёж уже начислялась и сторнирована – повторно не начисляем
  await createBatch(tx, {
    clientId: b.clientId, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, source: 'visit', branchId: b.branchId,
    bookingId, visitId: visit.visitId, expiresAt: batchExpiry(now, s['loyalty.batch_ttl_days'].value, b.branchTimezone as TimeZone), accruedAt: now,
  });
  const r = await tx.query<{ id: string }>(
    `INSERT INTO app.loyalty_accruals (client_id, booking_id, visit_id, payment_id, ledger_entry_id, amount_centi, planned_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [b.clientId, bookingId, visit.visitId, payment.paymentId, p.entryId, amount, b.minutes],
  );
  return { accrualId: r.rows[0]!.id, amountCenti: amount };
}

interface AccrualRow {
  id: string;
  client_id: string;
  ledger_entry_id: string;
  amount_centi: string;
}

/**
 * Сторно начисления (K15 §4): K3 reverse, партия уменьшается (своя первой, затем FEFO), долг – если потрачено.
 * Если баланс ушёл бы ниже −50 – предел не обходится: loyalty_issues «требует решения», начисление остаётся (решение 16 §19).
 */
export async function reverseAccrual(
  tx: Tx,
  where: { visitId: string } | { paymentId: string },
  reason: 'visit_reverted' | 'payment_refunded',
  issueRef: { type: 'visit' | 'payment_refund'; id: string },
  clock: Clock,
): Promise<'reversed' | 'issue' | 'none'> {
  const now = clock.now();
  const [col, val] = 'visitId' in where ? ['visit_id', where.visitId] : ['payment_id', where.paymentId];
  const pre = (await tx.query<AccrualRow>(`SELECT id, client_id FROM app.loyalty_accruals WHERE ${col} = $1 AND status = 'active'`, [val])).rows[0];
  if (!pre) return 'none';
  const acc = await openAccount(tx, pre.client_id, now);
  const a = (await tx.query<AccrualRow>(`SELECT id, client_id, ledger_entry_id, amount_centi FROM app.loyalty_accruals WHERE id = $1 AND status = 'active' FOR UPDATE`, [pre.id])).rows[0];
  if (!a) return 'none';
  const amount = Number(a.amount_centi);
  if (acc.balance - amount < POINTS_MIN_BALANCE) {
    const ins = await tx.query(
      `INSERT INTO app.loyalty_issues (client_id, kind, ref_type, ref_id, amount_centi) VALUES ($1, 'accrual_reversal_below_limit', $2, $3, $4)
       ON CONFLICT (kind, ref_type, ref_id) DO NOTHING RETURNING id`,
      [a.client_id, issueRef.type, issueRef.id, amount],
    );
    if (ins.rowCount) {
      await writeAudit(tx, SYSTEM_META, { action: 'loyalty.issue.created', object: { type: 'client', id: a.client_id }, after: { kind: 'accrual_reversal_below_limit', ref: issueRef, amountCenti: amount, balanceCenti: acc.balance } }, clock);
    }
    return 'issue';
  }
  const r = await reverseWithBatches(tx, {
    clientId: a.client_id, entryId: Number(a.ledger_entry_id), reason: reason === 'visit_reverted' ? 'исправление посещения' : 'полный возврат платежа',
    idempotencyKey: `loyalty-accrual-reversal:${a.id}`, author: SYSTEM_AUTHOR, occurredAt: now,
  });
  await tx.query(`UPDATE app.loyalty_accruals SET status = 'reversed', reversal_entry_id = $2, reversal_reason = $3 WHERE id = $1`, [a.id, r.entryId, reason]);
  return 'reversed';
}

// ---- обработчики outbox

export const ACCRUAL_HANDLERS = {
  paymentRecorded: 'loyalty.accrual.onPaymentRecorded',
  visitConfirmed: 'loyalty.accrual.onVisitConfirmed',
  visitReverted: 'loyalty.accrual.onVisitReverted',
  paymentRefunded: 'loyalty.accrual.onPaymentRefunded',
} as const;

export async function onVisitReverted(tx: Tx, e: EventEnvelope<'visit.reverted'>, deps: AccrualDeps): Promise<void> {
  const { visitId, bookingId } = e.payload;
  if ((await deps.bookings.activeVisit(tx, bookingId))?.visitId === visitId) return; // посещение живо – событие устарело
  await reverseAccrual(tx, { visitId }, 'visit_reverted', { type: 'visit', id: visitId }, deps.clock);
}

export async function onPaymentRefunded(tx: Tx, e: EventEnvelope<'payment.refunded'>, deps: AccrualDeps): Promise<void> {
  const { paymentId, refundId } = e.payload;
  // полный возврат (Q-102) – по статусу платежа в базе, не по sessionStatus из payload
  if ((await deps.payments.paymentStatus(tx, paymentId)) !== 'refunded') return;
  await reverseAccrual(tx, { paymentId }, 'payment_refunded', { type: 'payment_refund', id: refundId }, deps.clock);
}

/** Регистрация подписок (worker.ts, до startOutboxWorker). Повторный вызов ничего не делает. */
export function registerAccrualHandlers(input: { bookings: LoyaltyBookings; payments: PaymentLookup; clock?: Clock }): void {
  const deps: AccrualDeps = { bookings: input.bookings, payments: input.payments, clock: input.clock ?? systemClock };
  if (listSubscriptions().some((x) => x.name === ACCRUAL_HANDLERS.paymentRecorded)) return;
  subscribe('payment.recorded', ACCRUAL_HANDLERS.paymentRecorded, async (tx, e) => void (await tryAccrue(tx, e.payload.bookingId, deps)));
  subscribe('visit.confirmed', ACCRUAL_HANDLERS.visitConfirmed, async (tx, e) => void (await tryAccrue(tx, e.payload.bookingId, deps)));
  subscribe('visit.reverted', ACCRUAL_HANDLERS.visitReverted, (tx, e) => onVisitReverted(tx, e, deps));
  subscribe('payment.refunded', ACCRUAL_HANDLERS.paymentRefunded, (tx, e) => onPaymentRefunded(tx, e, deps));
}

