# K9. Клиент, вход по коду, сессия ЛК, бронь без профиля

Модуль: `clients` (`apps/api/src/modules/clients/*`, S1-11, S1-12), ЛК-маршруты (S1-17), push-подписка (S1-15). Таблицы: `clients`, `client_consents`, `client_notification_prefs`, `client_otp_challenges`, `client_sessions`, `push_subscriptions` (model-dannyh 0105, 0106, 0111). Схемы HTTP – `packages/contracts/src/clients.ts`.
Потребители: П4 (`client_id` в брони, бронь администратором), П5 (ЛК), П6 (вход в потоке записи), П7 (настройки и подписки).
Основа: 03 §3–6, §8, §10, §14–15, §17; 09 §5; 04 §8.3; 17 §7.4–7.5, §8.2; R-18, Q-09, Q-30.

## Публичные функции модуля (`modules/clients/index.ts`)

```ts
export type ClientStatus = 'guest' | 'active' | 'restricted' | 'blocked' | 'deletion_requested' | 'anonymized' | 'merged'; // merged – 0450, «Слияние»

export interface ClientRef { id: string; status: ClientStatus; firstName: string | null; lastName: string | null; phoneMasked: string }

/** '+7 (913) 123-45-67', '8913…', '9131234567' → '+79131234567'. РФ по умолчанию (решение). Неверный → VALIDATION_FAILED. */
export function normalizePhone(input: string): string;
/** '+7 ••• ••• ••-67' (17 §8.2). */
export function maskPhone(e164: string): string;

/** Бронь без профиля (01 §10.2, Q-09): найти по телефону или создать карточку 'guest' (неподтверждённую).
 *  Существующая карточка не переписывается; имя заполняется, только если было пустым. Аудит client.created. */
export function findOrCreateGuest(tx: Tx, input: { phone: string; firstName: string; lastName?: string }, meta: AuditRequestMeta): Promise<ClientRef>;

/** Можно ли клиенту бронировать (K5 hold/attach/confirm, S1-13). blocked/restricted/deletion_requested/anonymized → CLIENT_RESTRICTED.
 *  Э2 (S2-33): после проверки статуса вызываются зарегистрированные ворота (registerBookingGate) – loyalty проверяет −50
 *  и бросает LOYALTY_LIMIT_REACHED (K15 §8). Необязательный opts – совместимо с вызовами Э1. */
export function assertCanBook(tx: Tx, clientId: string, at: Date,
  opts?: { override?: { loyaltyLimit?: { reason: string; staffId: string } } }): Promise<void>;

/** Э2 (S2-33): ворота записи другого модуля; регистрирует server.ts при старте (как провайдеры ADR 0002).
 *  Без ворот поведение Э1 не меняется. Ворота сами решают, принять ли override (loyalty – право loyalty.book_below_limit проверяет маршрут CRM). */
export interface BookingGate { name: string; check(tx: Tx, input: { clientId: string; at: Date; override?: { reason: string; staffId: string } }): Promise<void> }
export function registerBookingGate(gate: BookingGate): void;

/** Для уведомлений (П7): настройки и наличие канала. */
export function getNotificationPrefs(db: Db | Tx, clientId: string): Promise<{ remindersEnabled: boolean; marketingEnabled: boolean }>;
export function listActivePushSubscriptions(db: Db | Tx, clientId: string): Promise<Array<{ id: string; endpoint: string; p256dh: string; auth: string }>>;
export function revokePushSubscription(tx: Tx, id: string, reason: 'gone' | 'unsubscribed' | 'logout'): Promise<void>;

/** Сессия по куке (вызывается хуком Fastify на маршрутах ЛК и K5 confirm/attach/cancel). */
export function resolveClientSession(db: Db, rawToken: string, clock: Clock): Promise<{ clientId: string; sessionId: string } | null>;

/** Поиск в CRM (03 §14): по телефону (точно и по последним 4 цифрам), ФИО, email, id. scopeFilter K1 'client.view.basic':
 *  Администратор видит клиентов, у которых есть бронь в его филиалах, ИЛИ точное совпадение телефона (для новой записи, 04 §8.3, решение). */
export function searchClients(db: Db, ctx: AccessContext, q: { text: string; branchId?: string; status?: ClientStatus[] }, page: Cursor): Promise<Page<ClientRef & { lastVisitAt: Date | null; lastBranchId: string | null }>>;
```

