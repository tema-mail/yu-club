# K10. Сеанс оплаты

Статус: **финальная версия для Э2** (02.11.2026), заменяет черновик Э1. Модуль-владелец: `finance` (`apps/api/src/modules/finance/payment.ts`, `methods.ts` (реестр способов и типы событий), `refund.ts`, `routes.payments.ts`). Таблицы: `payment_sessions`, `payments`, `payment_lines`, `payment_refunds` (миграция `0205_payments.sql`).
Основа: 06 §5, §5.1–5.2, §12; 08 §6.3–6.5, §9.2; 07 §6.1–6.4; 13 §12.1 п.8–10; 16 §7, §15.2–15.3; 20 §4.5, §9.1, TC-07, TC-08; 18 §6.3. Смежные контракты: K3 (журнал), K4 (события), K15 (баллы), K16 (сертификаты), K17 (касса), K1 (права), K7 (настройки).

Пометки: «по умолчанию, ждёт заказчика (Q-xx)» – умолчание плана, меняется решением заказчика; «решение» – вывод архитектора, не пункт ТЗ.

## 1. Что такое сеанс и когда он оплачивается

- **Сеанс оплаты = одна бронь** – по умолчанию, ждёт заказчика (Q-16 / R-04). Составной визит (несколько броней одного `checkoutId`) – несколько сеансов, у каждого свой платёж. CRM может провести их подряд одним способом одной кнопкой – это N вызовов `recordPayment`, не один платёж.
- **Момент оплаты – после прихода, при закрытии сеанса администратором** (13 §12.1 п.8–9: «после посещения фиксируется приход/завершение, оплата регистрируется»). Оплата разрешена, только если бронь в статусе `arrived` или `completed`. Предоплата и оплата на сайте – **не в Э2** – по умолчанию, ждёт заказчика (Q-20).
- Бронь сама денег не создаёт (06 §5, 20 §4.5). Статус оплаты брони живёт в `finance`, в таблице броней столбцов оплаты нет (ADR 0002 п.1).
- **Закрытие сеанса = проведённая оплата** (решение). Событие `payment.recorded` – сигнал «сеанс закрыт» для начисления баллов (K15 §4): так модуль баллов знает способ оплаты (Q-40 по умолчанию: за сеанс, оплаченный баллами, баллы не начисляются) и выполняет 07 §4.4 «после подтверждения посещения и завершения сеанса». Одного `visit.confirmed` для начисления мало (черновик K4 меняется): начисление – когда у брони есть и активное посещение, и живой платёж; `visit.confirmed` нужен только для случая «посещение исправили и отметили заново после оплаты».
- Неоплаченный сеанс в статусе `arrived`/`completed` попадает в список «к оплате» (Q-20 по умолчанию), долг клиента не ведётся.
- Сумма к оплате – `price_kop` текущей версии брони (снимок тарифа, 15 §9.4). Перенос меняет версию – к оплате идёт цена новой версии.

## 2. Один способ на сеанс и единственное исключение (R-03)

Способы (06 §5.1, 16 §7, 08 §6): `cash` (наличные), `card` (терминал), `transfer` (перевод), `points` (баллы), `certificate` (сертификат), `none` (сумма к оплате 0 ₽, решение: без проводки, чтобы не писать нулевую запись в K3).

**Правило:** один сеанс закрывается одним способом (06 §5.1, 08 §6.5, 16 §7.1, 20 §4.5). Смешивать нельзя никакие пары (TC-07).

**Исключение «сертификат + доплата деньгами»** – флаг настройки `payment.certificate_topup_enabled` (K7, уровень «сеть», по умолчанию `false`).
- `false` – **по умолчанию, ждёт заказчика (Q-24 / R-03)**: строго по 08 §2 «последнее зафиксированное правило» и 08 §6.5 – если остаток сертификата меньше суммы, сертификат для сеанса не применим (`CERTIFICATE_INSUFFICIENT`). Выбрано по плану (раздел 9, риск 6: «строго по ТЗ, но с предупреждением при продаже»).
- `true` – сертификат списывается **полностью** (весь остаток, он меньше суммы), разница – одной денежной строкой `cash | card | transfer`. Других сочетаний флаг не открывает: баллы с доплатой запрещены подтверждённым правилом 07 §6.1, его флаг не трогает.
- Модель данных одна для обоих значений: у платежа 1 или 2 строки (`payment_lines`). Смена флага – без миграции и без изменения API. Платёж хранит значение флага на момент проведения (`topup_rule_snapshot`), смена флага прошлые платежи не трогает (15 §3.4).

