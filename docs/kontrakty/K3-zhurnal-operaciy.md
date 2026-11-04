# K3. Журнал операций со сторно

Модуль: `apps/api/src/core/ledger.ts`. Таблицы: `ledger_accounts`, `ledger_entries` (model-dannyh 0004; предел – 0201, вид `cash_branch_noncash` – 0202). Шаг: S0-07; правки Э2 – S2-07, S2-10 (по K10 §10, внесены S2-00 02.11.2026). Потребители: `finance` (П8), `loyalty`, `certificates` (Э2), `shifts` (П9a), `events` (П9c).
Основа: ADR 0004 §1; 06 §3–4, §10; 07 §3; 08 §3.3; 16 §2.7, §14; 17 §9.

## Типы

```ts
export type AccountKind = 'cash_branch' | 'cash_branch_noncash' | 'loyalty_client' | 'certificate' | 'staff_payroll';
// cash_branch – наличные филиала, cash_branch_noncash – безнал филиала (терминал и перевод; K17 §2, миграция 0202, S2-10)
export type Unit = 'RUB_KOP' | 'POINT_CENTI';     // копейки; сотые балла (2,5 балла = 250)

/** Целое минорных единиц. Проверка: Number.isSafeInteger(x) && x !== 0 для суммы записи. */
export type Minor = number;

export interface AccountRef {
  kind: AccountKind;
  ownerType: 'branch' | 'client' | 'certificate' | 'staff';
  ownerId: string;
}

export interface Account {
  id: string; kind: AccountKind; unit: Unit;
  branchId: string | null; ownerType: AccountRef['ownerType']; ownerId: string;
  balance: Minor; minBalance: Minor | null; status: 'active' | 'closed';
}

/** Тип записи. Реестр расширяется модулем-владельцем через правку этого файла. */
export type EntryType =
  // касса (06 §4) – Э2
  | 'cash.opening_balance' | 'cash.income' | 'cash.expense' | 'cash.transfer_out' | 'cash.transfer_in'
  | 'cash.withdrawal' | 'cash.correction' | 'cash.refund'
  // баллы (07) – Э2
  | 'loyalty.accrual' | 'loyalty.penalty' | 'loyalty.spend_time' | 'loyalty.spend_goods'
  | 'loyalty.return' | 'loyalty.expire' | 'loyalty.manual'
  // сертификат (08) – Э2
  | 'certificate.issue' | 'certificate.redeem' | 'certificate.expire' | 'certificate.correction'
  // расчёт сотрудника (05) – Э3
  | 'payroll.accrual' | 'payroll.penalty' | 'payroll.bonus' | 'payroll.payout' | 'payroll.correction'   // payroll.bonus – S3-00 (K18 §6), CHECK – 0306
  // общее
  | 'reversal';

export interface EntryInput {
  account: AccountRef;
  amount: Minor;                       // со знаком: + приход на счёт, − расход со счёта
  type: Exclude<EntryType, 'reversal'>;
  basis?: string;                      // основание/комментарий; обязателен для cash.expense, *.correction, loyalty.manual
  branchId: string | null;             // филиал ОПЕРАЦИИ (для счёта баллов – филиал визита)
  ref?: { type: 'booking' | 'visit' | 'no_show' | 'event' | 'repair' | 'certificate' | 'shift' | 'goods_order' | 'payment'
         | 'payroll_penalty' | 'payroll_bonus' | 'payroll_statement' | 'staff'; id: string };   // 'payment' – Э2, S2-10 (K10); payroll_* и staff – Э3 (K18 §6, §9; в коде – S3-15)
  refs?: Record<string, string>;       // доп. ссылки
  occurredAt: Date;                    // дата факта
}

export interface PostingInput {
  entries: EntryInput[];               // 1..N; все в одной транзакции, общий posting_id
  idempotencyKey: string;              // ключ НАМЕРЕНИЯ, напр. 'visit-accrual:<visitId>'; у записи i → `${key}#${i}`
  author: { type: 'staff' | 'client' | 'system'; id: string | null };
  /** Явный режим «ниже предела» (07 §3.1 «без специального разрешения»): только author.type='staff',
   *  вызывающий модуль заранее проверил право (Э2: `loyalty.adjust_below_limit`, K1 «Действия Э2»), basis обязателен.
   *  Пишется в запись (limit_override=true) и в аудит. */
  allowBelowLimit?: { reason: string };
}

