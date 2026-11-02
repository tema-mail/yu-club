# K16. Сертификаты: продажа, погашение, срок, остаток

Статус: контракт Э2 (02.11.2026). Модуль-владелец: `certificates` (`apps/api/src/modules/certificates/*`). Таблицы: `certificates`, `certificate_redemptions`, `certificate_holder_history` (миграция `0204_certificates.sql`; FK между сертификатами и платежами добавляет `0205_payments.sql`, §10).
Основа: 08 §2–§15; 06 §4.1, §12; 16 §7.4, §8.1–8.3; 20 §4.5, §4.7, §7.2, TC-08; 18 §6.2 п.6–8, §6.3; K3, K10, K17.

Пометки: «по умолчанию, ждёт заказчика (Q-xx)» – умолчание плана; «решение» – вывод архитектора.

## 1. Сертификат и его остаток

```ts
export type CertificateStatus = 'active' | 'partially_used' | 'used_up' | 'expired' | 'cancelled' | 'needs_review';

export interface CertificateDto {
  id: string;
  number: string;              // 'YC-7K2M-9QXD' – генерирует система, UNIQUE по сети (08 §4.2)
  nominalKop: number;          // > 0 (08 §4.5)
  balanceKop: number;          // остаток = баланс счёта K3 'certificate' (08 §3.3)
  soldAt: string; saleBranchId: string; saleMethod: 'cash' | 'card' | 'transfer'; soldBy: string;
  expiresOn: string;           // LocalDate последнего дня действия по зоне филиала продажи
  expiresAt: string;           // начало следующих суток в той же зоне, UTC – граница проверки
  status: CertificateStatus;   // вычисляется (08 §8), руками не редактируется
  buyerClientId: string | null; recipientClientId: string | null;
  comment: string | null; rowVersion: number;
}
```

- **Остаток** – счёт K3 `kind='certificate'`, `ownerType='certificate'`, `minBalance = 0`, `branchId` = филиал продажи. `balance = номинал − Σ погашений − сгорание ± корректировки` (08 §3.3, 16 §14) – это и есть сумма записей счёта; прямой правки нет (08 §9.3, у `yu_app` нет права писать баланс, K3).
- **Статус вычисляется** (08 §8) по порядку: `cancelled` (продажа отменена) → `needs_review` (флаг с причиной) → `expired` (`now ≥ expiresAt`) → `used_up` (остаток 0) → `partially_used` (остаток < номинала) → `active`. «Черновика» в Э2 нет (решение): команда продажи – это и есть факт получения денег (08 §4.4), учёт ручной (06 §9), отдельного шага «оплата подтверждена» нет.

## 2. Продажа (08 §4, §12.1; 06 §4.1, §12)

```ts
/** Право certificate.sell. Одна транзакция: номер и код → certificates → ensureAccount(certificate, min 0) →
 *  одна проводка K3 из двух записей (одна единица RUB_KOP):
 *    cash.income +номинал на место денег филиала продажи по способу (K17 §2), операция K17 источник 'certificate_sale';
 *    certificate.issue +номинал на счёт сертификата.
 *  Ключ K3: `certificate-sale:<certificateId>`; HTTP – Idempotency-Key. Аудит certificate.sold. */
export function sellCertificate(tx: Tx, ctx: AccessContext, input: {
  branchId: string; nominalKop: number; method: 'cash' | 'card' | 'transfer';
  buyerClientId?: string; recipientClientId?: string; comment?: string;
}, meta: AuditRequestMeta, clock?: Clock): Promise<{ certificate: CertificateDto; pin: string }>;   // pin – только в этом ответе
```

