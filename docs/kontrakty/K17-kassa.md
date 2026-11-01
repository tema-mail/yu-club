# K17. Касса филиала: места денег, приход и расход, сторно, смена и сверка

Статус: контракт Э2 (02.11.2026). Модуль-владелец: `finance` (`apps/api/src/modules/finance/cashbox.ts`, `categories.ts`, `corrections.ts`, `summary.ts`, `shift.ts`, `routes.crm.ts`). Таблицы: `finance_categories`, `finance_operations`, `finance_opening_balances`, `finance_periods` (`0202_finance.sql`), `cash_shifts` (`0206_cash_shifts.sql`).
Основа: 06 §2–§16, §17 (приёмка), §18; 16 §7.2, §14, §19 п.17–19; 18 §6.2 п.4, 12–15, §6.5; 20 §4.11, §9.1; K3 (журнал), K10 (оплата), K16 (продажа сертификата).

Пометки: «по умолчанию, ждёт заказчика (Q-xx)» – умолчание плана; «решение» – вывод архитектора.

## 1. Финансовый контур филиала

Каждый филиал – отдельный контур (06 §3, приёмка 1): операции, остатки, категории, журнал, отчёт, аудит. Валюта – рубли, суммы – целые копейки (K3). Учёт ручной, без банков, эквайринга и онлайн-касс; система не заявляет автоматической сверки (06 §9, приёмка 22). Поле «чек пробит» у прихода – по умолчанию, ждёт заказчика (Q-23, 54-ФЗ вне системы).

## 2. Одна касса, два места денег (решение)

06 §3 даёт «одну основную кассу на филиал» и оставляет разделение наличных и безнала открытым (06 §18 в.1, в.9; Q-22). Разбор 05–08 (модуль 06, дыра 1) показал: если безнал и перевод идут в тот же остаток, остаток кассы перестаёт совпадать с наличными в ящике и сверка смены невозможна. **Решение:** касса филиала одна (один контур, один отчёт, один итог), но её остаток живёт на **двух счетах K3**:

| Место денег | Счёт K3 | Что сюда | Сверяется пересчётом |
|---|---|---|---|
| `cash` – наличные | `kind='cash_branch'` | оплата наличными, наличные расходы, изъятия | да (§7) |
| `noncash` – безнал | `kind='cash_branch_noncash'` (новый вид, миграция 0202) | терминал (`card`) и перевод (`transfer`); способ хранится в операции | нет (сверка с выпиской – после Э2, 06 §16 «последующие этапы») |

- Итог кассы = `cash + noncash`; формула 06 §3.2 выполняется для каждого места и для итога.
- Отчёт по способам (06 §18 в.9) – по полю `method` операции, третьего счёта не нужно.
- Если заказчик выберет «строго одна касса» (Q-22) – отчёт показывает только итог, данные не меняются. Обратный переход (из одного счёта в два) потребовал бы переразметки истории – поэтому разделяем сразу.
- Межфилиальных переводов в Э2 нет (06 §4.3 «не подтверждены»). Перевод **между местами одного филиала** (сдача наличных на счёт) – есть, §4.

## 3. Операция

```ts
export type MoneyPlace = 'cash' | 'noncash';
export type OperationKind =
  | 'opening_balance'   // начальный остаток (06 §3.1)
  | 'income'            // доход (06 §4.1): source = session | certificate_sale | event | extra_service | other
  | 'expense'           // расход (06 §4.2, §8)
  | 'withdrawal'        // изъятие наличных владельцем, не расход (18 §6.2 п.13)
  | 'place_transfer'    // перевод между местами одного филиала: две записи K3 в одной проводке
  | 'refund'            // возврат клиенту (06 §5.2, K10)
  | 'correction'        // корректировка (06 §4.4)
  | 'reversal';         // сторно операции (06 §4.4)

export interface FinanceOperationDto {
  id: string; number: number;                // сквозной номер для поиска
  branchId: string; kind: OperationKind; place: MoneyPlace; method: 'cash' | 'card' | 'transfer' | null;
  direction: 'in' | 'out';
  amountKop: number;                         // > 0; знак – direction
  source: 'session' | 'certificate_sale' | 'event' | 'extra_service' | 'other' | null;   // для income
  categoryId: string | null; subcategoryId: string | null;   // для expense – обязательно (§5)
  comment: string | null;                    // для expense, correction, reversal, withdrawal – обязателен (06 §8, приёмка 9)
  ref: { type: 'booking' | 'payment' | 'certificate' | 'event' | 'repair' | 'staff' | 'operation'; id: string } | null;
  receiptIssued: boolean | null;             // Q-23
  occurredAt: string; recordedAt: string; authorId: string;
  balanceAfterKop: number;                   // остаток места после (06 §10 «остаток после операции»)
  reversedBy: string | null; reversalOf: string | null;
  shiftId: string | null;
  postingId: string;                         // K3
}
```