export interface PostedEntry {
  id: number; postingId: string; accountId: string; amount: Minor; balanceAfter: Minor;
  type: EntryType; reversalOf: number | null; occurredAt: Date; recordedAt: Date;
}

export interface PostingResult { postingId: string; entries: PostedEntry[]; replayed: boolean }
```

Счёт `staff_payroll` (Э3, K18 §6): один на сотрудника, `owner_type='staff'`, `branch_id = NULL`, `min_balance = NULL`; филиал каждой записи – `EntryInput.branchId`. Ключи намерений: `payroll-accrual:<shiftId>:<factVersion>`, `payroll-penalty:<penaltyId>`, `payroll-payout:<statementId>`, `payroll-correction:<idempotencyKey>`.

## Функции

```ts
/** Найти или создать счёт (UNIQUE kind+owner). minBalance задаётся при создании:
 *  certificate → 0, loyalty_client → −5000 (−50 баллов, 07 §3.1), cash_branch и cash_branch_noncash → NULL (минус кассы проверяет
 *  код K17 §6 по настройке finance.negative_balance_allowed, а не min_balance), staff_payroll → NULL. */
export function ensureAccount(tx: Tx, ref: AccountRef, opts: { unit: Unit; branchId: string | null; minBalance: Minor | null }): Promise<Account>;

/** Проводка. Внутри:
 *  1) lockAccounts(tx, ids) – FOR UPDATE в порядке id (против взаимоблокировок);
 *  2) если запись с idempotency_key `${key}#0` уже есть → вернуть сохранённые записи, replayed=true (сравнить
 *     account/amount/type; расхождение → IDEMPOTENCY_KEY_REUSED);
 *  3) INSERT записей; balance_after и balance ставит ТОЛЬКО триггер ledger_entries_20_apply_balance
 *     (model-dannyh 0004) – код баланс не пишет, у yu_app нет на это права;
 *  4) 23514 с constraint 'ledger_balance_below_limit' → BALANCE_BELOW_LIMIT. Предел проверяется только у списания (amount < 0,
 *     миграция 0201, S2-07): приход на счёт ниже предела (начисление, возврат, сторно штрафа) проходит всегда.
 *  Транзакцию НЕ открывает: вызывающий модуль передаёт tx своей команды. */
export function post(tx: Tx, input: PostingInput): Promise<PostingResult>;

/** Заблокировать счета до проводки (FOR UPDATE, порядок id). Нужна модулю, который до post() читает
 *  связанные данные под той же блокировкой (партии баллов, остаток сертификата). Возвращает счета. */
export function lockAccounts(tx: Tx, accountIds: string[]): Promise<Account[]>;

/** Баллы за минуты (07 §4.2): минуты ÷ 6, вниз до 0,5 балла = до 50 сотых.
 *  pointsForMinutes(15) = 250, (20) = 300, (30) = 500, (45) = 750, (50) = 800. Целочисленно, без float:
 *  Math.floor(minutes * 100 / 6 / 50) * 50 → через целые: Math.floor((minutes * 100) / 300) * 50. */
export function pointsForMinutes(minutes: number): Minor;
// Расходится с Q-41 по умолчанию («храним точно, не округляем»): принято 07 §4.2 «с точностью 0,5 балла» (ревью п.7).
// Хранение – сотые, поэтому смена правила округления позже не требует миграции. Q-41 в voprosy поправит оркестратор.

/** Сторно одной записи: та же сумма с обратным знаком, тот же счёт, reversal_of = id.
 *  reason обязателен. Повторное сторно → ALREADY_REVERSED; сторно сторно → CANNOT_REVERSE_REVERSAL. */
export function reverse(tx: Tx, input: { entryId: number; reason: string; idempotencyKey: string;
  author: PostingInput['author']; occurredAt: Date }): Promise<PostingResult>;

/** Баланс из кэша и (опционально) пересчёт суммой для сверки 16 §14. */
export function getBalance(db: Db, accountId: string): Promise<Minor>;
export function verifyBalance(db: Db, accountId: string): Promise<{ cached: Minor; computed: Minor; ok: boolean }>;