- Только за деньги (08 §2.1–2.2, 07 §7.3): баллов в списке способов нет – запрет выполняется типом.
- Способы продажи: `cash | card | transfer` – по умолчанию, ждёт заказчика (Q-26: 08 §2.1 называет только «наличные или безнал», перевод добавлен по умолчанию плана); список – настройка `certificate.sale_methods`.
- Номинал – рубли, > 0; пределы `certificate.nominal_min_kop` / `max_kop` (K7, `null` – без пределов, 08 §4.5).
- Покупатель и получатель необязательны (08 §2 п.5, §4.3).
- Деньги приходят **один раз** в филиал продажи как отдельный источник «продажа сертификатов» (06 §11.2), не доход сеанса (08 §12.1). Погашение в любом филиале сети денег не создаёт (TC-08). Чья выручка при погашении в другом филиале – по умолчанию, ждёт заказчика (Q-25): деньги остаются в филиале продажи, взаиморасчёт – отчёт Э4 без проводок.
- **Предупреждение при продаже** (план, раздел 9, риск 6): пока флаг `payment.certificate_topup_enabled = false` (K10 §2), форма продажи показывает «если остаток меньше цены сеанса, оплатить им сеанс нельзя; остаток сгорает через 6 месяцев». Текст оферты о сгорании – Q-86 (08 §2 п.10).

## 3. Номер и код (решение по Q-26)

- Сертификат **на предъявителя** – по умолчанию, ждёт заказчика (Q-26). Погашение – по номеру **и** 4-значному коду.
- Номер: `YC-` + 8 символов Crockford Base32 из криптографического генератора (40 бит), при совпадении – новая попытка; `UNIQUE (number)`. Ручной ввод номера невозможен (08 §4.2).
- Код: 4 цифры из криптографического генератора, в базе – `HMAC-SHA256(id ‖ ':' ‖ pin, CERT_PEPPER)` – хэш привязан к сертификату (правка по ревью 03.11: одинаковые коды разных сертификатов не дают одинаковых хэшей); показывается и печатается **один раз** в ответе продажи (08 §11.3); в логи и аудит не попадает (04 §11.2).
- Перебор: 5 неверных кодов по сертификату → блок ввода кода на 15 минут (`pin_failed_count`, `pin_locked_until`); ответы на «нет такого номера» и «неверный код» одинаковы – `CERTIFICATE_NOT_FOUND` (не раскрываем существование номера). Перевыпуск кода – право `certificate.correct` (Владелец), `POST /certificates/{id}/pin` с `{ rowVersion, reason }`: новый код показывается один раз (ответ под `Idempotency-Key` сохраняется без кода), старый перестаёт работать, счётчик и блок попыток сбрасываются, аудит `certificate.pin_reissued` без кода. Длина кода и число попыток – по умолчанию, ждёт заказчика (Q-105: 4 цифры, 5 попыток, 15 минут).
- **Неудачная попытка не откатывается** (правка по ревью 02.11): проверка кода идёт в отдельной короткой транзакции до основной команды – `UPDATE … SET pin_failed_count = pin_failed_count + 1` фиксируется, затем ответ `CERTIFICATE_NOT_FOUND`. Если считать попытку внутри транзакции оплаты, откат после отказа съест счётчик и перебор станет бесконечным. Успех обнуляет счётчик в основной транзакции.
- **Код не попадает в `idempotency_keys`** (правка по ревью 02.11, шаг S2-08): ответ продажи сохраняется без `pin` (`redact`); повтор с тем же ключом возвращает тот же сертификат с `pin: null, pinShownOnce: true` – «код показан один раз» (08 §11.3). В `request_hash` тела оплаты и `POST /certificates/check` вместо кода идёт `HMAC-SHA256(pin, CERT_PEPPER)` (сертификат в запросе ещё не известен; в базе – хэш с id, см. выше) – 4 цифры по чистому SHA-256 подбираются мгновенно.

## 4. Срок 6 месяцев (08 §5, Q-27)

```ts
/** LocalDate продажи по зоне филиала продажи + 6 календарных месяцев; дня нет в месяце → последний день месяца
 *  (31.08 → 28/29.02; 31.03 → 30.09). Действует до конца этой даты по зоне филиала продажи (08 §5.1, Q-27 по умолчанию). */
export function expiryOf(soldAt: Date, saleBranchTz: TimeZone): { expiresOn: LocalDate; expiresAt: Date };
```

