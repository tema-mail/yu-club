# K21. Центр уведомлений в ЛК, ручные и рекламные рассылки, сегменты, частота, журнал

Статус: контракт Э4 (04.11.2026), ревью архитектуры 04.11 учтено (коммит 2aee09b), уточнения S4-00 – в K1, K2, K7 «Э4», `model-dannyh.md` «Этап 4» и `reshenia.md` D4-01…D4-11. Модуль-владелец: `notifications` (`apps/api/src/modules/notifications/*`: есть `index.ts`, `reminders.ts`, `sender.ts`, `handlers.ts`, `webpush.ts`, `routes.public.ts`; Э4 добавляет `inbox.ts`, `segments.ts`, `templates.ts`, `campaigns.ts`, `campaign-runner.ts`, `journal.ts`, `unsubscribe.ts`, `routes.crm.ts`). Таблицы: `notifications`, `push_subscriptions`, `journal.notification_deliveries` (0111, есть); Э4 – `notification_templates`, `notification_campaigns`, `notification_campaign_recipients` (0402), правка `notifications` (0401).
Основа: 09 §3–§5, §7–§12, §14, §16, §17; 03 §8.1 п.6, §10; 13 §11; 16 §2.6, §15.2–15.3, §15.5; 17 §4.3, §8; 18 §8.2 п.1–8, §8.4; K1, K2, K4, K7, K8, K9, K14; ADR 0002, 0004.

Пометки: «по умолчанию, ждёт заказчика (Q-xx)» – умолчание плана, меняется настройкой или правкой `MATRIX`; «решение» – вывод архитектора, не пункт ТЗ.

## 1. Что уже есть и что добавляет Э4

| Есть с Э1 (K14, S1-15, S1-16) | Добавляет Э4 |
|---|---|
| строки `notifications` для брони: подтверждение, отмена клубом, перенос, два напоминания; dispatch/send, повторы 1/5/15 мин, `Topic` = `dedupe_key`; настройки «Напоминания»/«Реклама» в ЛК (K9 `PUT /me/notification-settings`), журнал согласий `client_consents` | центр уведомлений в ЛК (09 §11); ручные сообщения одному клиенту и участникам записи (09 §7.2 п.1–2); рекламные и массовые рассылки по сегменту с предпросмотром аудитории и двойным подтверждением (09 §7.4–7.5); частота и тихие часы рекламы (Q-39); отписка из push и по ссылке; шаблоны (09 §15 эт.3 п.4); журнал отправок CRM с фильтрами и ручной повтор критичного сервисного (09 §10, §12.2, 16 §15.3); блок в карточке клиента (09 §12.3); сервисное об отмене мероприятия участникам – поздний шаг, ждёт K20 |

Не входит: SMS, email, мессенджеры (09 §2, §15 «последующие этапы»; Q-31); push сотрудникам и внутренние события CRM 13 §11 (вне Э4, отдельной оценкой); уведомления о баллах и сертификатах (Q-37) – модель готова (`push = false`, только центр), подписчиков нет, пока `loyalty` и `certificates` не публикуют событий (D2-09).

## 2. Категория и решение об отправке (09 §3–§4, приёмка 1–6, 13)

Категория назначается до постановки в очередь и не выводится из источника (система/сотрудник). После 0401 у строки три категории:

| `category` | Что | Настройка клиента | Согласие |
|---|---|---|---|
| `service` | подтверждение, изменение, отмена брони клубом; личное сервисное по записи; отмена мероприятия **участникам** (09 §3.4) | не отключается (09 §5.3) | не нужно |
| `reminder` | 2 напоминания (K14) | «Напоминания» | – |
| `marketing` | акции, розыгрыши, продвижение; личное рекламное; отмена мероприятия **общей аудитории** (09 §3.4, по умолчанию, ждёт заказчика Q-143) | «Реклама» | действующее согласие `client_consents(kind='marketing')` с версией документа |

Решение (0401): значения `event_cancel` и `personal` убираются из CHECK `category` (строк с ними нет – миграция падает, если есть) и становятся видами (`kind`): «личное» и «отмена мероприятия» – это назначение сообщения, а политика согласия идёт от категории (09 §3.5: «нельзя использовать категорию "личное сообщение" как способ обхода отказа»). Категория «иное информационное» (09 §3.5) не вводится: для неё нет политики согласия (разбор 09–12, дыра 6).