## 3. Модель

```ts
export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'points' | 'certificate' | 'none';
export type MoneyMethod = 'cash' | 'card' | 'transfer';
export type PaymentSessionStatus = 'unpaid' | 'paid' | 'partially_refunded' | 'refunded';

export interface PaymentSession {
  id: string;                  // = bookingId (1:1)
  bookingId: string; branchId: string; clientId: string;
  amountDueKop: number;        // цена версии брони на момент первой попытки оплаты
  bookingVersion: number;
  status: PaymentSessionStatus;
  activePaymentId: string | null;   // вычисляется: живой платёж из payments_one_live_per_session, столбца нет (model-dannyh 0205)
  rowVersion: number;
}

export interface PaymentLine {
  method: Exclude<PaymentMethod, 'none'>;
  amountKop: number;           // для points – эквивалент в копейках не считается: amountKop = amountDueKop, баллы – в pointsCenti
  pointsCenti?: number;        // points: минуты брони × 100 (1 балл = 1 минута, 07 §6.1)
  certificateId?: string;
  ledgerPostingId: string;     // K3 posting
  financeOperationId?: string; // K17, только для денежных строк
}

export interface Payment {
  id: string; sessionId: string; attempt: number;  // 1, 2… – новая попытка возможна только после полного возврата
  status: 'active' | 'partially_refunded' | 'refunded';
  lines: PaymentLine[];        // 1 строка; 2 – только сертификат + деньги при флаге R-03
  totalKop: number; recordedBy: string; recordedAt: string; topupRuleSnapshot: boolean;
}
```

Таблицы (`0205_payments.sql`):
- `payment_sessions` (PK = `booking_id` → `bookings`, `branch_id`, `client_id`, `amount_due_kop`, `booking_version`, `status`, `row_version`). Создаётся лениво первой командой оплаты: `INSERT … ON CONFLICT DO NOTHING`, затем `SELECT … FOR UPDATE`.
- `payments` (`session_id` → `payment_sessions`, `attempt`, `status`, `total_kop`, `topup_rule_snapshot`, автор, время). **`CREATE UNIQUE INDEX payments_one_live_per_session ON payments (session_id) WHERE status IN ('active','partially_refunded')`** – второй живой платёж невозможен даже при гонке (TC-07, 18 §6.3). `UNIQUE (session_id, attempt)`.
- `payment_lines` (`payment_id`, `line_no` 1..2, `method`, `amount_kop`, `points_centi`, `certificate_id` → `certificates`, `ledger_posting_id`, `finance_operation_id` → `finance_operations`). `CHECK`: строк ≤ 2; вторая строка допустима, только если первая `certificate`, а вторая `cash|card|transfer` (проверка триггером на вставку, решение).
- `payment_refunds` (`payment_id`, `line_no`, `seq` – номер возврата строки, `n` в ключе K3 раздела 9, `amount_kop`, `points_centi`, `reason`, автор, `ledger_posting_id`, `outcome`: `returned` | `not_restored`).

## 4. Функции