- `journal.finance_operations` – **только вставка** (как `ledger_entries`): операция – заголовок проводки K3 с бизнес-смыслом (категория, источник, способ, комментарий). 1 операция = 1 проводка K3. `UNIQUE (reversal_of)` – второе сторно невозможно.
- Порядок журнала – `(occurred_at, number)`, стабильный при совпадении времени (06 §10).
- Вложения (06 §8) – **не в Э2** (решение): хранилища файлов нет до медиатеки Э4, 06 §8 запрещает делать вложение обязательным; обязательный комментарий есть. Поле `attachments` добавится совместимо.

## 4. Команды

```ts
/** Ядро для всех денежных операций, в том числе чужих модулей (K10 оплата, K16 продажа).
 *  В tx вызывающей команды: место денег филиала (ensureAccount: min_balance NULL, правило §6 – в коде) → lockAccounts →
 *  проверки §6 → K3 post(entries + linkedEntries одной проводкой) → finance_operations → аудит finance.operation.created.
 *  linkedEntries – записи того же намерения на других счетах (K16: certificate.issue), одна единица RUB_KOP (K3 правило 3). */
export function postMoneyOperation(tx: Tx, ctx: AccessContext | SystemCtx, op: NewOperation,
  opts: { idempotencyKey: string; linkedEntries?: EntryInput[] }, meta: AuditRequestMeta, clock?: Clock): Promise<FinanceOperationDto>;

export function recordOpeningBalance(tx, ctx, input: { branchId; place: MoneyPlace; amountKop; date: LocalDate; comment }, meta): Promise<FinanceOperationDto>;
export function recordIncome(tx, ctx, input: { branchId; place; method; amountKop; source: 'event' | 'extra_service' | 'other'; occurredAt; comment?; ref?; receiptIssued? }, meta): Promise<FinanceOperationDto>;
export function recordExpense(tx, ctx, input: { branchId; place; method; amountKop; categoryId; subcategoryId?; occurredAt; comment; ref? }, meta): Promise<FinanceOperationDto>;
export function recordWithdrawal(tx, ctx, input: { branchId; amountKop; occurredAt; comment }, meta): Promise<FinanceOperationDto>;   // только cash
export function transferBetweenPlaces(tx, ctx, input: { branchId; from: MoneyPlace; amountKop; occurredAt; comment }, meta): Promise<FinanceOperationDto>;

/** Сторно: обратная запись K3 (reverse), операция kind='reversal' со ссылкой; причина обязательна (06 §4.4).
 *  Приход с source='session' → USE_PAYMENT_REFUND (только K10 refundPayment), source='certificate_sale' → USE_CERTIFICATE_CANCEL
 *  (только K16 отмена продажи): иначе платёж или сертификат остались бы «живыми» без денег (правка по ревью 02.11). То же – correctOperation. */
export function reverseOperation(tx, ctx, input: { operationId; reason }, meta): Promise<FinanceOperationDto>;
/** Исправление = сторно + новая операция в одной транзакции (06 §8 «правка хранит старое и новое»): исходная не меняется. */
export function correctOperation(tx, ctx, input: { operationId; replacement: NewOperation; reason }, meta): Promise<{ reversal: FinanceOperationDto; replacement: FinanceOperationDto }>;

/** Предпросмотр «остаток после» до сохранения (06 §8, §13.3). Ничего не пишет. */
export function previewBalance(db, ctx, input: { branchId; place; deltaKop }): Promise<{ currentKop; afterKop; allowed: boolean; reason: 'negative_forbidden' | null }>;
```