`kind` после 0401: `booking_confirmed`, `booking_cancelled`, `booking_rescheduled`, `reminder_day_before`, `reminder_before_start` (Э1), `personal`, `campaign`, `event_cancelled`, `event_rescheduled` (Э4), `account_event` (резерв под Q-37).

Согласование с Э3: K20 §7 упоминает категорию `event_cancel` из 0111 как готовую для уведомления заказчику. K20 строк `notifications` не пишет – только публикует `event.cancelled` / `event.rescheduled`; категорию выбирает обработчик Э4 (`service`), поэтому снятие значения из CHECK ничего у Э3 не ломает. Строку K20 правим на S4-00.

Единая функция решения (`notifications/index.ts`), вызывается при создании строки **и** повторно в `send` (09 §5.4, §6.4, приёмка 19):

```ts
type SendDecision =
  | { ok: true }
  | { ok: false; status: 'skipped_by_prefs'; reason: 'reminders_off' | 'marketing_off' | 'no_marketing_consent' | 'client_inactive' }
  | { ok: false; status: 'skipped_by_frequency'; reason: 'min_interval' }          // только marketing, §6.4
  | { ok: false; status: 'no_channel' };                                             // нет активной подписки и push=true
export function decideSend(tx: Tx, n: { clientId: string; category: Category; push: boolean }, at: Date): Promise<SendDecision>;
```

Правила `decideSend`:
1. Клиент `blocked`, `deletion_requested`, `anonymized` – реклама не уходит никогда; сервисное по живой брони – уходит (решение: блокировка аккаунта не отменяет информирование о записи).
2. `marketing`: `client_notification_prefs.marketing_enabled = true` **и** последняя запись журнала `client_consents` вида `marketing` – `granted = true`. Оба условия: переключатель – состояние, журнал – доказательство согласия (38-ФЗ ст. 18 ч. 1 – бремя доказывания на рекламораспространителе). Расхождение (prefs `true`, журнала нет) – отказ `no_marketing_consent` и запись в лог уровня `warn`.
3. `reminder` – как K14.
4. `service` – без проверок настроек.
5. Отсутствие подписки не отменяет строку: она остаётся в центре уведомлений со статусом `no_channel` (09 §10, §11.1).

## 3. Центр уведомлений в ЛК (09 §11, 03 §8.1 п.6, карта сайта `/account/notifications/`)

**Что видит клиент.** Свои строки `notifications`, у которых `planned_at <= $now` и статус в `sent_to_provider`, `no_channel`, `error` (для `service` – клиент должен узнать об отмене, даже если push не дошёл), а также `inbox_only`. Не видит: `planned`, `queued`, `sending` (ещё не наступило), `cancelled`, `skipped_*` (клиент отказался или запись устарела – показывать нечего). Реклама с отказом в центр не попадает (иначе отказ обходится через центр – решение).

**Поля (09 §11.1):** заголовок, текст, дата (`sent_at ?? planned_at`), категория подписью («Запись», «Напоминание», «Акции и новости»), признак прочтения, переход: `url` (только путь своего сайта, CHECK 0111), состояние связанной брони: `active` / `cancelled` / `finished` / `unavailable` (09 §11.2 – «связано с отменённой записью», «переход к недоступной/завершённой записи»), читается из `booking` через провайдер, не хранится.

**Прочтение.** `read_at timestamptz` в `notifications` (0401). Открыть центр не значит прочитать: прочитано – по нажатию на сообщение или «Отметить все прочитанными». Клик по push открывает `url` с параметром `?n=<id>` – страница ЛК отмечает прочтение (решение: событие показа push в браузере недостоверно, 14 §14).

**Срок показа:** 365 дней от `sent_at` – по умолчанию, ждёт заказчика (Q-132); строки старше в центре не показываются, но остаются в журнале до срока хранения журнала.

**Сообщения без push.** `push boolean NOT NULL DEFAULT true` (0401): при `false` строка создаётся сразу в статусе `inbox_only` и dispatch её не берёт. Используется для `account_event` (Q-37) и для «личного» с выбором «только в кабинет».

## 4. Рекламные сообщения: согласие, отписка, пометка

