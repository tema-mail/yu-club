// S2-20. Сеанс оплаты (K10 §1–§6, §9): recordPayment для cash/card/transfer/points/certificate/none, правило одного
// способа и исключение R-03 (флаг payment.certificate_topup_enabled), getPaymentStatus, PaymentLookup для баллов,
// событие payment.recorded.
// Порядок в транзакции (K17 «Решения 02.11», единый для Э2): чтение брони без блокировки (филиал, клиент) → ВСЕ счета
// журнала (оба места денег филиала, счёт баллов клиента, счёт сертификата) одним lockAccounts по id → бронь FOR SHARE
// (payableBooking) → сеанс FOR UPDATE → проверки по перечитанному → строки через обработчики → платёж, аудит, outbox.
// Код сертификата проверяет вызывающий ДО этой транзакции своей короткой транзакцией (K16 §3). Внешних вызовов нет.
// Денежные строки finance проводит сам через кассу (K17 postMoneyOperation, источник session); points и certificate –
// обработчики реестра methods.ts (их регистрирует server.ts).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { publish } from '../../core/outbox.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { branchDay, parseLocalDate, systemClock, type Clock } from '../../core/time.ts';
import { guardFinance, lockPlaces, postMoneyOperation, type MoneyPlace } from './cashbox.ts';
import {
  MONEY_METHODS,
  paymentMethodHandler,
  type LineMethod,
  type MoneyMethod,
  type PaymentLine,
  type PaymentMethod,
  type PaymentRecordedPayload,
  type PaymentSession,
  type PaymentSessionStatus,
} from './methods.ts';

// ---- зависимости (ADR 0002: booking и certificates finance не импортирует – их передаёт server.ts)

export interface PaymentBookings {
  /** Бронь без блокировки: филиал и клиент – чтобы взять счета до строки брони (bookingLookup.facts). */
  facts(tx: Tx, bookingId: string): Promise<{ branchId: string; clientId: string } | null>;
  /** Бронь под FOR SHARE (paymentBookingProvider.payableBooking, S2-05). */
  payableBooking(tx: Tx, bookingId: string): Promise<{
    bookingId: string; branchId: string; clientId: string; status: string; payable: boolean; version: number; priceKop: number; minutes: number; resourceType: string;
  } | null>;
}

export interface PaymentDeps {
  bookings: PaymentBookings;
  /** Строка сертификата: id, который вернул verifyCertificatePin (K16 §3) – вызывающий проверил код ДО BEGIN этой
   *  транзакции отдельным соединением (неудачи кода считает только verify; если проверять внутри, пока оплата держит
   *  строку сертификата, два соединения ждут друг друга). Без него строка сертификата не проводится. */
  verifiedCertificateId?: string;
  clock?: Clock;
}

export interface Payment {
  id: string;
  sessionId: string;
  attempt: number;
  status: 'active' | 'partially_refunded' | 'refunded';
  lines: PaymentLine[];
  totalKop: number;
  recordedBy: string;
  recordedAt: string;
  topupRuleSnapshot: boolean;
  comment: string | null;
}

// ---- чтение

interface SessionRow {
  booking_id: string;
  branch_id: string;
  client_id: string;
  amount_due_kop: string;
  booking_version: number;
  status: PaymentSessionStatus;
  row_version: number;
  active_payment_id: string | null;
}
const SESSION_SELECT = `SELECT s.booking_id, s.branch_id, s.client_id, s.amount_due_kop, s.booking_version, s.status, s.row_version,
    (SELECT p.id FROM app.payments p WHERE p.session_id = s.booking_id AND p.status IN ('active','partially_refunded')) AS active_payment_id
  FROM app.payment_sessions s`;

export function toSession(r: SessionRow): PaymentSession {
  return {
    id: r.booking_id,
    bookingId: r.booking_id,
    branchId: r.branch_id,
    clientId: r.client_id,
    amountDueKop: Number(r.amount_due_kop),
    bookingVersion: r.booking_version,
    status: r.status,
    activePaymentId: r.active_payment_id,
    rowVersion: r.row_version,
  };
}