- Проверка срока при погашении – по времени, а не по статусу: `now < expiresAt` (задача сгорания могла ещё не пройти).
- **Сгорание** (08 §5.2, §12.3, 16 §8.3): задача `certificates:expire` раз в 5 минут берёт `expires_at ≤ now AND balance > 0 AND не сгорал` → под блокировкой счёта `certificate.expire` −остаток (автор `system`, ключ `certificate-expire:<id>`), аудит `certificate.expired`. Сгорание – не денежное поступление и не доход (08 §12.3): касса K17 его не видит, сводка показывает отдельной строкой «сгорело».
- Продления нет (08 §5.3); сертификат и история не удаляются.

## 5. Погашение – способ оплаты `certificate` (K10 §5; 08 §6)

```ts
/** Обработчик способа certificate для K10. Проверки 08 §6.3 в порядке:
 *  0) код проверен заранее отдельной транзакцией (§3); здесь – lockAccounts(счёт сертификата), затем ПЕРЕЧИТАТЬ строку сертификата и баланс
 *     под блокировкой (решение по ревью 02.11: блокировка → перечитать → проверить; что видели экран и /check – только подсказка);
 *  1) номер + код (§3) → иначе CERTIFICATE_NOT_FOUND; 2) не cancelled / needs_review → CERTIFICATE_NOT_ACTIVE;
 *  3) now < expiresAt → иначе CERTIFICATE_EXPIRED; 4) остаток > 0 → CERTIFICATE_NOT_ACTIVE (used_up);
 *  5) сумма > 0; 6) сумма ≤ остатка, иначе CERTIFICATE_INSUFFICIENT (mode 'exact') или списать весь остаток (mode 'drain', K10 §2);
 *  7) конкурирующая операция – блокировка из п.0 + триггер K3 min 0: два параллельных погашения не уводят в минус (16 §8.2);
 *     если триггер всё же ответил BALANCE_BELOW_LIMIT – наружу CERTIFICATE_INSUFFICIENT (код K3 наружу не отдаём);
 *  8) «сеанс не оплачен другим способом» – гарантирует K10 (живой платёж один).
 *  Запись: certificate.redeem −сумма, branch_id = филиал сеанса, ref booking; certificate_redemptions(active). */
export const certificatePaymentMethod: PaymentMethodHandler;   // K10 §5
```

- Бронь остаток не уменьшает (08 §6.4); погашение – только при оплате сеанса в клубе (K10 §1).
- Погашение не создаёт поступления в кассу (06 §12, 08 §12.2, TC-08).
- Только игровые сеансы – по умолчанию, ждёт заказчика (Q-26): обработчик вызывается только из K10.

## 6. Возврат погашения, отмена продажи, корректировка (08 §9)

- **Возврат погашения** – часть возврата платежа K10 (`refundPayment`, право `finance.refund`), только целиком: `now < expiresAt` и не `cancelled` → K3 `reverse` записи погашения, строка `returned`; иначе `not_restored` – остаток не восстанавливается, срок не продлевается (08 §9.2). Денежный возврат вместо восстановления – отдельный ручной возврат кассы K17 по решению сотрудника (08 §9.2 последний абзац).
- **Отмена продажи** (`certificate.cancel`) – только если погашений не было никогда и срок не прошёл (08 §9.1). Одна транзакция: K3 `reverse` записи `certificate.issue`; если деньги возвращаются – возврат кассы K17 (`cash.refund` на место денег продажи) со ссылкой на операцию продажи; статус `cancelled`; причина обязательна. Использованный сертификат простой отменой не отменяется → `CERTIFICATE_USED`, путь – корректировка Владельцем.
- **Корректировка остатка** (`certificate.correct`, Владелец): `certificate.correction ±`, причина и ссылка на событие обязательны; остаток после корректировки ≤ номинала (08 §9.3 «не создаёт новый номинал») → иначе `CORRECTION_EXCEEDS_NOMINAL`.
- **«Требует проверки»** (`certificate.review`, Владелец и Директор): флаг с причиной включает и снимает; пока включён – погашение запрещено (08 §8).