| Правило | Как | Основание |
|---|---|---|
| Реклама только при предварительном согласии | §2 п.2; согласие даётся галочкой (пустая по умолчанию) у входа (K9 №2 `consents.marketing`) или переключателем в настройках; хранится текст – версия документа `/advertising-consent/` (K22 §7: `document_version` юридической страницы). База держит это сама: 0401 добавляет CHECK `journal.client_consents`: `kind = 'marketing' AND granted` → `document_version IS NOT NULL` (`NOT VALID`, затем `VALIDATE` после проверки старых строк Э1). Старые согласия при новой редакции текста – действуют до ответа Q-149 | 38-ФЗ ст. 18 ч. 1; 09 §5.1; Q-35 |
| Отказ – немедленно | выключение в ЛК, кнопка «Отписаться от акций» в самом push (`actions` service worker), ссылка отписки в один шаг; после отказа новые строки не создаются, запланированные гасятся `skipped_by_prefs` повторной проверкой в `send` (не ждём события) | 38-ФЗ ст. 18 ч. 1 «немедленно прекратить»; 09 §5.4 |
| Отписка по ссылке без входа | в payload рекламного push, кроме `url` (страница акции), – `unsubscribeUrl = /unsubscribe/?t=<token>` (кнопка в push и ссылка внизу страницы акции в ЛК); `token` = base64url(`clientId`, `campaignId`, `exp`) + HMAC-SHA256 на `UNSUBSCRIBE_SECRET`, срок 90 дней. Страница показывает кнопку «Отписаться» (POST): GET ничего не меняет – предзагрузка ссылок почтовиками и браузерами не отписывает | решение |
| Пометка | у `marketing` заголовок начинается с «Реклама.» – по умолчанию; поле `advertiser_note` (наименование рекламодателя) и `erid` (идентификатор ОРД) в кампании – nullable в схеме; настройка `notifications.marketing_require_erid = true` по умолчанию: без `erid` рекламная кампания не подтверждается (`MARKETING_ERID_REQUIRED`) до ответа Q-130/Q-148 (нужна ли маркировка push своим клиентам); при «не нужна» Владелец выключает | 38-ФЗ ст. 18.1 (маркировка интернет-рекламы) – вывод плана, в ТЗ нет |
| Частота | не чаще одного рекламного сообщения клиенту за `notifications.marketing_min_interval_hours` (168 ч) по всем кампаниям сети; проверяется при постановке в очередь и в `send` под `pg_advisory_xact_lock` на ключ клиента (`hashtext` от `'marketing:'` и `client_id`) – две кампании одному клиенту параллельно иначе обе проходят проверку; в счёт идут строки `sent_to_provider` **и** `sending` (уже взятые отправителем) | по умолчанию, ждёт заказчика (Q-39) |
| Тихие часы | рекламное не отправляется вне окна `[10:00, 21:00)` по зоне **филиала клиента** (§5 «домашний филиал»); если `planned_at` вне окна – строка переносится на начало следующего окна, а не пропускается | по умолчанию, ждёт заказчика (Q-39); вывод разбора 09–12, дыра 5 |
| Сервисное не используется как реклама | личное сообщение требует `purpose`; `service` разрешён только с привязкой к брони клиента (`booking_id` своей зоны) или мероприятию (Э3); без привязки – только `marketing` | 09 §3.5, §4 |

## 5. Аудитория и сегменты (09 §7.2, §7.4)

**Типы аудитории** (`audience.kind`):

| `kind` | Что | Категории | Право |
|---|---|---|---|
| `client` | один клиент `{ clientId }` | `service` (с `bookingId`), `marketing` | `notifications.send.service` / `notifications.send.marketing` |
| `booking` | клиент одной брони `{ bookingId }` | `service` | `notifications.send.service` |
| `event` | заказчик мероприятия (клиент с профилем) `{ eventId }` – **ждёт K20** (Э3; гости мероприятия клиентами системы не являются) | `service` | `notifications.send.service` |
| `segment` | клиенты по условиям `segment.v1` | `marketing`; `service` – запрещён (массовое сервисное без записи – реклама в обход отказа) | `notifications.send.mass` + `notifications.send.marketing` |

**Сегмент `segment.v1`** (Zod, `packages/contracts/src/crm/notifications.ts`), все условия через «И», каждое необязательно, хотя бы одно из `branchIds`/`cityIds`/`network` обязательно:

```ts
interface SegmentV1 {
  v: 1;
  area: { network: true } | { cityIds: string[] } | { branchIds: string[] };   // область = зона прав отправителя (K1 scopeFilter)
  visitedBetween?: { from: LocalDate; to: LocalDate };      // было посещение в филиалах области (дата сеанса по зоне филиала, K8)
  notVisitedSince?: LocalDate;                              // последнее посещение раньше даты («давно не были»)
  minVisits?: number;                                       // всего посещений в области ≥ N (1..1000)
  hasUpcomingBooking?: boolean;                             // есть / нет будущей активной брони в области
  resourceTypes?: Array<'pc' | 'vr' | 'ps'>;                // посещения этих направлений
  registeredBetween?: { from: LocalDate; to: LocalDate };
}
```
Состав условий – по умолчанию, ждёт заказчика (Q-131). День рождения и баланс баллов как условия не вводятся до ответа (дата рождения – ПДн, цель обработки не заявлена в согласии – вывод плана).