export async function getSession(db: Db, bookingId: string): Promise<PaymentSession | null> {
  const r = await db.query<SessionRow>(`${SESSION_SELECT} WHERE s.booking_id = $1`, [bookingId]);
  return r.rows[0] ? toSession(r.rows[0]) : null;
}

/** Сеанс FOR UPDATE (после общей блокировки счетов). */
export async function lockSession(tx: Tx, bookingId: string): Promise<PaymentSession | null> {
  const r = await tx.query<SessionRow>(`${SESSION_SELECT} WHERE s.booking_id = $1 FOR UPDATE OF s`, [bookingId]);
  return r.rows[0] ? toSession(r.rows[0]) : null;
}

interface PaymentRow {
  id: string;
  session_id: string;
  attempt: number;
  status: Payment['status'];
  total_kop: string;
  topup_rule_snapshot: boolean;
  recorded_by: string;
  recorded_at: Date;
  comment: string | null;
}
interface LineRow {
  payment_id: string;
  line_no: 1 | 2;
  method: LineMethod;
  amount_kop: string;
  points_centi: string | null;
  certificate_id: string | null;
  ledger_posting_id: string;
  finance_operation_id: string | null;
}

const toLine = (l: LineRow): PaymentLine => ({
  lineNo: l.line_no,
  method: l.method,
  amountKop: Number(l.amount_kop),
  ledgerPostingId: l.ledger_posting_id,
  ...(l.points_centi !== null ? { pointsCenti: Number(l.points_centi) } : {}),
  ...(l.certificate_id !== null ? { certificateId: l.certificate_id } : {}),
  ...(l.finance_operation_id !== null ? { financeOperationId: l.finance_operation_id } : {}),
});