## Вход по коду (03 §5–6, R-18 по умолчанию: телефон + SMS)

```ts
/** Адаптер канала (ADR 0001). Реализации: 'log' – пишет код в лог стенда (только APP_ENV != prod); боевая – по выбору заказчика. */
export interface SmsSender {
  send(input: { phoneE164: string; text: string; idempotencyKey: string }): Promise<
    { status: 'accepted'; providerMessageId: string } | { status: 'rejected'; reason: string } | { status: 'unknown' }>;
}
```

| # | Маршрут (`/api/public/v1`) | Тело | Ответ | Правила |
|---|---|---|---|---|
| 1 | `POST /auth/otp/request` (`Idempotency-Key`) | `{ phone: string, purpose: 'login' }` | `202 { challengeId, resendAfterSec, expiresInSec }` – **всегда одинаковый**, есть аккаунт или нет (03 §5.2) | лимиты K7: не чаще `otp_resend_cooldown_seconds`, не больше `otp_max_per_phone_per_hour`, иначе `429 OTP_RATE_LIMITED` с `resendAfterSec`; новый код аннулирует прежний (`superseded_at`); код 6 цифр `crypto.randomInt`; в базе только HMAC; текст SMS без имени клиента |
| 2 | `POST /auth/otp/verify` | `{ challengeId, code, consents?: { pdProcessing: boolean, marketing?: boolean }, documentVersion?: string }` | `200 { client: MeDto, isNew: boolean }` + `Set-Cookie: yu_client` | неверный код → `401 OTP_INVALID` (`details.attemptsLeft`); попытки кончились / истёк → `410 OTP_EXPIRED`; карточки нет → создаётся `active`; есть `guest` → становится `active`, `registered_at`, `phone_verified_at` (дубля нет, Q-09); новый клиент без `consents.pdProcessing = true` → `422 CONSENT_REQUIRED` (галочка пустая по умолчанию, N-01) и код не гасится |
| 3 | `POST /auth/logout` | – | `204` + удаление куки | `revoke_reason='logout'`; push-подписки, сохранённые из этой сессии (`push_subscriptions.session_id`), – `logout` в той же транзакции; другие устройства клиента не трогаются |

Сессия: случайный токен 32 байта (base64url) в куке `yu_client` (HttpOnly, Secure, SameSite=Lax, срок `client.session_days`), в базе `token_hash = HMAC-SHA256(token, SESSION_PEPPER)`. Блокировка клиента завершает сессии (`blocked`). Код и токен не попадают в логи и аудит (03 §5.2, 04 §11.2) – тест S1-12 ищет код в выводе логов теста.

## ЛК (`/api/public/v1/me…`, только своя карточка – K1 `assertOwnClient`)

```ts
interface MeDto {
  id: string; phoneMasked: string; firstName: string | null; lastName: string | null; email: string | null; birthDate: string | null;
  status: 'active' | 'restricted';            // остальные статусы в ЛК не пускают (401 SESSION_REVOKED)
  notifications: { remindersEnabled: boolean; marketingEnabled: boolean };
  loyalty: null; certificates: null;          // остаются null и в Э2 (совместимость, решение S2-00): ЛК читает K15 GET /me/loyalty и K16 GET /me/certificates
}
interface MyBookingDto extends BookingDto {   // BookingDto – K5; без internal_comment (03 §8.3)
  cityName: string; roomName: string | null;
  visit: { arrivedAt: string } | null;
}
```