**Принадлежность клиента филиалу.** Клиент один на сеть (03, K9), поэтому «клиенты филиала» = клиенты с хотя бы одной бронью (любого статуса, кроме удержаний) в филиалах области за всё время (решение). **Домашний филиал** клиента для тихих часов – филиал его последнего посещения в области, иначе последней брони, иначе первый филиал области по `sort_order`.

**Предпросмотр аудитории** (`previewAudience`, 09 §7.4): одним запросом в READ ONLY транзакции считается и возвращается:

```ts
interface AudiencePreview {
  total: number;                 // все, кто подходит под аудиторию
  willReceivePush: number;       // пройдут decideSend и есть активная подписка
  inboxOnly: number;             // пройдут decideSend, подписки нет – только центр (no_channel)
  excludedMarketingOff: number;  // отказ или нет согласия
  excludedFrequency: number;     // получили рекламу за последние 168 ч
  excludedInactive: number;      // заблокирован, удаление, обезличен
  criticalService: number;       // для service: получат как критичное
  sample: Array<{ clientId: string; displayName: string }>;  // до 10, имя маской (K24 §6) без права client.view.full
  computedAt: string;
}
```
Принудительной отправки отказавшимся нет ни в API, ни в интерфейсе (09 §7.4 последний абзац).

**Снимок.** При подтверждении состав аудитории фиксируется в `notification_campaign_recipients` (клиент, домашний филиал, решение на момент снимка). Новые клиенты, подошедшие позже, не добавляются (09 §14: «после отправки … состав аудитории должны оставаться в истории»). Решение `decideSend` повторяется при отправке каждой строки – снимок не обходит отказ, сделанный после подтверждения.

## 6. Кампания (ручное и массовое сообщение)

Любое ручное сообщение – кампания, в том числе одному клиенту (одна модель вместо двух – решение). Статусы:

```
draft → confirmed → expanding → sending → done
draft → cancelled ; confirmed|expanding|sending → cancelled (остаток не уходит, ушедшее не отзывается)
```

| Команда (`campaigns.ts`) | Что | Идемпотентность |
|---|---|---|
| `createCampaign(ctx, { purpose, category, title, body, url?, audience, branchScope, plannedAt?, templateId?, push })` | черновик; `row_version` | `Idempotency-Key` |
| `updateCampaign(ctx, id, { rowVersion, … })` | только `draft` | `row_version` |
| `previewCampaign(ctx, id)` | §5; результат запоминается в кампании (`preview_snapshot`, `preview_at`) | чтение |
| `confirmCampaign(ctx, id, { rowVersion, expectedTotal })` | проверяет право по категории и типу аудитории; для `segment` и `total > 1` – `expectedTotal` обязан совпасть с повторным подсчётом (двойное подтверждение 09 §7.5: экран показывает число, пользователь подтверждает именно его; аудитория изменилась – `409 AUDIENCE_CHANGED` с новым числом); пишет снимок получателей, статус `confirmed`, задачу `notifications:campaign-expand` | `Idempotency-Key`; повтор → та же кампания |
| `cancelCampaign(ctx, id, { reason })` | неотправленные строки → `cancelled`; причина обязательна | `Idempotency-Key` |

**Неизменность (09 §14).** После `confirmed` `title`, `body`, `url`, `category`, `audience`, `segment` не меняются – триггер БД отклоняет `UPDATE` этих столбцов (`42501`), правка текста – только новой кампанией.

**Разворачивание** (`campaign-runner.ts`, pg-boss `notifications:campaign-expand`, `singletonKey = campaignId`): пачками по 500 получателей из снимка создаёт строки `notifications` с `dedupe_key = 'campaign:<campaignId>:<clientId>'` (`ON CONFLICT DO NOTHING` – повтор задачи не дублирует), `planned_at = max(campaign.plannedAt ?? $now, начало окна тихих часов по домашнему филиалу)`; статус кампании `expanding` → `sending`; когда у кампании нет строк в `planned/queued/sending` – `done` (задача `notifications:campaign-close` раз в минуту).