```ts
/** Провести оплату сеанса (K11 №19). Одна транзакция, без внешних вызовов:
 *  1) booking.payableBooking(tx, bookingId) – статус arrived|completed, цена версии, клиент, филиал (провайдер booking, FOR SHARE брони);
 *     иначе BOOKING_NOT_PAYABLE;
 *  2) session: INSERT ON CONFLICT DO NOTHING → SELECT FOR UPDATE; есть живой платёж → ALREADY_PAID (details.paymentId) –
 *     так выполняется 16 §15.3 «сначала найти исходную операцию»;
 *  3) проверка правила способа (раздел 2); сумма ≠ amountDue → AMOUNT_MISMATCH;
 *  4) для каждой строки – обработчик способа (раздел 5), проводка K3 с ключом `payment:<sessionId>:<attempt>:<lineNo>`;
 *  5) payments + payment_lines, session.status = 'paid', row_version + 1;
 *  6) аудит payment.recorded (K2), событие payment.recorded (K4).
 *  HTTP-слой: Idempotency-Key обязателен (core/idempotency.ts): повтор с тем же ключом → прежний ответ 201. */
export function recordPayment(tx: Tx, ctx: AccessContext, input: {
  bookingId: string;
  lines: Array<{ method: MoneyMethod | 'points' | 'certificate' | 'none'; amountKop: number;
                 certificate?: { number: string; pin: string } }>;     // pin – K16 §3
  comment?: string;
  receiptIssued?: boolean;    // «чек пробит» для денежной строки – в операцию кассы K17 (Q-23)
}, meta: AuditRequestMeta, clock?: Clock): Promise<{ paymentId: string; session: PaymentSession }>;

/** Возврат – отдельная операция с решением сотрудника (06 §5.2, 16 §7.5). Причина обязательна. Отмена брони сама денег
 *  не возвращает (01 §12, 13 §12.2 п.8). Деньги – частично или целиком; баллы и сертификат – только целиком (решение:
 *  частичный возврат в партии и в сертификат дробит исходные проводки без пользы для клуба).
 *  Возврат строки сертификата после окончания срока → outcome 'not_restored' (08 §9.2), денег не создаёт;
 *  денежный возврат за такой сертификат – отдельный ручной расход-возврат кассы (K17) по праву finance.refund.
 *  Ключ K3: `refund:<paymentId>:<lineNo>:<n>`. */
export function refundPayment(tx: Tx, ctx: AccessContext, input: {
  paymentId: string; lines: Array<{ lineNo: 1 | 2; amountKop?: number }>; reason: string; rowVersion: number;
}, meta: AuditRequestMeta, clock?: Clock): Promise<{ refundIds: string[]; session: PaymentSession }>;

/** Статусы для CRM-календаря, карточки брони, списка «к оплате». Брони без сессии – 'unpaid'. */
export function getPaymentStatus(db: Db, bookingIds: string[]): Promise<Map<string, PaymentSessionStatus>>;

/** «К оплате»: брони arrived|completed без живого платежа, по суткам филиала (K8). Курсор (start, number). */
export function listUnpaid(db: Db, ctx: AccessContext, input: { branchId: string; date: LocalDate; cursor?: string; limit?: number }): Promise<Page<UnpaidRow>>;
```

После полного возврата (`refunded`) сеанс можно оплатить заново (`attempt + 1`) – так исправляется ошибка способа (16 §7.2 «ошибка исправляется возвратом/корректировкой»). Живой платёж по-прежнему один (индекс выше).

## 5. Обработчики способов (реестр, без импорта модулей друг другом)

```ts
/** finance вызывает обработчик по method; loyalty и certificates регистрируют свои в server.ts (ADR 0002, как providers.ts). */
export interface PaymentMethodHandler {
  method: 'cash' | 'card' | 'transfer' | 'points' | 'certificate';
  /** Проверить и провести строку в tx команды. Возвращает posting K3. Ошибки – коды ниже. */
  charge(tx: Tx, input: { session: PaymentSession; lineNo: 1 | 2; amountKop: number; minutes: number;
    resourceType: string; certificate?: { number: string; pin: string }; idempotencyKey: string;
    author: { type: 'staff'; id: string }; occurredAt: Date; mode: 'exact' | 'drain';
    paymentId?: string; meta?: AuditRequestMeta }):   // paymentId – платёж уже вставлен (certificate_redemptions.payment_id NOT NULL, FK 0205); meta – для аудита обработчика
    Promise<{ postingId: string; amountKop: number; pointsCenti?: number; certificateId?: string; financeOperationId?: string }>;
  refund(tx: Tx, input: { line: PaymentLine; amountKop: number; idempotencyKey: string; author: { type: 'staff'; id: string }; occurredAt: Date; reason: string; meta?: AuditRequestMeta }):
    Promise<{ postingId: string | null; outcome: 'returned' | 'not_restored' }>;
}
export function registerPaymentMethod(h: PaymentMethodHandler): void;
```