- **Начальный остаток** (06 §3.1, приёмка 3): отдельный тип, один на место денег – `finance_opening_balances` с `UNIQUE (branch_id, place) WHERE status = 'active'`. Повторный ввод → `OPENING_BALANCE_EXISTS` с данными прежнего (предупреждение 06 §3.1, удвоения нет); заменить – сторно прежнего (право `finance.correct`) и новый ввод.
- **Доход по сеансу** создаёт только K10 (`source='session'`, `ref payment`). Ручная форма дохода не принимает `source='session'` → `SESSION_INCOME_VIA_PAYMENT` (06 §2 п.5, §13.2 «форма не создаёт дубль»).
- **Продажа сертификата** – только K16 (`source='certificate_sale'`).
- **Баллы и погашение сертификата** в кассу не пишутся никогда (06 §5.1, §12, приёмка 7).
- **Зарплата** – расход только при фактической выплате (06 §2 п.6), автоматика – Э3 (R-15).
- **Возврат** (`refund`) создаёт только K10 `refundPayment` и K16 отмена продажи; ссылка на исходную операцию обязательна (06 §5.2, приёмка 14).
- Повтор: HTTP `Idempotency-Key`; ключ K3 – `finance-op:<idempotencyKey>` для ручных, ключи K10/K16 – для их операций.

## 5. Категории (06 §7)

- `finance_categories`: `kind: 'income' | 'expense'`, `parent_id` (два уровня: категория и подкатегория, третьего нет – `CHECK` триггером), `name`, `sort_order`, `status: active | archived`. Сеть одна на всех (решение: справочник Владельца, 06 §7.2).
- Расход требует категорию; если у категории есть активные подкатегории – подкатегория обязательна (06 §8 «если предусмотрена», §13.4 «не выбрана подкатегория»).
- Использованная категория только архивируется (06 §7.2, приёмка 11); операции хранят свою категорию навсегда.
- Стартовый справочник – 06 §7.3, засевается миграцией 0202 как предложение (не закрытый перечень) – утверждение в 6.4.3 плана.

## 6. Отрицательный остаток и закрытый период

- **Отрицательный остаток** (06 §3.3): `finance.negative_balance_allowed` (K7, сеть → филиал), по умолчанию `false` – по умолчанию, ждёт заказчика (Q-28). Проверка – в коде под `lockAccounts` места денег, а не `min_balance` счёта (решение: настройку можно менять, а `min_balance` у `yu_app` неизменяем, K3). Касаются: `expense`, `withdrawal`, `place_transfer` (источник), `refund`, а также сторно и исправление **прихода** – они тоже уменьшают место денег (правка по ревью 02.11). При запрете → `CASH_INSUFFICIENT` с `details { currentKop, afterKop }` и текстом 06 §3.3 «внесите поступление или проверьте начальный остаток».
- **Закрытый период** (06 §8, §14; Q-28 по умолчанию: месяц закрывает Владелец): `finance_periods (branch_id, month, closed_at, closed_by)`. Операция с `occurred_at` в закрытом месяце → `PERIOD_CLOSED`. Исправление прошлого – корректирующая операция текущей датой со ссылкой на исходную (16 §14 последний абзац). Открыть закрытый месяц – нельзя (решение: иначе закрытие ничего не гарантирует).

## 7. Кассовая смена и сверка наличных (за флагом)

16 §19 п.18 и 06 §18 в.1 оставляют смену открытой; Q-22 по умолчанию: «закрытие смены с пересчётом наличных – включаемая настройка».

- `finance.cash_shift_enabled` (K7, филиал), по умолчанию `false` – по умолчанию, ждёт заказчика (Q-22).
- `false`: операций смены нет, наличные считаются только остатком счёта `cash`.
- `true`:
  1. Одна открытая смена на филиал (`UNIQUE (branch_id) WHERE status = 'open'`). Открывает Администратор: вводит пересчитанные наличные **вслепую** – ожидаемый остаток ему не показывается (решение по 06 §14: Администратор не видит остатки).
  2. Пока смены нет, операции места `cash` → `CASH_SHIFT_REQUIRED`; операции пишут `shift_id`.
  3. Закрытие: пересчёт наличных; система считает `expected = остаток cash` и `diff = counted − expected`. `diff = 0` → `closed`; `diff ≠ 0` → `needs_resolution`, автоматической проводки нет.
  4. Расхождение решает Директор или Владелец (`finance.shift.resolve`): корректировка `correction` на `diff` с причиной и ссылкой на смену, либо «принято без проводки» с причиной. Аудит.
  5. Расхождение при открытии (пересчёт ≠ остаток на конец прошлой смены) – тот же порядок.

## 8. Права (K1, шаг S2-01)