**Планирование.** `plannedAt` – не раньше `$now`, не позже `$now + 30 дней` – по умолчанию, ждёт заказчика (Q-133).

**Пропускная способность.** `notifications:dispatch` (K14) берёт 200 строк за 30 с – 400 в минуту; для рекламных строк лимит отдельной пачки 100 за проход, чтобы сервисные напоминания не стояли за рассылкой (решение: в `dispatch` два запроса – сначала `category <> 'marketing'`, затем `marketing`). 10 000 получателей ≈ 100 минут – допустимо для рекламы, проверяется в S4-135.

## 7. Отправка – правки `sender.ts` (дополняют K14)

1. Шаг 1 `send`: вместо отдельных проверок K14 п.1 для не-брони вызывается `decideSend` (§2); для `marketing` дополнительно – тихие часы (вне окна → обратно `planned` с `planned_at` = начало окна) и частота: в транзакции `pg_advisory_xact_lock` на клиента (§4), затем `skipped_by_frequency`, если другое рекламное этому клиенту в статусе `sent_to_provider` или `sending` ушло (взято) позже `$now − 168 ч`.
2. `personal`/`service` с `booking_id` – те же проверки брони, что у K14 (бронь не отменена, клиент тот же); бронь отменена → `skipped_booking_changed`.
3. Payload push: `{ title, body, url, tag: dedupe_key, id, actions? }`; у `marketing` – `actions: [{ action: 'unsubscribe', title: 'Отписаться от акций' }]` и `unsubscribeUrl` (обработчик service worker шлёт `POST /unsubscribe` с токеном). TTL: `marketing` – 12 ч, `personal` – 24 ч (решение).
4. Новый статус строки `skipped_by_frequency` и `inbox_only` (0401, CHECK). `delivered` по-прежнему не ставится (09 §9, приёмка 17).

## 8. Шаблоны (09 §15 эт.3 п.4; Q-133)

`notification_templates`: `id`, `name`, `category` (`service`/`marketing`), `title`, `body` (плейсхолдеры только из белого списка: `{client.firstName}`, `{branch.name}`, `{branch.address}`, `{city.name}` – подставляются при разворачивании; неизвестный плейсхолдер – ошибка при сохранении; подставленное имя попадает в `notifications.title/body` – поэтому модуль регистрирует свои строки в процедуре обезличивания клиента K9, §15), `status` `active`/`archived`, `row_version`. Шаблон копируется в кампанию при создании: правка шаблона не меняет созданные кампании. Управляет Владелец (`notifications.templates.manage`); пользуются все, у кого есть право отправки своей категории.

## 9. Журнал отправок CRM и ручной повтор (09 §10, §12.2, §16 п.15–16; 16 §15.3)

- Список кампаний: дата создания, плановая и фактическая отправка, категория, заголовок, источник, автор, аудитория (описание сегмента словами), число адресатов, `отправлено / только центр / исключено / ошибка`, статус. Фильтры 09 §12.2: период, филиал, категория, источник, автор, статус, клиент.
- Список строк (`notifications`) с теми же фильтрами плюс вид и бронь – в пределах `scopeFilter(ctx,'notifications.view')` по `branch_id`; строки без `branch_id` (сетевая кампания) видит только зона сети (Владелец) – решение.
- **Ручной повтор** критичного сервисного (`category = 'service'`, статус `error` или `no_channel`): `retryNotification(ctx, id, { reason })` – новая строка с `dedupe_key = '<старый>:retry:<n>'`, ссылкой `retry_of`, `planned_at = $now`; исходная не меняется (журнал). Повтор рекламы запрещён (`RETRY_NOT_ALLOWED`) – иначе ручной обход частоты.
- Блок в карточке клиента (09 §12.3): «Реклама» вкл/выкл и дата последнего изменения (из `client_consents`), «Напоминания», push – «есть N браузеров» без endpoint и ключей, последние 20 уведомлений.

## 10. Права (K1, шаг S4-01)

| Действие (`Action`) | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `notifications.view` (есть) | ✓ | ✓ | ✓ | branch | K14 |
| `notifications.send.service` (личное и по записи) | ✓ | ✓ | ✓ | branch | 09 §14 «Администратор – адресные сервисные/личные» |
| `notifications.send.marketing` | ✓ | ✓ | | branch / city / network | по умолчанию, ждёт заказчика (Q-39); 09 §14 «рекламные – только при отдельном разрешении» |
| `notifications.send.mass` (аудитория `segment`) | ✓ | ✓ | | branch / city / network | 09 §7.2 п.4 |
| `notifications.retry` | ✓ | ✓ | | branch | 09 §10 |
| `notifications.templates.manage` | ✓ | | | network | 09 §14 «настройка шаблонов – Владелец» |