/** Платёж со строками; forUpdate – под блокировкой строки платежа (возврат). */
export async function getPayment(db: Db, paymentId: string, forUpdate = false): Promise<Payment | null> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return null;
  const p = await db.query<PaymentRow>(
    `SELECT id, session_id, attempt, status, total_kop, topup_rule_snapshot, recorded_by, recorded_at, comment FROM app.payments WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [paymentId],
  );
  const row = p.rows[0];
  if (!row) return null;
  const lines = await db.query<LineRow>(`SELECT * FROM app.payment_lines WHERE payment_id = $1 ORDER BY line_no`, [paymentId]);
  return {
    id: row.id,
    sessionId: row.session_id,
    attempt: row.attempt,
    status: row.status,
    lines: lines.rows.map(toLine),
    totalKop: Number(row.total_kop),
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at.toISOString(),
    topupRuleSnapshot: row.topup_rule_snapshot,
    comment: row.comment,
  };
}

/** K10 §4: статусы оплаты для календаря и карточки; брони без сеанса – unpaid. */
export async function getPaymentStatus(db: Db, bookingIds: string[]): Promise<Map<string, PaymentSessionStatus>> {
  const ids = [...new Set(bookingIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  const out = new Map<string, PaymentSessionStatus>(bookingIds.map((id) => [id, 'unpaid']));
  if (ids.length === 0) return out;
  const r = await db.query<{ booking_id: string; status: PaymentSessionStatus }>(`SELECT booking_id, status FROM app.payment_sessions WHERE booking_id = ANY($1::uuid[])`, [ids]);
  for (const row of r.rows) out.set(row.booking_id, row.status);
  return out;
}

export interface UnpaidRow {
  bookingId: string;
  number: number;
  status: string;
  clientId: string;
  resourceName: string | null;
  start: string;
  end: string;
  amountDueKop: number;
  /** unpaid – оплаты не было; refunded – после полного возврата. */
  paymentStatus: 'unpaid' | 'refunded';
}

/** Брони филиала к оплате за период (провайдер booking.payableInPeriod). */
export interface UnpaidBookings {
  payableInPeriod(db: Db, input: { branchId: string; from: Date; to: Date }): Promise<Array<{
    bookingId: string; number: number; status: string; clientId: string; resourceName: string | null; start: Date; end: Date; priceKop: number;
  }>>;
}

/** K10 §4 listUnpaid (№22): брони arrived | completed без живого платежа за сутки филиала (K8). Курсор (start, number).
 *  Права – finance.payment.view на филиал (вне зоны – 404). */
export async function listUnpaid(
  db: Db,
  ctx: AccessContext,
  input: { branchId: string; date: string; cursor?: string; limit?: number },
  deps: { bookings: UnpaidBookings },
): Promise<{ items: UnpaidRow[]; nextCursor: string | null }> {
  const branch = await guardFinance(db, ctx, input.branchId, 'finance.payment.view', { action: 'payment.recorded' });
  const day = branchDay(parseLocalDate(input.date), branch.timezone);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AppError('VALIDATION_FAILED', 400, 'limit – от 1 до 200', { field: 'limit' });
  if (input.cursor !== undefined && !/^\d{1,16}:\d{1,18}$/.test(input.cursor)) throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
  const rows = await deps.bookings.payableInPeriod(db, { branchId: branch.id, from: day.start, to: day.end });
  const sessions = await db.query<{ booking_id: string; status: PaymentSessionStatus; amount_due_kop: string }>(
    `SELECT booking_id, status, amount_due_kop FROM app.payment_sessions WHERE booking_id = ANY($1::uuid[])`,
    [rows.map((r) => r.bookingId)],
  );
  const byId = new Map(sessions.rows.map((s) => [s.booking_id, s]));
  const [cMs, cNum] = input.cursor ? input.cursor.split(':').map(Number) : [null, null];
  const unpaid = rows
    .filter((r) => {
      const s = byId.get(r.bookingId);
      return !s || s.status === 'unpaid' || s.status === 'refunded';
    })
    .filter((r) => cMs === null || r.start.getTime() > cMs || (r.start.getTime() === cMs && r.number > cNum!));
  const page = unpaid.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      bookingId: r.bookingId, number: r.number, status: r.status, clientId: r.clientId, resourceName: r.resourceName,
      start: r.start.toISOString(), end: r.end.toISOString(), amountDueKop: r.priceKop,
      paymentStatus: byId.get(r.bookingId)?.status === 'refunded' ? 'refunded' : 'unpaid',
    })),
    nextCursor: unpaid.length > limit && last ? `${last.start.getTime()}:${last.number}` : null,
  };
}

/** loyalty PaymentLookup (K15 §4): состояние оплаты из базы, не из payload события. */
export const paymentLookup = {
  async livePayment(tx: Tx, bookingId: string): Promise<{ paymentId: string; methods: PaymentMethod[] } | null> {
    const r = await tx.query<{ id: string; methods: LineMethod[] | null }>(
      `SELECT p.id, array_agg(l.method ORDER BY l.line_no) FILTER (WHERE l.method IS NOT NULL) AS methods
       FROM app.payments p LEFT JOIN app.payment_lines l ON l.payment_id = p.id
       WHERE p.session_id = $1 AND p.status IN ('active','partially_refunded') GROUP BY p.id`,
      [bookingId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { paymentId: row.id, methods: row.methods && row.methods.length > 0 ? row.methods : ['none'] };
  },
  async paymentStatus(tx: Tx, paymentId: string): Promise<'active' | 'partially_refunded' | 'refunded' | null> {
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return null;
    const r = await tx.query<{ status: Payment['status'] }>('SELECT status FROM app.payments WHERE id = $1', [paymentId]);
    return r.rows[0]?.status ?? null;
  },
};

// ---- разбор и правило способа

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

const lineSchema = z.object({
  method: z.enum(['cash', 'card', 'transfer', 'points', 'certificate', 'none']),
  amountKop: z.number().int().safe().min(0),
  certificate: z.object({ number: z.string().trim().min(1).max(64), pin: z.string().max(16) }).optional(),
});
const recordSchema = z.object({
  bookingId: z.string().regex(/^[0-9a-f-]{36}$/i),
  lines: z.array(lineSchema).min(1).max(2),
  comment: z.string().trim().max(2000).optional(),
  receiptIssued: z.boolean().optional(),
});
type LineInput = z.infer<typeof lineSchema>;

const isMoney = (m: string): m is MoneyMethod => (MONEY_METHODS as readonly string[]).includes(m);
const placeOf = (m: MoneyMethod): MoneyPlace => (m === 'cash' ? 'cash' : 'noncash');
const combined = (details: Record<string, unknown>) => new AppError('PAYMENT_METHODS_COMBINED', 422, 'Сеанс оплачивается одним способом', details);

/** Правило способа (K10 §2, TC-07): одна строка; две – только «сертификат, затем деньги» и только при флаге R-03. */
function assertMethodRule(lines: LineInput[], topup: boolean): void {
  if (lines.length === 1) return;
  const [a, b] = lines as [LineInput, LineInput];
  if (!topup || a.method !== 'certificate' || !isMoney(b.method)) throw combined({ methods: lines.map((l) => l.method), topupEnabled: topup });
}

/** Сумма к оплате и строки (K10 §7): none – только при 0, деньги при 0 – NOTHING_TO_PAY; сумма ≠ к оплате – AMOUNT_MISMATCH. */
function assertAmounts(lines: LineInput[], due: number): void {
  if (lines.some((l) => l.method === 'none')) {
    if (lines.length > 1) throw combined({ methods: lines.map((l) => l.method) });
    if (due > 0) throw new AppError('NOTHING_TO_PAY', 422, 'Способ «без оплаты» – только для сеанса за 0 ₽', { amountDueKop: due });
    if (lines[0]!.amountKop !== 0) throw new AppError('AMOUNT_MISMATCH', 422, 'Сумма не совпадает с суммой к оплате', { amountDueKop: due });
    return;
  }
  if (due === 0) throw new AppError('NOTHING_TO_PAY', 422, 'Сеанс за 0 ₽ закрывается способом «без оплаты»', { amountDueKop: due });
  const sum = lines.reduce((s, l) => s + l.amountKop, 0);
  if (sum !== due || lines.some((l) => l.amountKop <= 0)) throw new AppError('AMOUNT_MISMATCH', 422, 'Сумма не совпадает с суммой к оплате', { amountDueKop: due, totalKop: sum });
}

// ---- команда

/** K10 §4 recordPayment. Транзакцию открывает вызывающий (HTTP-слой – под Idempotency-Key). */
export async function recordPayment(
  tx: Tx,
  ctx: AccessContext,
  raw: unknown,
  meta: AuditRequestMeta,
  deps: PaymentDeps,
): Promise<{ paymentId: string; session: PaymentSession }> {
  const clock = deps.clock ?? systemClock;
  const input = parse(recordSchema, raw);
  const now = clock.now();

  // 0) бронь без блокировки → права по филиалу брони (чужая – 404 как несуществующая)
  const facts = await deps.bookings.facts(tx, input.bookingId);
  if (!facts) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const branch = await guardFinance(tx, ctx, facts.branchId, 'finance.payment.record', { action: 'payment.recorded' });
  const topup = (await resolveSetting(tx, 'payment.certificate_topup_enabled', { network: true }, now)).value;
  assertMethodRule(input.lines, topup);
  for (const l of input.lines) {
    if ((l.method === 'points' || l.method === 'certificate') && !paymentMethodHandler(l.method)) {
      throw new AppError('VALIDATION_FAILED', 400, 'Способ оплаты недоступен', { field: 'method', method: l.method });
    }
    if (l.method === 'certificate' && !l.certificate) throw new AppError('VALIDATION_FAILED', 400, 'Укажите номер и код сертификата', { field: 'certificate' });
  }

  // 1) все счета журнала одним lockAccounts по id
  const extra: string[] = [];
  if (input.lines.some((l) => l.method === 'points')) {
    const a = await tx.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_type = 'client' AND owner_id = $1`, [facts.clientId]);
    if (a.rows[0]) extra.push(a.rows[0].id);
  }
  if (input.lines.some((l) => l.method === 'certificate')) {
    if (!deps.verifiedCertificateId) throw new Error('recordPayment: код сертификата не проверен verifyCertificatePin до транзакции');
    const a = await tx.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'certificate' AND owner_type = 'certificate' AND owner_id = $1`, [deps.verifiedCertificateId]);
    if (a.rows[0]) extra.push(a.rows[0].id);
  }
  await lockPlaces(tx, branch.id, extra);

  // 2) бронь FOR SHARE и перечитать
  const b = await deps.bookings.payableBooking(tx, input.bookingId);
  if (!b) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  if (b.branchId !== facts.branchId || b.clientId !== facts.clientId) {
    throw new AppError('VERSION_CONFLICT', 409, 'Бронь изменилась, повторите', { bookingId: b.bookingId });
  }
  if (!b.payable) throw new AppError('BOOKING_NOT_PAYABLE', 409, 'Оплата – после прихода клиента', { status: b.status });

  // 3) сеанс: лениво, затем FOR UPDATE; живой платёж → ALREADY_PAID
  await tx.query(
    `INSERT INTO app.payment_sessions (booking_id, branch_id, client_id, amount_due_kop, booking_version) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (booking_id) DO NOTHING`,
    [b.bookingId, b.branchId, b.clientId, b.priceKop, b.version],
  );
  let session = (await lockSession(tx, b.bookingId))!;
  if (session.activePaymentId) throw new AppError('ALREADY_PAID', 409, 'Сеанс уже оплачен', { paymentId: session.activePaymentId });
  if (session.bookingVersion !== b.version || session.amountDueKop !== b.priceKop) {
    // живого платежа нет: к оплате – цена текущей версии брони (K10 §1, перенос)
    await tx.query(`UPDATE app.payment_sessions SET amount_due_kop = $2, booking_version = $3 WHERE booking_id = $1`, [b.bookingId, b.priceKop, b.version]);
    session = { ...session, amountDueKop: b.priceKop, bookingVersion: b.version };
  }
  const due = session.amountDueKop;
  assertAmounts(input.lines, due);

  // 4) платёж до строк: на него ссылаются строки погашения сертификата (FK 0205)
  const attempt = Number(
    (await tx.query<{ next: number }>('SELECT coalesce(max(attempt), 0) + 1 AS next FROM app.payments WHERE session_id = $1', [session.id])).rows[0]!.next,
  );
  const paymentId = randomUUID();
  try {
    await tx.query(
      `INSERT INTO app.payments (id, session_id, attempt, total_kop, topup_rule_snapshot, recorded_by, recorded_at, comment) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [paymentId, session.id, attempt, due, topup, ctx.actor.staffId, now, input.comment ?? null],
    );
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && (e.constraint === 'payments_one_live_per_session' || e.constraint === 'payments_session_id_attempt_key')) {
      throw new AppError('ALREADY_PAID', 409, 'Сеанс уже оплачен', {});
    }
    throw err;
  }

  // 5) строки
  const author = { type: 'staff' as const, id: ctx.actor.staffId };
  const lines: PaymentLine[] = [];
  const drain = input.lines.length === 2;
  let rest = due;
  for (const [i, l] of input.lines.entries()) {
    if (l.method === 'none') break;
    const lineNo = (i + 1) as 1 | 2;
    const key = `payment:${session.id}:${attempt}:${lineNo}`;
    let line: PaymentLine;
    if (isMoney(l.method)) {
      const amount = drain ? rest : l.amountKop;
      const op = await postMoneyOperation(
        tx,
        ctx,
        {
          branchId: branch.id, kind: 'income', place: placeOf(l.method), method: l.method, amountKop: amount, source: 'session',
          ref: { type: 'payment', id: paymentId }, receiptIssued: input.receiptIssued ?? null, occurredAt: now, comment: input.comment ?? null,
        },
        { idempotencyKey: key },
        meta,
        clock,
      );
      line = { lineNo, method: l.method, amountKop: amount, ledgerPostingId: op.postingId, financeOperationId: op.id };
    } else {
      const handler = paymentMethodHandler(l.method as 'points' | 'certificate')!;
      const r = await handler.charge(tx, {
        session, lineNo, amountKop: drain ? due : l.amountKop, minutes: b.minutes, resourceType: b.resourceType,
        ...(l.certificate ? { certificate: l.certificate } : {}),
        idempotencyKey: key, author, occurredAt: now, mode: drain ? 'drain' : 'exact', paymentId, meta,
        ...(input.receiptIssued !== undefined ? { receiptIssued: input.receiptIssued } : {}),
      });
      if (l.method === 'certificate' && r.certificateId !== deps.verifiedCertificateId) {
        throw new AppError('CERTIFICATE_NOT_FOUND', 404, 'Сертификат не найден или код неверен');
      }
      if (drain && !(r.amountKop > 0 && r.amountKop < due && r.amountKop === l.amountKop)) {
        // остаток сертификата изменился между экраном и проводкой (K10 §5 drain) – откат всей транзакции
        throw new AppError('AMOUNT_MISMATCH', 422, 'Остаток сертификата изменился: проверьте суммы', { amountDueKop: due, certificateKop: r.amountKop });
      }
      line = {
        lineNo, method: l.method as 'points' | 'certificate', amountKop: r.amountKop, ledgerPostingId: r.postingId,
        ...(r.pointsCenti !== undefined ? { pointsCenti: r.pointsCenti } : {}),
        ...(r.certificateId !== undefined ? { certificateId: r.certificateId } : {}),
      };
    }
    rest -= line.amountKop;
    lines.push(line);
    await tx.query(
      `INSERT INTO app.payment_lines (payment_id, line_no, method, amount_kop, points_centi, certificate_id, ledger_posting_id, finance_operation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [paymentId, lineNo, line.method, line.amountKop, line.pointsCenti ?? null, line.certificateId ?? null, line.ledgerPostingId, line.financeOperationId ?? null],
    );
  }
  if (lines.reduce((s, l) => s + l.amountKop, 0) !== (input.lines[0]!.method === 'none' ? 0 : due)) {
    throw new AppError('AMOUNT_MISMATCH', 422, 'Сумма строк не совпадает с суммой к оплате', { amountDueKop: due });
  }

  // 6) сеанс, аудит, событие
  await tx.query(`UPDATE app.payment_sessions SET status = 'paid', row_version = row_version + 1 WHERE booking_id = $1`, [session.id]);
  session = (await lockSession(tx, session.id))!;
  const methods: PaymentMethod[] = lines.length > 0 ? lines.map((l) => l.method) : ['none'];
  const pointsCenti = lines.find((l) => l.pointsCenti !== undefined)?.pointsCenti ?? null;
  const certificateId = lines.find((l) => l.certificateId !== undefined)?.certificateId ?? null;
  await writeAudit(
    tx,
    meta,
    {
      action: 'payment.recorded',
      object: { type: 'payment', id: paymentId },
      branchId: branch.id,
      cityId: branch.cityId,
      after: { bookingId: session.bookingId, attempt, methods, totalKop: due, lines: lines.map((l) => ({ lineNo: l.lineNo, method: l.method, amountKop: l.amountKop })) },
    },
    clock,
  );
  const payload: PaymentRecordedPayload = {
    paymentId, sessionId: session.id, bookingId: session.bookingId, branchId: branch.id, clientId: session.clientId, attempt, methods, totalKop: due, pointsCenti, certificateId,
  };
  await publish(tx, { type: 'payment.recorded', aggregateType: 'payment', aggregateId: paymentId, aggregateVersion: paymentId, branchId: branch.id, payload, occurredAt: now });
  return { paymentId, session };
}