| Действие | Роли | Основание |
|---|---|---|
| `finance.view` | Владелец, Директор | 06 §14: остатки, журнал, отчёт своей зоны |
| `finance.view.day` | Владелец, Директор, Администратор | операции своего филиала за текущие сутки без остатков (06 §14 «ограниченные кассовые действия») |
| `finance.expense.create` | Владелец, Директор, Администратор | Q-29 по умолчанию: Администратор вносит расходы своего филиала |
| `finance.income.create` | Владелец, Директор | ручной доход; Администратор – вопрос в 6.4.3 плана (Q-29 называет только оплаты и расходы) |
| `finance.opening_balance` | Владелец | 06 §14 |
| `finance.withdrawal`, `finance.place_transfer` | Владелец, Директор | решение по 06 §14 |
| `finance.correct` | Владелец | K1 решение Э1; N-06 «кроме финкорректировок»; сторно и исправление |
| `finance.category.manage` | Владелец | 06 §7.2 |
| `finance.period.close` | Владелец | 06 §14, Q-28 |
| `finance.shift.operate` | Владелец, Директор, Администратор | открыть и закрыть смену своего филиала |
| `finance.shift.resolve` | Владелец, Директор | §7 п.4 |

Экспорт – Э4 (`finance.export`, 06 §11.5). Объект вне зоны – `404` как несуществующий (K11).

## 9. Сводка кассы (финсводка филиала, 06 §11.1–11.2, 18 §6.5)

```ts
interface CashSummaryDto {
  branchId: string; from: LocalDate; to: LocalDate; timezone: string;   // сутки – по зоне филиала (K8)
  places: Array<{ place: MoneyPlace; openingKop: number; incomeKop: number; expenseKop: number;
                  withdrawalKop: number; transferInKop: number; transferOutKop: number; correctionKop: number;
                  refundKop: number; closingKop: number }>;
  total: { openingKop; incomeKop; expenseKop; resultKop; closingKop; operationsCount };
  incomeBySource: Record<'session' | 'certificate_sale' | 'event' | 'extra_service' | 'other', number>;
  incomeByMethod: Record<'cash' | 'card' | 'transfer', number>;
  expenseByCategory: Array<{ categoryId; name; amountKop; sub: Array<{ subcategoryId; name; amountKop }> }>;
  nonMoney: { pointsSessions: number; pointsCenti: number; certificateRedeemedKop: number; certificateBurnedKop: number };  // 06 §11.2: отдельно
}
```

- `closing = opening + income − expense − withdrawal ± transfer ± correction − refund` для каждого места; `total.resultKop = income − expense − refund` (изъятия и переводы между местами – не доход и не расход, 06 §4.3, §11.4).
- Детализация = итог (TC-20 для кассы, 16 §14): каждое число сводки раскрывается списком операций с теми же фильтрами; тест сверяет суммы.
- Сеть (06 §11.4) – та же сводка по каждому филиалу зоны и сумма; переводов между филиалами в Э2 нет.

## 10. API CRM (дополняет K11)

| # | Метод и путь | Право | Успех |
|---|---|---|---|
| 37 | `GET /branches/{branchId}/finance/operations?from=&to=&kind=&categoryId=&authorId=&q=&cursor=` | `finance.view` / `finance.view.day` | `200 { items: FinanceOperationDto[], nextCursor }`; при `.day` – только текущие сутки, без `balanceAfterKop` |
| 38 | `POST /branches/{branchId}/finance/preview` | `finance.expense.create` | `200 { currentKop?, afterKop?, allowed, reason }` – для `.day` числа скрыты, только `allowed` |
| 39 | `POST /branches/{branchId}/finance/opening-balance` | `finance.opening_balance` | `201` |
| 40 | `POST /branches/{branchId}/finance/income` | `finance.income.create` | `201` |
| 41 | `POST /branches/{branchId}/finance/expense` | `finance.expense.create` | `201` |
| 42 | `POST /branches/{branchId}/finance/withdrawal` | `finance.withdrawal` | `201` |
| 43 | `POST /branches/{branchId}/finance/place-transfer` | `finance.place_transfer` | `201` |
| 44 | `POST /finance/operations/{id}/reverse` | `finance.correct` | `201`; `{ reason }` |
| 45 | `POST /finance/operations/{id}/correct` | `finance.correct` | `201`; `{ replacement, reason }` |
| 46 | `GET /finance/categories`, `POST`, `PATCH /finance/categories/{id}` | `finance.view.day` / `finance.category.manage` | дерево; архив вместо удаления |
| 47 | `POST /branches/{branchId}/finance/periods/{month}/close` | `finance.period.close` | `200` |
| 48 | `GET /branches/{branchId}/finance/summary?from=&to=`, `GET /finance/summary?from=&to=` (сеть) | `finance.view` | `200 CashSummaryDto` / `{ branches: CashSummaryDto[], total }` |
| 49 | `POST /branches/{branchId}/cash-shifts/open`, `POST /cash-shifts/{id}/close` | `finance.shift.operate` | `201 { shiftId }` / `200 { status }` – без `expected` и `diff` для Администратора |
| 50 | `POST /cash-shifts/{id}/resolve` | `finance.shift.resolve` | `200`; `{ action: 'correct' \| 'accept', reason }` |