| Маршрут | Ответ / правила |
|---|---|
| `GET /me` | `200 MeDto` |
| `PATCH /me` `{ firstName?, lastName?, email?, birthDate? }` | `200 MeDto`; смена телефона в Э1 – только через CRM с аудитом (03 §7, решение); `row_version` не нужен – правит только владелец |
| `GET /me/bookings?tab=upcoming\|past\|cancelled&cursor=` | `200 { items: MyBookingDto[], nextCursor }`; `upcoming` – `start ≥ now` и не отменённые, по возрастанию; `past` – завершённые/неявки по убыванию; `cancelled` – отменённые (03 §8.3) |
| `GET /me/visits?cursor=` | `200 { items: [{ bookingId, number, branchName, resourceName, plannedStart, plannedEnd, arrivedAt, status: 'visited' }], nextCursor }` – только фактические посещения (03 §8.4) |
| `PUT /me/notification-settings` `{ remindersEnabled: boolean, marketingEnabled: boolean }` (`Idempotency-Key`) | `200 MeDto`; пишет `client_consents` (`reminders`, `marketing`) и `client_notification_prefs`; включение рекламы = согласие с `documentVersion` (09 §5.1); событие `client.notification_prefs_changed` (K4); сервисные сообщения не выключаются (09 §5.3) |
| `POST /me/push-subscriptions` `{ endpoint, keys: { p256dh, auth }, userAgent? }` | `201 { id }`; тот же `endpoint` у другого клиента → переносится на текущего (устройство сменило владельца, решение) |
| `DELETE /me/push-subscriptions/{id}` | `204` всегда (чужой, отозванный и несуществующий id неотличимы); своя активная – `revoke_reason='unsubscribed'` |
| `DELETE /me/push-subscriptions` `{ endpoint }` (в теле – адрес браузера не попадает в журнал запросов) | `204` всегда; гасит только свою активную подписку (`unsubscribed`) – для «выключить в этом браузере», без лишней записи (S1-15) |
| `GET /push/vapid-public-key` (без входа) | `200 { publicKey }` – открытый ключ VAPID (base64url) для `pushManager.subscribe`; ключей на сервере нет – `503 PUSH_NOT_CONFIGURED`. Endpoint подписки – только известных push-сервисов (`422 PUSH_ENDPOINT_NOT_ALLOWED`, защита от SSRF); повтор той же подписки – `200` с тем же `id` (S1-15) |

Курсор: base64url от `(start, id)` – стабильный порядок, `limit` 20 (17 §4.4).

**Версия документа согласия (Э4, K22 §7; внесено S4-00 04.11.2026; шаг S4-20).** `documentVersion` в записи `client_consents(kind='marketing', granted=true)` – это `document_version` **живой** версии страницы `advertising-consent` (K22 §7, чтение через `content/index.ts`), а не константа `MARKETING_DOCUMENT_VERSION` Э1. Касается входа (№2 `consents.marketing`), `PUT /me/notification-settings` и CRM-правки согласия: страница не опубликована → включить рекламу нельзя, `409 MARKETING_DOCUMENT_MISSING` (выключить – можно всегда). База держит то же самое: CHECK 0401 `kind = 'marketing' AND granted → document_version IS NOT NULL` (K21 §4). Старые согласия при новой редакции текста не переписываются и действуют до ответа Q-149. Отписка по ссылке (K21 §11 №206) пишет `granted=false` с `source='site'` – CHECK `source` 0105 не меняется. Сайт берёт живые версии для галочек из K5 №215.

**Обезличивание (Э4, K21 §15; 03 §13; внесено 10.11.2026, решения D4-60…D4-65).** `modules/clients/anonymize.ts`, маршрут CRM K11 №249 `POST /clients/{clientId}/anonymize` `{ reason: 'client_request' | 'retention_expired' }`, право `client.anonymize` (только Владелец).

```ts
/** Одна транзакция вызывающего. Обезличенная карточка – тот же ответ без записи (идемпотентно). */
export function anonymizeClient(tx: Tx, clientId: string, input: { reason: AnonymizeReason }, meta: AuditRequestMeta, clock?: Clock): Promise<AnonymizeResult>;
interface AnonymizeResult { clientId: string; status: 'anonymized'; alreadyAnonymized: boolean; affected: Record<string, number> }
/** Обработчик модуля-владельца таблиц с ПДн: blockers – живые записи (мешают), run – затирает. Обязательные – booking, events, notifications. */
export function registerClientAnonymizer(a: { name: string; blockers?(tx, clientId, now): Promise<number>; run(tx, clientId, now): Promise<number> }): void;
```