Сетевая область (`area.network`) требует цели `{ network: true }` – её даёт только назначение на сеть (Владелец, K1). Директор отправляет рекламу только в своей зоне: `area.branchIds` ⊆ зоны, иначе `404` на чужой филиал (как K1).

## 11. API

**ЛК (дополняет K9; база `/api/public/v1`, кука `yu_client`):**

| № | Метод и путь | Тело / параметры | Успех | Ошибки |
|---|---|---|---|---|
| K5 №201 | `GET /me/notifications?cursor=&limit=` | `limit` 1..50 | `200 { items: InboxItem[], nextCursor, unread }`, порядок `(coalesce(sent_at, planned_at) DESC, id)` | – |
| K5 №202 | `GET /me/notifications/unread-count` | – | `200 { unread }` (для значка в шапке, `Cache-Control: no-store`) | – |
| K5 №203 | `POST /me/notifications/{id}/read` | – | `204`; чужая или скрытая строка – `404` | `404 NOT_FOUND` |
| K5 №204 | `POST /me/notifications/read-all` (`Idempotency-Key`) | `{ before: ISO }` – отмечаются строки не новее `before` | `200 { marked }` | – |
| K5 №205 | `GET /unsubscribe/check?t=` (без сессии) | токен §4 | `200 { valid, marketingEnabled }` – без имени и телефона | `400 UNSUBSCRIBE_TOKEN_INVALID` |
| K5 №206 | `POST /unsubscribe` (без сессии) | `{ t }` | `200 { marketingEnabled: false }`; пишет `client_consents(marketing, granted=false, source='site')` (CHECK `source` 0105 не меняем; что это отписка по ссылке – в аудите `notification.unsubscribed`), `prefs.marketing_enabled=false`, событие `client.notification_prefs_changed`; повтор – тот же ответ | `400 UNSUBSCRIBE_TOKEN_INVALID`, `410 UNSUBSCRIBE_TOKEN_EXPIRED` (страница предлагает войти и выключить в настройках) |

`InboxItem = { id, title, body, category: 'service'|'reminder'|'marketing', kind, at, read: boolean, url: string | null, booking: { id, state: 'active'|'cancelled'|'finished'|'unavailable' } | null }`.

Ограничение частоты (решение): №205–206 – 10 запросов в минуту с IP (как вход по коду K9), токен проверяется сравнением в постоянное время.

**CRM (дополняет K11; база `/api/crm/v1`, кука `yu_staff`, изменяющие – `Idempotency-Key`):**

| № | Метод и путь | Право | Успех |
|---|---|---|---|
| K11 №201 | `GET /notifications/campaigns?…фильтры 09 §12.2&cursor=` | `notifications.view` | `200 { items: CampaignRow[], nextCursor }` |
| K11 №202 | `POST /notifications/campaigns` | по категории (§10) | `201 Campaign` (`draft`) |
| K11 №203 | `GET /notifications/campaigns/{id}` | `notifications.view` | `200 Campaign & { counters, timeline: AuditEventView[] }` |
| K11 №204 | `PATCH /notifications/campaigns/{id}` (без `Idempotency-Key`, защита – `row_version`) | как №202 | `200 Campaign`; не `draft` – `409 CAMPAIGN_NOT_EDITABLE` |
| K11 №205 | `POST /notifications/campaigns/{id}/preview` | как №202 | `200 AudiencePreview` |
| K11 №206 | `POST /notifications/campaigns/{id}/confirm` | как №202 (+ `send.mass` для `segment`) | `200 Campaign` (`confirmed`) |
| K11 №207 | `POST /notifications/campaigns/{id}/cancel` | как №202 | `200 Campaign` |
| K11 №208 | `GET /notifications?clientId=&bookingId=&status=&category=&from=&to=&cursor=` | `notifications.view` | `200 { items: NotificationView[], nextCursor }` |
| K11 №209 | `POST /notifications/{id}/retry` | `notifications.retry` | `201 NotificationView` |
| K11 №210 | `GET /notifications/templates` | `notifications.view` | `200 { items }` |
| K11 №211 | `POST /notifications/templates`, `PATCH /notifications/templates/{id}` | `notifications.templates.manage` | `201` / `200` |
| K11 №212 | `GET /clients/{clientId}/notification-summary` | `notifications.view` + `client.view.basic` | `200 { marketing: { enabled, changedAt, source }, reminders: { enabled, changedAt }, push: { activeDevices }, recent: NotificationView[] }` |