Все изменяющие – `Idempotency-Key` обязателен (ADR 0004).

## 11. Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `CASH_INSUFFICIENT` | 409 | расход больше остатка места при запрете отрицательной кассы |
| `OPENING_BALANCE_EXISTS` | 409 | второй начальный остаток места (`details.operationId`) |
| `COMMENT_REQUIRED` | 422 | расход, сторно, корректировка, изъятие без комментария (общий код K11) |
| `SUBCATEGORY_REQUIRED` | 422 | у категории есть подкатегории, не выбрана |
| `CATEGORY_ARCHIVED` | 422 | выбрана архивная категория |
| `PERIOD_CLOSED` | 409 | дата операции в закрытом месяце |
| `ALREADY_REVERSED` | 409 | операция уже сторнирована (K3) |
| `SESSION_INCOME_VIA_PAYMENT` | 422 | ручной доход с источником «сеанс» |
| `USE_PAYMENT_REFUND` | 409 | сторно или исправление прихода по сеансу – только возвратом платежа (K10) |
| `USE_CERTIFICATE_CANCEL` | 409 | сторно или исправление прихода от продажи сертификата – только отменой продажи (K16 §6) |
| `CASH_SHIFT_REQUIRED` | 409 | смена включена и не открыта |
| `CASH_SHIFT_ALREADY_OPEN` | 409 | вторая открытая смена филиала |
| `INVALID_AMOUNT` | 422 | 0, дробное, отрицательное (K3) |

## 12. Настройки (K7, шаг S2-01)

| Ключ | Тип, уровень | По умолчанию | Основание |
|---|---|---|---|
| `finance.negative_balance_allowed` | `boolean`, сеть → филиал | `false` | Q-28, 06 §3.3 |
| `finance.cash_shift_enabled` | `boolean`, сеть → филиал | `false` | Q-22 |
| `payment.certificate_topup_enabled` | `boolean`, сеть | `false` | Q-24 / R-03 (K10 §2) |
| `certificate.sale_methods` | `string[]`, сеть | `['cash','card','transfer']` | Q-26 (K16 §2) |
| `certificate.nominal_min_kop`, `certificate.nominal_max_kop` | `int \| null`, сеть | `null` | 08 §4.5 |

## 13. Проверка (приёмка 06 §17)

- Остаток места = начальный + доходы − расходы ± корректировки (приёмка 4, 16) – property-based по случайным операциям и сторно.
- Второй начальный остаток → `OPENING_BALANCE_EXISTS`, остаток не удвоился (приёмка 3).
- Расход без комментария → `COMMENT_REQUIRED`; без подкатегории при наличии подкатегорий → `SUBCATEGORY_REQUIRED` (приёмка 9–10).
- Расход больше остатка при `false` → `CASH_INSUFFICIENT`; при `true` – проходит в минус.
- Сторно: исходная операция цела, вторая попытка → `ALREADY_REVERSED` (приёмка 15, 18 §6.3 п.10).
- Оплата наличными и картой одного дня → наличные в `cash`, карта в `noncash`; сводка по способам = сумма операций.
- Баллы и погашение сертификата не меняют ни одного места (приёмка 7, TC-08).
- Операция в закрытом месяце → `PERIOD_CLOSED`.
- Смена: Администратор не получает `expected`/`diff`; расхождение не проводится само.
- IDOR: каждый маршрут №37–50 с чужим филиалом → `404`. Администратор чужого филиала не видит операций; Директор – только своей зоны (приёмка 2).

## Решения 02.11 по итогам реализации S2-10…S2-14

- Администратор не видит остатков (§8, §10 главнее §6): `CASH_INSUFFICIENT` для него – без чисел остатка; Владелец и Директор получают числа.
- Предпросмотр №38 – только ролям, которые видят остаток; Администратору маршрут отвечает 403, расход проверяется самой командой (иначе подбором суммы остаток восстанавливается).
- Сторно операции `refund` запрещено (`USE_PAYMENT_REFUND`): возврат привязан к платежу K10, исправление – корректировкой.
- Порядок блокировок един для всего Э2: все счета журнала (места денег, баллы, сертификаты) – одним `lockAccounts` по возрастанию id, до любых других строк. Новые команды с несколькими счетами обязаны брать их одним вызовом.
