# K3. Журнал операций со сторно

Модуль: `apps/api/src/core/ledger.ts`. Таблицы: `ledger_accounts`, `ledger_entries` (model-dannyh 0004). Шаг: S0-07. Потребители: `finance` (П8), `loyalty`, `certificates` (Э2), `shifts` (П9a), `events` (П9c).
Основа: ADR 0004 §1; 06 §3–4, §10; 07 §3; 08 §3.3; 16 §2.7, §14; 17 §9.

## Типы

```ts
export type AccountKind = 'cash_branch' | 'loyalty_client' | 'certificate' | 'staff_payroll';
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
  | 'payroll.accrual' | 'payroll.penalty' | 'payroll.payout' | 'payroll.correction'
  // общее
  | 'reversal';

export interface EntryInput {
  account: AccountRef;
  amount: Minor;                       // со знаком: + приход на счёт, − расход со счёта
  type: Exclude<EntryType, 'reversal'>;
  basis?: string;                      // основание/комментарий; обязателен для cash.expense, *.correction, loyalty.manual
  branchId: string | null;             // филиал ОПЕРАЦИИ (для счёта баллов – филиал визита)
  ref?: { type: 'booking' | 'visit' | 'no_show' | 'event' | 'repair' | 'certificate' | 'shift' | 'goods_order'; id: string };
  refs?: Record<string, string>;       // доп. ссылки
  occurredAt: Date;                    // дата факта
}

export interface PostingInput {
  entries: EntryInput[];               // 1..N; все в одной транзакции, общий posting_id
  idempotencyKey: string;              // ключ НАМЕРЕНИЯ, напр. 'visit-accrual:<visitId>'; у записи i → `${key}#${i}`
  author: { type: 'staff' | 'client' | 'system'; id: string | null };
}

export interface PostedEntry {
  id: number; postingId: string; accountId: string; amount: Minor; balanceAfter: Minor;
  type: EntryType; reversalOf: number | null; occurredAt: Date; recordedAt: Date;
}

export interface PostingResult { postingId: string; entries: PostedEntry[]; replayed: boolean }
```

## Функции

```ts
/** Найти или создать счёт (UNIQUE kind+owner). minBalance задаётся при создании:
 *  certificate → 0, loyalty_client → −5000 (−50 баллов, 07 §3.1), cash_branch → по настройке Э2, staff_payroll → NULL. */
export function ensureAccount(tx: Tx, ref: AccountRef, opts: { unit: Unit; branchId: string | null; minBalance: Minor | null }): Promise<Account>;

/** Проводка. Внутри:
 *  1) SELECT ... FROM ledger_accounts WHERE id IN (...) ORDER BY id FOR UPDATE   – порядок id против взаимоблокировок;
 *  2) если запись с idempotency_key `${key}#0` уже есть → вернуть сохранённые записи, replayed=true (сравнить
 *     account/amount/type; расхождение → IDEMPOTENCY_KEY_REUSED);
 *  3) INSERT записей с balance_after; UPDATE ledger_accounts SET balance = balance + Σ;
 *  4) CHECK balance >= min_balance нарушен → BALANCE_BELOW_LIMIT (ошибка 23514 переводится).
 *  Транзакцию НЕ открывает: вызывающий модуль передаёт tx своей команды. */
export function post(tx: Tx, input: PostingInput): Promise<PostingResult>;

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
4. Ключ идемпотентности проводки – **детерминированный от бизнес-факта**, а не от HTTP-запроса: начисление за посещение – `loyalty-accrual:<visitId>`, штраф – `loyalty-penalty:<noShowId>` (07 §8.4 «один штраф на бронь»), оплата сеанса – `payment:<sessionId>` (K10). Повторная доставка события не создаст вторую запись даже через месяц (`UNIQUE` навсегда).
5. Партии баллов, резервы, срок действия – таблицы `loyalty` со ссылкой на `ledger_entries.id`; ledger о них не знает.
6. Аудит: модуль-потребитель пишет `ledger.posted` / `ledger.reversed` (K2) в той же транзакции.

## Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `BALANCE_BELOW_LIMIT` | 409 | баланс ушёл бы ниже `min_balance` (`details: { accountKind, balance, minBalance, attempted }`) |
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
- `UPDATE ledger_entries` от `yu_app` → ошибка прав.