## 7. Получатель (08 §7)

- `linkRecipient(tx, ctx, { certificateId, clientId, rowVersion })`, право `certificate.link` (все роли, сертификат продан в их зоне или предъявлен в их филиале): привязка или смена получателя, строка в `certificate_holder_history` (старый, новый, дата, автор). Именным сертификат это не делает (Q-26).
- Предъявлен в филиале сотрудника (правка по ревью 03.11): id сертификата чужого филиала сотрудник не знает – `linkRecipientByCode(tx, pool, ctx, { branchId, number, pin, clientId })`, `POST /certificates/recipient-by-code`; право `certificate.link` в филиале предъявления, код – `verifyCertificatePin` отдельной транзакцией (счётчик и блок §3). По id (№35) – только в зоне филиала продажи.
- Одна сумма не гасится двумя клиентами одновременно – блокировка счёта (§5 п.7).

## 8. ЛК «Мои сертификаты» (08 §10)

Видны сертификаты, где клиент – получатель, или покупатель при пустом получателе (решение по 08 §10 «привязанные к профилю»).

| Метод и путь | Ответ |
|---|---|
| `GET /api/public/v1/me/certificates` | `200 { items: [{ number, nominalKop, balanceKop, soldAt, expiresOn, status, burnedKop \| null }] }` – для истёкшего показывается сгоревшая сумма; кода нет |
| `GET /api/public/v1/me/certificates/{number}/history` | `200 { items: [{ at, type: 'sale'\|'redeem'\|'return'\|'expire'\|'correction', amountKop, balanceAfterKop, branchName }] }` |

## 9. Права (K1, шаг S2-01)

| Действие | Роли | Основание |
|---|---|---|
| `certificate.view` | Владелец, Директор, Администратор | 08 §15 «просмотр сведений для проверки и использования» |
| `certificate.sell` | Владелец, Директор | 08 §4.1 «базово владелец и директор»; Администратор – только по отдельному праву, механизм прав с датами – Э3 (N-06); вопрос в 6.4.3 плана |
| `certificate.cancel` | Владелец, Директор | 08 §15 |
| `certificate.correct` | Владелец | 08 §15 «корректировки» |
| `certificate.review` | Владелец, Директор | 08 §8 |
| `certificate.link` | Владелец, Директор, Администратор | 08 §7 |
| погашение | через `finance.payment.record` (K10 §8) | R-14 по умолчанию: Администратор проводит оплаты сеансов |

## 10. Данные (`0204_certificates.sql`)

- `certificates` (`id`, `number UNIQUE`, `pin_hash`, `pin_failed_count`, `pin_locked_until`, `nominal_kop > 0`, `sale_branch_id → branches`, `sale_method`, `sale_operation_id → finance_operations`, `ledger_account_id → ledger_accounts UNIQUE`, `sold_at`, `sold_by → staff`, `expires_on`, `expires_at`, `expired_entry_id`, `cancelled_at`, `cancel_reason`, `review_reason`, `buyer_client_id → clients`, `recipient_client_id → clients`, `comment`, `row_version`). У `yu_app` нет UPDATE на `nominal_kop`, `number`, `sold_at`, `expires_*`, `sale_*` (08 §15: «не может менять номинал, срок») – как у `tariffs` (0107).
- `certificate_redemptions` (`certificate_id`, `booking_id → bookings`, `branch_id`, `client_id`, `amount_kop`, `ledger_entry_id`, `status: active | returned | not_restored`, `return_entry_id`, автор, время). Ссылка на платёж – `payment_id uuid` без FK: `payments` появляется в `0205`, а отложенный FK `certificate_redemptions.payment_id → payments` и `payment_lines.certificate_id → certificates` добавляет `0205_payments.sql` (правило model-dannyh §1 «FK вперёд – в миграции цели»).
- `certificate_holder_history` – только вставка (`journal`).