| Способ | Обработчик | Проводка (K3) | Основание |
|---|---|---|---|
| `cash` | `finance` (K17) | `cash.income` +сумма на место «наличные» филиала сеанса + `finance_operations` (источник `session`) | 06 §5, §5.1 |
| `card`, `transfer` | `finance` (K17) | `cash.income` +сумма на место «безнал» филиала, способ – в операции | 06 §5.1; K17 §2 |
| `points` | `loyalty` (K15 §6) | `loyalty.spend_time` −минуты×100 на бонусный счёт; партии FEFO; резерв брони гасится | 07 §6.1–6.3, 06 §5.1 «баллы не увеличивают кассу» |
| `certificate` | `certificates` (K16 §5) | `certificate.redeem` −сумма на счёт сертификата; денежного поступления нет | 08 §6.4, §12.2; TC-08 |

`mode: 'drain'` – только строка сертификата при флаге R-03: списать весь остаток, вернуть фактическую сумму; finance добавляет денежную строку на разницу. После обработчика finance сверяет: `0 < списано сертификатом < amountDue` и `списано + денежная строка = amountDue`; иначе исключение и откат всей транзакции (правка по ревью 02.11: остаток мог измениться между проверкой на экране и проводкой).

Обработчики соблюдают порядок **блокировка → перечитать → проверить** (решение): `lockAccounts` своего счёта, затем срок, статус и остаток читаются из базы под блокировкой; проверки экрана и `POST /certificates/check` – только подсказка.

## 6. События (дополняют K4)

| `type` @ver | Когда | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `payment.recorded` @1 | платёж проведён | `<paymentId>` | `{ paymentId, sessionId, bookingId, branchId, clientId, attempt, methods: PaymentMethod[], totalKop, pointsCenti \| null, certificateId \| null }` | loyalty: начисление (K15 §4); CRM: статус |
| `payment.refunded` @1 | возврат проведён | `<refundId>` | `{ refundId, paymentId, bookingId, clientId, lines: [{ lineNo, method, amountKop, pointsCenti \| null, outcome }], reason, sessionStatus }` | loyalty: при `sessionStatus = 'refunded'` – сторно начисления (K15 §4, Q-102 по умолчанию); CRM; отчёты Э4 |

Payload без ПДн (K4 правило 2).

## 7. Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `ALREADY_PAID` | 409 | у сеанса есть живой платёж (`details.paymentId`) |
| `AMOUNT_MISMATCH` | 422 | сумма строк ≠ `amountDueKop` |
| `PAYMENT_METHODS_COMBINED` | 422 | больше одной строки при выключенном флаге R-03, или пара не «сертификат + деньги» (TC-07) |
| `BOOKING_NOT_PAYABLE` | 409 | бронь не `arrived`/`completed` (не пришёл, отменена, неявка) |
| `NOTHING_TO_PAY` | 422 | способ `none` при сумме > 0 или деньги при сумме 0 |
| `POINTS_INSUFFICIENT` | 409 | доступных баллов меньше минут сеанса (K15 §6); доплата не предлагается (07 §6.2) |
| `POINTS_NOT_ALLOWED` | 422 | тип ресурса не оплачивается баллами (K7 `loyalty.points_resource_types`; Q-42) |
| `CERTIFICATE_NOT_FOUND` | 404 | номер или код неверны (одно сообщение на оба случая, K16 §3) |
| `CERTIFICATE_EXPIRED` | 409 | срок прошёл (08 §6.3 п.3) |
| `CERTIFICATE_NOT_ACTIVE` | 409 | отменён, «требует проверки», погашен полностью |
| `CERTIFICATE_INSUFFICIENT` | 409 | остаток < суммы при выключенном флаге R-03 (`details.balanceKop`) |
| `REFUND_EXCEEDS_PAID` | 422 | сумма возврата больше непогашенной части строки |
| `REFUND_PARTIAL_NOT_ALLOWED` | 422 | частичный возврат строки баллов или сертификата |
| `VERSION_CONFLICT` | 409 | устаревший `rowVersion` сессии (16 §15.4) |
| `PERIOD_CLOSED` | 409 | дата операции в закрытом периоде (K17 §6) |

## 8. Права (K1, новые действия – шаг S2-01)

| Действие | Роли | Основание |
|---|---|---|
| `finance.payment.record` | Владелец, Директор, Администратор (своя зона) | R-14 / Q-29 по умолчанию: Администратор проводит оплаты сеансов |
| `finance.refund` | Владелец, Директор | K1 (решение Э1), Q-29 по умолчанию |
| `finance.payment.view` | Владелец, Директор, Администратор | статус оплаты в карточке брони |