## 12. Ошибки (тело ADR 0002)

| Код | HTTP | Когда |
|---|---|---|
| `CATEGORY_REQUIRED` | 422 | нет `category` или `purpose` у личного (09 §3.5, §7.3) |
| `SERVICE_NEEDS_SUBJECT` | 422 | `service` без брони или мероприятия клиента (§4 последняя строка) |
| `SEGMENT_SERVICE_FORBIDDEN` | 422 | `service` на аудиторию `segment` |
| `SEGMENT_INVALID` | 422 | сегмент не проходит `segment.v1` или пустая область; `details.issues` по полям |
| `AUDIENCE_EMPTY` | 422 | `total = 0` при подтверждении |
| `AUDIENCE_CHANGED` | 409 | `expectedTotal` не совпал; `details: { total }` |
| `CAMPAIGN_NOT_EDITABLE` | 409 | правка не-`draft` |
| `CAMPAIGN_ALREADY_FINISHED` | 409 | отмена `done`/`cancelled` |
| `PLANNED_AT_OUT_OF_RANGE` | 422 | `plannedAt` в прошлом или позже 30 дней |
| `TEMPLATE_PLACEHOLDER_UNKNOWN` | 422 | плейсхолдер вне белого списка |
| `RETRY_NOT_ALLOWED` | 409 | повтор не-`service` или статуса не `error`/`no_channel` |
| `UNSUBSCRIBE_TOKEN_INVALID` / `UNSUBSCRIBE_TOKEN_EXPIRED` | 400 / 410 | §11 |
| `VERSION_CONFLICT` | 409 | устаревший `row_version` (16 §15.4) |
| `MARKETING_ERID_REQUIRED` | 422 | подтверждение рекламы без `erid` при `notifications.marketing_require_erid = true` (§4) |

## 13. Настройки (K7, шаг S4-01; меняет только Владелец, D2-02)

| Ключ | Тип | Умолчание | Уровень | Основание |
|---|---|---|---|---|
| `notifications.marketing_min_interval_hours` | int 0..720 | 168 | network | Q-39 |
| `notifications.marketing_window_from` | `HH:mm` | `"10:00"` | network | Q-39 |
| `notifications.marketing_window_to` | `HH:mm` | `"21:00"` | network | Q-39 |
| `notifications.inbox_retention_days` | int 30..1095 | 365 | network | Q-132 |
| `notifications.campaign_max_plan_days` | int 0..90 | 30 | network | Q-133 |
| `notifications.marketing_title_prefix` | text ≤ 20 | `"Реклама."` | network | Q-130 |
| `notifications.marketing_require_erid` | boolean | true | network | Q-130, Q-148 |

Окружение (не настройки): `UNSUBSCRIBE_SECRET` (≥ 32 байта, как `CERT_PEPPER`; без него рекламные кампании не подтверждаются – `503 MARKETING_NOT_CONFIGURED`).

## 14. События и аудит

- K4: новых событий модуль не публикует (решение: подписчиков нет). Слушает `client.notification_prefs_changed` (есть) и – поздний шаг S4-29 – `event.cancelled` / `event.rescheduled` из K20 §12 (заказчик с профилем → `service`, `kind='event_cancelled'`/`'event_rescheduled'`, `dedupe_key = '<kind>:<eventId>:<version>'`).
- K2 (типы объектов `notification_campaign`, `notification_template` – добавить в `AUDIT_OBJECT_TYPES`): `notification.campaign_created`, `.campaign_updated`, `.campaign_confirmed` (`after`: категория, текст, описание аудитории, `total`), `.campaign_cancelled` (причина), `notification.retried`, `notification.template_created/updated/archived`, `notification.unsubscribed` (актор `client`, источник `unsubscribe`). Текст кампании пишется в аудит один раз – при подтверждении (09 §14).

## 15. Данные (для `model-dannyh.md`, S4-00)