## 11. API CRM (дополняет K11)

| # | Метод и путь | Право | Успех |
|---|---|---|---|
| 29 | `GET /certificates?q=&status=&expiring=7\|30\|60&branchId=&cursor=` | `certificate.view` | `200 { items, nextCursor }` – поиск по номеру и клиенту; «истекающие» (08 §11.1, §13.4) |
| 30 | `GET /certificates/{id}` | `certificate.view` | `200 CertificateDto + { redemptions[], history[], timeline }` (08 §11.2) |
| 31 | `POST /branches/{branchId}/certificates` | `certificate.sell` | `201 { certificate, pin }` + `Idempotency-Key` |
| 32 | `POST /certificates/{id}/cancel` | `certificate.cancel` | `200`; `{ rowVersion, reason, refundMoney: boolean }` |
| 33 | `POST /certificates/{id}/correct` | `certificate.correct` | `201`; `{ rowVersion, deltaKop, reason, ref? }` |
| 34 | `POST /certificates/{id}/review` | `certificate.review` | `200`; `{ rowVersion, on: boolean, reason }` |
| 35 | `POST /certificates/{id}/recipient` | `certificate.link` | `200`; `{ rowVersion, clientId \| null }` |
| 36 | `POST /certificates/check` | `finance.payment.record` | `200 { number, status, balanceKop, expiresOn }` – проверка по номеру и коду перед оплатой; тот же лимит попыток (§3) |

## 12. Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `CERTIFICATE_NOT_FOUND` | 404 | нет номера или неверный код (одно сообщение) |
| `CERTIFICATE_PIN_LOCKED` | 429 | 5 неверных кодов, блок 15 минут |
| `CERTIFICATE_EXPIRED` | 409 | `now ≥ expiresAt` |
| `CERTIFICATE_NOT_ACTIVE` | 409 | `cancelled`, `needs_review`, `used_up` |
| `CERTIFICATE_INSUFFICIENT` | 409 | остаток меньше суммы (`details.balanceKop`) |
| `CERTIFICATE_USED` | 409 | отмена продажи использованного |
| `CORRECTION_EXCEEDS_NOMINAL` | 422 | остаток после корректировки > номинала |
| `NOMINAL_OUT_OF_RANGE` | 422 | номинал ≤ 0 или вне пределов настройки |

## 13. Проверка

- TC-08: продажа 5 000 ₽ → одна операция кассы +5 000 в филиале продажи; погашения 1 500 и 2 000 в другом филиале → остаток 1 500, касса без новых поступлений; сгорание → `certificate.expire` −1 500, касса без изменений (06 §12).
- Погашение сверх остатка → `CERTIFICATE_INSUFFICIENT`; истёкшего (до прохода задачи) → `CERTIFICATE_EXPIRED` (18 §6.3).
- Два параллельных погашения, вместе больше остатка → одно проходит, второе `CERTIFICATE_INSUFFICIENT`; остаток ≥ 0 (16 §8.2).
- `expiryOf`: 31.08 → 28.02 (29.02 в високосный), 31.03 → 30.09, 15.01 → 15.07; граница – полночь по зоне филиала продажи, тест с чужим `TZ` машины.
- Возврат погашения до срока → остаток восстановлен; после срока → `not_restored`, остаток 0.
- Код: 5 неверных → `CERTIFICATE_PIN_LOCKED`, счётчик растёт и при откате основной транзакции; код не встречается в логах, аудите и `idempotency_keys` (`response_body`, `request_hash`); повтор продажи – без кода.
- `UPDATE certificates SET nominal_kop` от `yu_app` → `42501`.