## 9. Идемпотентность и неизвестный исход

- Внешних эффектов нет (эквайринга нет, 06 §9) – исхода «неизвестно» у команды нет: либо транзакция зафиксирована, либо нет.
- Ответ потерян (16 §15.3): повтор с тем же `Idempotency-Key` → прежний ответ; новый ключ → `ALREADY_PAID` с `paymentId` исходного платежа. CRM при `ALREADY_PAID` показывает проведённый платёж, а не ошибку.
- Ключи K3 детерминированы от факта (K3 правило 4): `payment:<sessionId>:<attempt>:<lineNo>`, `refund:<paymentId>:<lineNo>:<n>`. Уточнение K3 правила 4: ключ `payment:<sessionId>` из черновика заменён на ключ с попыткой – иначе повторная оплата после полного возврата упрётся в `UNIQUE`.

## 10. Изменения смежных контрактов (вносятся шагом S2-00; внесены 02.11.2026 – K1, K3, K4, K7, K11; K5 и K9 – по K15 §8 (ворота −50); реестр `docs/reshenia.md`)

- K4: у `visit.confirmed` потребитель loyalty – «начисление, если у брони уже есть живой платёж» (K15 §4); добавить `payment.recorded`, `payment.refunded` (раздел 6) и события K15, K16.
- K3: правило 4 – ключ оплаты по разделу 9; новый вид счёта `cash_branch_noncash` (K17 §2); тип ссылки `payment` (`RefType` в `ledger.ts`, шаг S2-10); предел счёта – только для списаний (миграция 0201, шаг S2-07); ключ начисления – `loyalty-accrual:<visitId>:<paymentId>` (K15 §4).
- K4 и `core/outbox.ts`: `AggregateType` + `'payment'`, `'certificate'` (шаг S2-06).
- K11: маршруты №19–23 (раздел 11).
- K1: действия раздела 8, K15 §10, K16 §9, K17 §8.
- K7: ключи `payment.*`, `finance.*`, `loyalty.*`, `certificate.*` из K10, K15–K17.

## 11. API CRM (дополняет K11)

| # | Метод и путь | Право | Тело | Успех |
|---|---|---|---|---|
| 19 | `GET /bookings/{bookingId}/payment` | `finance.payment.view` | – | `200 { session, payment \| null, refunds[], allowedMethods: PaymentMethod[], topupEnabled, pointsAvailableCenti \| null, pointsRequiredCenti \| null }` – сервер считает допустимые способы (решение: экран не считает, 20 §3) |
| 20 | `POST /bookings/{bookingId}/payment` | `finance.payment.record` | `{ lines, comment? }` + `Idempotency-Key` | `201 { paymentId, session }` |
| 21 | `POST /payments/{paymentId}/refund` | `finance.refund` | `{ rowVersion, lines, reason }` + `Idempotency-Key` | `201 { refundIds, session }` |
| 22 | `GET /branches/{branchId}/unpaid?date=` | `finance.payment.view` | – | `200 { items: UnpaidRow[], nextCursor }` |
| 23 | `POST /bookings/payment-status` | `finance.payment.view` | `{ bookingIds ≤ 200 }` | `200 { items: [{ bookingId, status }] }` – для календаря |

Объект вне зоны – `404`, как несуществующий (K11 «Общее»).

## 12. Проверка

- TC-07: каждая пара способов при `topup=false` → `PAYMENT_METHODS_COMBINED`; при `topup=true` проходит только «сертификат + деньги», «баллы + деньги» – отказ.
- 50 параллельных `recordPayment` одной брони с разными ключами → один платёж, 49 `ALREADY_PAID` (индекс, не код).
- Повтор с тем же ключом → тот же `paymentId`, одна проводка (18 §6.3 п.1).
- Оплата брони `confirmed`, `no_show`, `cancelled_*` → `BOOKING_NOT_PAYABLE`.
- Возврат не удаляет платёж и проводку, исходная запись цела, баланс кассы уменьшился (18 §6.3 п.10).
- Полный возврат → повторная оплата `attempt=2` другим способом проходит; частичный возврат → повторная оплата `ALREADY_PAID`.
- Смена флага R-03 между двумя платежами: первый хранит `topup_rule_snapshot=false`, второй `true`.
- Генерируемый IDOR-тест по маршрутам №19–23.
