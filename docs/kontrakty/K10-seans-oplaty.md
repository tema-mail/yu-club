# K10. Сеанс оплаты

Статус: контракт на Э2 (П8), фиксируется сейчас, чтобы бронь Э1 не пришлось менять. Модуль: `finance` (`apps/api/src/modules/finance/payment.ts`). Таблицы `payment_sessions`, `payments` – миграции Э2 (в `model-dannyh.md` их нет, номера 02xx).
Основа: 16 §7; 06 §5; 08 §6.5; 07 §6; 17 §9; R-04 (открыт); Q-20.

## Что фиксируем в Э1

- **Сеанс оплаты = одна бронь** (R-04 по умолчанию, план 5.3). Составной визит (два ресурса подряд) – это несколько броней одного `checkoutId` (K5), у каждой свой сеанс и свой платёж.
- В брони уже есть всё, что нужно оплате: `bookings.price_kop` и `booking_versions.price_snapshot` (цена на момент брони, 15 §9.4). Э1 денег не принимает: `BookingDto.paymentNote = 'pay_at_club'`.
- Бронь Э1 **не получает** столбцов оплаты; статус оплаты живёт в `finance`, бронь его не хранит (ADR 0002 п.1). CRM получает его через `finance/index.ts`.

## Модель Э2 (черновик контракта)

```ts
export type PaymentMethod = 'cash' | 'card_terminal' | 'transfer' | 'loyalty_points' | 'certificate';   // 06 §5.1, 16 §7
export type PaymentSessionStatus = 'unpaid' | 'paid' | 'refunded' | 'partially_refunded' | 'cancelled';

export interface PaymentSession {
  id: string;                 // = bookingId (решение: 1:1, ключ сеанса – бронь)
  bookingId: string; branchId: string; clientId: string;
  amountDueKop: number;       // цена версии брони на момент проведения
  bookingVersion: number;
  status: PaymentSessionStatus;
}

/** Провести оплату сеанса. Ровно один способ на сеанс (08 §6.5, 16 §7.1).
 *  Внутри: SELECT session FOR UPDATE → нет активного платежа → ledger.post (K3) с ключом `payment:<sessionId>`
 *  (касса филиала / бонусный счёт / сертификат – по способу) → payments(active) → аудит → событие payment.recorded.
 *  Повтор с тем же Idempotency-Key → прежний результат; другая попытка при уже оплаченном → ALREADY_PAID (16 §15.3:
 *  сначала ищем исходную операцию). */
export function recordPayment(tx: Tx, ctx: AccessContext, input: {
  bookingId: string; method: PaymentMethod; amountKop: number;
  certificateId?: string;     // для 'certificate'
  comment?: string;
}, meta: AuditRequestMeta): Promise<{ paymentId: string; sessionStatus: PaymentSessionStatus }>;

/** Возврат – отдельная операция с решением сотрудника (16 §7.5, 06 §5.2); отмена брони сама деньги не возвращает (01 §12). */
export function refundPayment(tx: Tx, ctx: AccessContext, input: { paymentId: string; amountKop: number; reason: string }, meta: AuditRequestMeta): Promise<{ refundId: string }>;

export function getPaymentStatus(db: Db, bookingIds: string[]): Promise<Map<string, PaymentSessionStatus>>;
```

Ограничение базы Э2: `CREATE UNIQUE INDEX payments_one_active_per_session ON payments (session_id) WHERE status = 'active'` – два платежа на сеанс невозможны даже при гонке (TC-07).

## События (добавятся в K4 в Э2)

| `type` | Когда | Payload |
|---|---|---|
| `payment.recorded` @1 | платёж проведён | `{ paymentId, sessionId, bookingId, branchId, clientId, method, amountKop }` |
| `payment.refunded` @1 | возврат проведён | `{ refundId, paymentId, bookingId, amountKop, reason }` |

Потребители: `loyalty` – не начислять баллы за сеанс, оплаченный баллами (Q-40 по умолчанию); CRM – статус «к оплате».

## Ошибки (Э2)

| Код | HTTP | Когда |
|---|---|---|
| `ALREADY_PAID` | 409 | у сеанса есть активный платёж (`details.paymentId`) |
| `AMOUNT_MISMATCH` | 422 | сумма ≠ `amountDueKop` (частичная оплата одним способом не предусмотрена; R-03 – остаток сертификата меньше цены – открыт) |
| `BOOKING_NOT_PAYABLE` | 409 | бронь отменена или неявка |
| `BALANCE_BELOW_LIMIT` | 409 | K3: не хватает баллов / остатка сертификата |
| `CERTIFICATE_EXPIRED` | 409 | 08 §6.3 |

## Открыто (влияет на этот контракт)

R-04 «что такое один сеанс» (если сеанс = визит из нескольких броней – `PaymentSession.id` станет отдельным uuid со списком броней; сигнатура `recordPayment` примет `sessionId`), R-03, Q-20 (оплата до или после), Q-22 (касса одна или по способам).