- `clients`: телефон, подтверждение телефона, имя, фамилия, почта, дата рождения, причина и срок статуса → NULL, статус `anonymized`; сессии отозваны (`blocked`, `user_agent = NULL`), push-подписки отозваны (`unsubscribed`, `endpoint` – заглушка), коды входа на телефон удалены, рассылки выключены, в `client_consents` – отказ от `pd_processing`, `marketing`, `reminders`.
- Обработчики: `notifications` – `anonymizeClientNotifications` (имена в `notifications.title/body`); `events` – K20 §14 (D4-64); `booking` – ПДн нет, только проверка живых броней.
- Живая бронь (впереди или `arrived`) или мероприятие в работе → `409 CLIENT_HAS_ACTIVE_RECORDS` (`details.blockers`). Брони, деньги, баллы, сертификаты, журналы только на вставку не меняются – связь по id.
- Аудит – `client.status_changed`, основание – код, без ПДн. Поиск CRM обезличенных не показывает без явного фильтра статуса; карточка – без ПДн.

**Слияние дублей (03 §11, §12, §15; техдолг 5.15; внесено 10.11.2026, решения D5-01…D5-09).** `modules/clients/merge.ts`, маршруты CRM K11 №253 `GET /clients/{clientId}/merge-preview?with={secondaryId}` и №254 `POST /clients/{clientId}/merge { secondaryId, reason }` (`Idempotency-Key`), право `client.merge` (Владелец по сети; делегированное – только клиенты с бронями в зоне права), миграция 0450.

```ts
export type ClientStatus = … | 'merged';                     // вторая карточка после слияния; ClientCard.mergedIntoId
export const MERGE_REASONS = ['same_person_confirmed', 'duplicate_registration', 'phone_changed'] as const;
export function mergePreview(db: Db, ctx: AccessContext, input: { primaryId: string; secondaryId: string }, links?, clock?): Promise<MergePreview>;
// MergePreview: { primary, secondary: ClientCard; modules: Record<модуль, { primary, secondary }>; conflicts: { field, primary, secondary }[];
//                 fills: { field, value }[]; statusAfter; canMerge; blocker: 'primary_must_be_registered' | null }
export function mergeClients(tx: Tx, ctx: AccessContext, input: { primaryId: string; secondaryId: string; reason: MergeReason }, meta, links?, clock?): Promise<MergeResult>;
// MergeResult: { mergeId, primaryId, secondaryId, status: 'merged', results: Record<модуль, Record<string, number>> }
/** Обработчик модуля-владельца таблиц со ссылкой на клиента (как registerClientAnonymizer). Обязательные – booking, finance, loyalty,
 *  certificates, events, notifications; без любого процедура не запускается. prelock – замки модуля до строк клиентов (D5-08). */
export function registerClientMerger(m: { name; prelock?(tx, from, to, now); preview(db, clientId, now); reassign(tx, from, to, ctx) }): void;
/** Действующая карточка по merged_into_id цепочкой; карточка и все объединённые в неё – для коррекций операций до слияния (D5-09). */
export function effectiveClientId(db: Db, clientId: string): Promise<string>;
export function clientIdsMergedInto(db: Db, clientId: string): Promise<string[]>;
```