/** История счёта: порядок (occurred_at, id) – стабильный при совпадении времени (06 §10). Курсорная пагинация. */
export function listEntries(db: Db, accountId: string, page: { after?: { occurredAt: Date; id: number }; limit: number }): Promise<PostedEntry[]>;
```

## Правила

1. Таблица `ledger_entries` только на вставку (роль `yu_app`), правки нет – только `reverse` или новая корректирующая операция (06 §4.4, 16 §2.7).
2. Перевод между кассами (06 §4.3) – одна проводка из двух записей: `cash.transfer_out` (−) и `cash.transfer_in` (+).
3. Одна проводка – одна единица: смешивать `RUB_KOP` и `POINT_CENTI` в одной проводке нельзя (`UNIT_MISMATCH`).
4. Ключ идемпотентности проводки – **детерминированный от бизнес-факта**, а не от HTTP-запроса: начисление за посещение – `loyalty-accrual:<visitId>:<paymentId>` (K15 §4: с платежом – после полного возврата и новой оплаты деньгами нужно новое начисление), штраф – `loyalty-penalty:<noShowId>` (07 §8.4 «один штраф на бронь»), оплата сеанса – `payment:<sessionId>:<attempt>:<lineNo>`, возврат – `refund:<paymentId>:<lineNo>:<n>` (K10 §9: с попыткой – иначе повторная оплата после полного возврата упрётся в `UNIQUE`), продажа сертификата – `certificate-sale:<certificateId>`, сгорание – `certificate-expire:<certificateId>` (K16), ручная операция кассы – `finance-op:<idempotencyKey>` (K17 §4). Повторная доставка события не создаст вторую запись даже через месяц (`UNIQUE` навсегда).
5. Партии баллов, резервы, срок действия – таблицы `loyalty` со ссылкой на `ledger_entries.id`; ledger о них не знает.
6. Аудит: модуль-потребитель пишет `ledger.posted` / `ledger.reversed` (K2) в той же транзакции.
7. **Предел счёта – только для списаний** (правка Э2 по ревью 02.11, миграция `0201_ledger_limit.sql`, шаг S2-07): триггер `ledger_entries_20_apply_balance` проверяет `min_balance` только при `NEW.amount < 0`. Баланс ниже предела бывает лишь после записи с `limit_override` (Владелец, `loyalty.adjust_below_limit`); при нём начисление, возврат и сторно штрафа должны проходить, а новое списание без `allowBelowLimit` – по-прежнему `BALANCE_BELOW_LIMIT`.

## Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `BALANCE_BELOW_LIMIT` | 409 | списание (`amount < 0`) увело бы баланс ниже `min_balance` без `allowBelowLimit` (`details: { accountKind, balance, minBalance, attempted }`) |
| `LIMIT_OVERRIDE_NOT_ALLOWED` | 403 | `allowBelowLimit` от не-сотрудника или без причины |
| `ALREADY_REVERSED` | 409 | у записи уже есть сторно |
| `CANNOT_REVERSE_REVERSAL` | 409 | попытка сторнировать сторно |
| `UNIT_MISMATCH` | 422 | разные единицы в проводке |
| `ACCOUNT_CLOSED` | 409 | счёт `closed` |
| `INVALID_AMOUNT` | 422 | 0, дробное, вне `Number.MAX_SAFE_INTEGER` |
| `IDEMPOTENCY_KEY_REUSED` | 409 | тот же ключ, другие записи |

## Проверка (S0-07)

- property-based (fast-check): для случайной последовательности проводок и сторно `cached == Σ amount`.
- сторно → новая запись, исходная не изменилась; второе сторно → `ALREADY_REVERSED` (ловит `UNIQUE`, а не только код).
- 20 параллельных `post` с одним ключом → одна проводка, 19 `replayed=true`.
- два параллельных списания с сертификата, каждое укладывается в остаток, вместе – нет → одно `BALANCE_BELOW_LIMIT`.
- `UPDATE ledger_entries` и `UPDATE ledger_accounts SET balance` от `yu_app` → ошибка прав (`42501`).
- `pointsForMinutes`: 15 → 250, 20 → 300 (3,0 балла), 30 → 500, 45 → 750, 60 → 1000.
- `allowBelowLimit` с причиной от сотрудника → баланс ниже границы, `limit_override=true`, запись аудита.
- S2-07 (0201): при балансе −60 (ниже предела −50 после корректировки) проходят +5, возврат и сторно штрафа; списание −1 без `allowBelowLimit` – `BALANCE_BELOW_LIMIT`; вверх/вниз/вверх.
