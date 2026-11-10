// K10 §3, §5–6: типы оплаты, реестр обработчиков способов и события payment.recorded / payment.refunded.
// finance вызывает обработчик по method; loyalty (points) и certificates (certificate) регистрируют свои в server.ts
// (ADR 0002, как providers.ts) – модули друг друга не импортируют. Денежные способы (cash, card, transfer) регистрирует
// сам finance (K17, шаг S2-20). Реестр готов до S2-20, чтобы потоки баллов и сертификатов писали обработчики параллельно.
import type { Tx } from '../../core/audit.ts';

export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'points' | 'certificate' | 'none';
export type MoneyMethod = 'cash' | 'card' | 'transfer';
/** Способ, у которого есть строка платежа и обработчик (none – без строки и без проводки, K10 §2). */
export type LineMethod = Exclude<PaymentMethod, 'none'>;
export type PaymentSessionStatus = 'unpaid' | 'paid' | 'partially_refunded' | 'refunded';

export const MONEY_METHODS: readonly MoneyMethod[] = ['cash', 'card', 'transfer'];
export const LINE_METHODS: readonly LineMethod[] = ['cash', 'card', 'transfer', 'points', 'certificate'];

export interface PaymentSession {
  id: string; // = bookingId (1:1)
  bookingId: string;
  branchId: string;
  clientId: string;
  amountDueKop: number;
  bookingVersion: number;
  status: PaymentSessionStatus;
  /** Вычисляется по payments_one_live_per_session, столбца нет (model-dannyh 0205). */
  activePaymentId: string | null;
  rowVersion: number;
}

export interface PaymentLine {
  lineNo: 1 | 2;
  method: LineMethod;
  amountKop: number;
  pointsCenti?: number;
  certificateId?: string;
  ledgerPostingId: string;
  financeOperationId?: string;
}

export interface StaffAuthor {
  type: 'staff';
  id: string;
}

export interface ChargeInput {
  session: PaymentSession;
  /** Удержание, из которого создана бронь (payableBooking.holdId): points не вычитает его резерв – пока worker не
   *  перенёс резерв на бронь, это резерв самой брони (K15 §3). Бронь без удержания – null. */
  holdId?: string | null;
  lineNo: 1 | 2;
  amountKop: number;
  /** Минуты брони по расписанию (points: минуты × 100, 07 §6.1). */
  minutes: number;
  resourceType: string;
  /** Только certificate: номер и код (K16 §3); код проверен заранее отдельной транзакцией. */
  certificate?: { number: string; pin: string };
  /** Ключ K3 `payment:<sessionId>:<attempt>:<lineNo>` (K10 §9). */
  idempotencyKey: string;
  author: StaffAuthor;
  occurredAt: Date;
  /** drain – только сертификат при флаге R-03: списать весь остаток, вернуть фактическую сумму (K10 §2, §5). */
  mode: 'exact' | 'drain';
  /** «Чек пробит» для денежной строки (Q-23) – обработчики cash/card/transfer пишут в операцию кассы. */
  receiptIssued?: boolean;
}

export interface ChargeResult {
  postingId: string;
  amountKop: number;
  pointsCenti?: number;
  certificateId?: string;
  financeOperationId?: string;
}

export interface RefundInput {
  line: PaymentLine;
  amountKop: number;
  /** Ключ K3 `refund:<paymentId>:<lineNo>:<n>` (K10 §9). */
  idempotencyKey: string;
  author: StaffAuthor;
  occurredAt: Date;
  reason: string;
}

export interface RefundResult {
  postingId: string | null;
  outcome: 'returned' | 'not_restored';
}

/** K10 §5. Порядок внутри обработчика: блокировка своего счёта → перечитать из базы → проверить (решение). */
export interface PaymentMethodHandler {
  method: LineMethod;
  charge(tx: Tx, input: ChargeInput): Promise<ChargeResult>;
  refund(tx: Tx, input: RefundInput): Promise<RefundResult>;
}

const handlers = new Map<LineMethod, PaymentMethodHandler>();

/** Регистрация при старте API (server.ts). Дубль способа или неизвестный способ – ошибка программиста: падает старт. */
export function registerPaymentMethod(h: PaymentMethodHandler): void {
  if (!LINE_METHODS.includes(h.method)) throw new Error(`registerPaymentMethod: неизвестный способ «${String(h.method)}»`);
  if (handlers.has(h.method)) throw new Error(`registerPaymentMethod: способ «${h.method}» уже зарегистрирован`);
  handlers.set(h.method, h);
}

/** Обработчик способа или undefined (способ не подключён – finance отвечает, что способ недоступен). */
export function paymentMethodHandler(method: LineMethod): PaymentMethodHandler | undefined {
  return handlers.get(method);
}

/** Подключённые способы – для allowedMethods (K10 №19 считает сервер). */
export function registeredPaymentMethods(): LineMethod[] {
  return LINE_METHODS.filter((m) => handlers.has(m));
}

/** Только для тестов: снять регистрации. */
export function clearPaymentMethods(): void {
  handlers.clear();
}

// ---- события K10 §6 (дополняют K4). Payload без ПДн (K4 правило 2).

export interface PaymentRecordedPayload {
  paymentId: string;
  sessionId: string;
  bookingId: string;
  branchId: string;
  clientId: string;
  attempt: number;
  methods: PaymentMethod[];
  totalKop: number;
  pointsCenti: number | null;
  certificateId: string | null;
}

export interface PaymentRefundedPayload {
  refundId: string;
  paymentId: string;
  bookingId: string;
  clientId: string;
  lines: Array<{ lineNo: 1 | 2; method: LineMethod; amountKop: number; pointsCenti: number | null; outcome: 'returned' | 'not_restored' }>;
  reason: string;
  /** refunded – полный возврат: loyalty сторнирует начисление (K15 §4, Q-102). */
  sessionStatus: PaymentSessionStatus;
}

declare module '../../core/outbox.ts' {
  interface EventRegistry {
    'payment.recorded': PaymentRecordedPayload;
    'payment.refunded': PaymentRefundedPayload;
  }
}