**ПДн в журналах (ревью 04.11).** Подставленные имена клиента живут в `notifications.title/body` и в аудите (`campaign_confirmed` пишет текст шаблона, не подстановку – там имени нет; `notification.retried` и строки клиента – с подстановкой). Обезличивание клиента (K9, статус `anonymized`) вызывает обработчик модуля `notifications`: в строках этого клиента `title/body` заменяются на текст шаблона без подстановки, в аудите – маска имени. Сроки хранения строк `notifications`, `journal.notification_campaign_recipients` и аудита рассылок – вопрос Q-150 (сейчас – как аудит, Q-91); удаление по сроку – задача очистки после ответа. Та же процедура обезличивает `events.customer_name`, `customer_phone_e164`, `birthday_person_name`, `wishes` мероприятий клиента (K20 §14).

**0401 `notifications_center`** (владелец `notifications`): `ALTER TABLE app.notifications` – `read_at timestamptz`, `push boolean NOT NULL DEFAULT true`, `campaign_id uuid` (FK – в 0402), `retry_of uuid REFERENCES app.notifications(id)`, `purpose text`; CHECK `category IN ('service','reminder','marketing')`; CHECK `kind` – список §2; CHECK `status` + `skipped_by_frequency`, `inbox_only`; `CHECK (push OR status IN ('inbox_only','cancelled'))`; отложенный FK `booking_id → app.bookings(id)` (обещан шапкой 0111, ни одна миграция его не добавила); индекс `notifications_inbox_idx (client_id, coalesce(sent_at, planned_at) DESC) WHERE status IN ('sent_to_provider','no_channel','error','inbox_only')`; индекс `notifications_marketing_recent_idx (client_id, sent_at DESC) WHERE category = 'marketing' AND status = 'sent_to_provider'`. Вниз – обратные изменения; вниз падает, если есть строки новых видов (решение: откат только на пустом Э4).

**0402 `notification_campaigns`**: `notification_templates` (§8); `notification_campaigns` (`id`, `status`, `purpose`, `category`, `title`, `body`, `url`, `push`, `audience jsonb`, `area_type`, `area_ids uuid[]`, `planned_at`, `advertiser_note`, `erid`, `template_id → templates`, `preview_snapshot jsonb`, `preview_at`, `total int`, `created_by`, `confirmed_by`, `confirmed_at`, `cancelled_reason`, `row_version`; триггер неизменности §6); `journal.notification_campaign_recipients` (только вставка: `campaign_id`, `client_id`, `home_branch_id → branches`, `decision text`, `UNIQUE (campaign_id, client_id)`); `ALTER notifications ADD FOREIGN KEY (campaign_id) REFERENCES app.notification_campaigns(id)`.

## 16. Проверка

| Правило | Тест | Шаг |
|---|---|---|
| 09 приёмка 2, 5, 6, 13: решение по категории, не по источнику | табличный тест `decideSend`: 3 категории × prefs × согласие × источник system/staff | S4-12 |
| 09 приёмка 13, 38-ФЗ: отказ после подтверждения кампании | подтвердить, выключить рекламу, прогнать `send` → `skipped_by_prefs`; `prefs=true` без журнала согласия → `no_marketing_consent` | S4-16 |
| 09 §7.4: предпросмотр | сегмент из 6 клиентов: отказ, без согласия, без подписки, заблокирован, частота, годный → счётчики 1/1/…; сумма = `total` | S4-13 |
| 09 §7.5: двойное подтверждение | `expectedTotal` не совпал → `409 AUDIENCE_CHANGED`; совпал → `confirmed`; повтор с тем же ключом – та же кампания | S4-14 |
| 09 §14: неизменность | `UPDATE title` подтверждённой кампании от `yu_app` → `42501` | S4-12 |
| 16 §15.2: повтор не дублирует | задача разворачивания дважды и параллельно → по одной строке на клиента | S4-15 |
| частота и тихие часы | реклама в 23:00 по зоне филиала → `planned_at` = 10:00 следующего дня; вторая кампания через 2 дня → `skipped_by_frequency`; тест с чужим `TZ` машины | S4-16 |
| отписка | GET страницы не меняет согласие; POST – меняет, повтор идемпотентен; поддельный токен → 400; просроченный → 410 | S4-19 |
| центр | клиент видит только свои строки нужных статусов; реклама с отказом не видна; `service` с `no_channel` видна; чужой `id` → 404; прочтение одной и всех | S4-10, S4-11 |
| права | Администратор: `send.service` да, `marketing`/`mass` – 403; Директор – сегмент на чужой филиал → 404; сеть – только Владелец | S4-18 |
| 18 §8.4 «повторная отправка не создаёт дублей» | ручной повтор – новая строка с `retry_of`, исходная не изменилась; повтор рекламы – `RETRY_NOT_ALLOWED` | S4-17 |