- Одна транзакция. Замки (D5-08): счета баллов → удержания и брони второй → её мероприятия → строки обеих карточек `FOR UPDATE` (меньший id первым) → остальное. Обезличивание – тоже мероприятия клиента до строки клиента (`ClientAnonymizer.prelock`).
- Баллы после слияния (D5-09): операции до слияния корректируются на действующую карточку (`effectiveClientId`); команды баллов открывают счёт через `openClientAccount` – слияние, закоммиченное за время ожидания счёта, даёт `409 CLIENT_MERGED` (повтор); сторно – на счёте владельца записи K3 (не строки штрафа); возврат платежа баллами берёт счёт основной, затем счёт карточки списания – до сеанса, иначе `409 CLIENT_MERGED` (K10 §7).
- Модули: брони, удержания, время клиента, посещения, неявки, сеансы оплаты, мероприятия (заказчик, именинник), подарки, уведомления – `client_id` второй → основная, история и исходные id сохраняются; сертификаты – смена получателя с `certificate_holder_history` (D5-07); баллы – по правилу D5-02 (не складываются «в лоб»).
- Основная: свои значения, пустые заполняются из второй, блокировка второй переходит (D5-04). Вторая: `merged`, `merged_into_id`, ПДн очищены как при обезличивании (телефон свободен), сессии и push-подписки отозваны, коды входа удалены.
- Журнал `journal.client_merges` (только вставка; кто, когда, из какой в какую, основание, итоги модулей), аудит `client.merged` и `client.status_changed`, без ПДн.
- `GET /clients/{вторая}` – 200 с `status: 'merged'`, `mergedIntoId`, `full: null`; поиск по старым контактам её не находит, по id – находит. Бронь на `merged` – `CLIENT_RESTRICTED`; обезличивание `merged` – `409 CLIENT_MERGED`; корректировка баллов и выдача товара на `merged` – `409 CLIENT_MERGED`.

## Бронь администратором без профиля (S1-13)

Полный контракт маршрута – K11 №4; здесь – часть, которая касается клиента. Маршрут CRM `POST /api/crm/v1/branches/{branchId}/bookings` (`Idempotency-Key`, право `booking.create`):

```ts
type CrmCreateBooking = {
  resourceId: string; start: string; end: string;           // ISO UTC
  client: { clientId: string } | { phone: string; firstName: string; lastName?: string };   // второй вариант – findOrCreateGuest
  internalComment?: string;
};
```
Проходит те же проверки и ограничения базы, что K5 confirm (01 §10.2: «не обходит проверку доступности и пересечений»), без удержания (`hold_id = NULL`): `occupy` сразу с `source.type='booking'`. Ответ `201 BookingDto` + `client: ClientRef`. Пересечение клиента по телефону ловит `client_time` той же карточки (Q-09).

## Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `OTP_RATE_LIMITED` | 429 | слишком часто / много кодов на номер (`details.resendAfterSec`) |
| `OTP_INVALID` | 401 | неверный код (`details.attemptsLeft`) |
| `OTP_EXPIRED` | 410 | срок вышел, попытки кончились или код заменён |
| `CONSENT_REQUIRED` | 422 | новый клиент без согласия на обработку ПДн |
| `SMS_UNAVAILABLE` | 503 | провайдер ответил `rejected`/`unknown` при запросе кода; challenge сохраняется, повтор после `resendAfterSec` (без двойной отправки: `idempotencyKey = challengeId`) |
| `AUTH_REQUIRED`, `SESSION_REVOKED` | 401 | нет / отозвана сессия |
| `CLIENT_RESTRICTED` | 403 | `assertCanBook` (статус клиента) |
| `CLIENT_HAS_ACTIVE_RECORDS` | 409 | обезличивание: бронь впереди или мероприятие в работе (`details.blockers`) |
| `CLIENT_MERGED` | 409 | слияние, обезличивание, баллы: карточка уже объединена (`details.clientId`, `mergedIntoId`) |
| `CLIENT_NOT_MERGEABLE` | 409 | слияние: обезличенная, с запросом на удаление; основная – гость при зарегистрированной второй (`details.reason`) |
| `CLIENT_MERGE_CONFLICT` | 409 | слияние: пересечение времени броней, подарок в тот же год (`details.module`, `constraint`) или удержание занято (`reason: busy`) |
| `LOYALTY_LIMIT_REACHED` | 403 | Э2: ворота loyalty в `assertCanBook` – баланс ≤ −50 (K15 §8, код объявляет модуль loyalty) |
| `VALIDATION_FAILED` | 400 | телефон не разобран и т.п. |

## Проверка

S1-11: одна карточка на телефон (`UNIQUE` и `findOrCreateGuest` дважды параллельно → одна строка); поиск ≤ 2 с на 100 тыс. карточек; Администратор не находит клиента чужого филиала по ФИО. S1-12: ответ `/otp/request` одинаков для существующего и нового номера; новый код гасит старый; 6-я попытка → `OTP_EXPIRED`; повторная регистрация = вход; `guest` → `active` без второй карточки.
