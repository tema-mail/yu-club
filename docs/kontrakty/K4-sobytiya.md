# K4. События outbox

Модуль: `apps/api/src/core/outbox.ts`; схемы payload – `packages/contracts/src/events.ts` (Zod). Таблицы: `outbox_events`, `processed_events` (model-dannyh 0005). Шаг: S0-08. Производители: `booking` (П4), `finance` (Э2, K10). Потребители: `notifications` (П7), `loyalty` (П8b, Э2), CRM-обновления.
Основа: ADR 0004 §3; 16 §2.6, §15.3; 01 §14; 09 §6, §8.

## Конверт

```ts
export interface EventEnvelope<T extends EventType = EventType> {
  eventId: string;            // uuid = outbox_events.id
  type: T;                    // 'booking.confirmed'
  version: number;            // версия схемы payload; ломающее изменение = новая версия, старая живёт до переключения потребителей
  aggregateType: 'hold' | 'booking' | 'resource_block' | 'client' | 'payment' | 'certificate';   // payment, certificate – Э2 (S2-06)
  aggregateId: string;
  branchId: string | null;
  occurredAt: string;         // ISO UTC
  payload: EventPayload<T>;
}

/** Внутри транзакции команды. dedupeKey = `${type}:${aggregateId}:${aggregateVersion}` –
 *  второй publish того же факта ловится UNIQUE и молча пропускается (возвращает существующий eventId). */
export function publish<T extends EventType>(tx: Tx, e: {
  type: T; aggregateType: EventEnvelope['aggregateType']; aggregateId: string; aggregateVersion: number | string;
  branchId: string | null; payload: EventPayload<T>;
}): Promise<{ eventId: string }>;

/** Регистрация обработчика. name – стабильное имя, в processed_events.handler. */
export function subscribe<T extends EventType>(type: T, name: string,
  handler: (tx: Tx, e: EventEnvelope<T>) => Promise<void>,
  opts?: { retryLimit?: number /* 10 */; retryBackoff?: true }): void;
```

**Доставка.** Диспетчер в `worker`: по `NOTIFY outbox` (триггер `AFTER INSERT`) и каждые 1 с выбирает `dispatched_at IS NULL ... FOR UPDATE SKIP LOCKED LIMIT 100`, ставит в pg-boss задачу `outbox:<handler>` с `singletonKey = <eventId>:<handler>` на каждого подписчика, ставит `dispatched_at`. Событие появляется у подписчиков **только после фиксации** транзакции факта.

**Обработка.** Задача открывает транзакцию → `INSERT INTO processed_events (handler, event_id) ON CONFLICT DO NOTHING RETURNING` → пусто = уже обработано, выход → иначе `handler(tx, e)` → фиксация. Исключение → откат, повтор pg-boss: экспонента, до 10 попыток, затем `failed` + лог уровня `error` с `eventId`, `handler` (видно в мониторинге, 17 §13). Сбой обработчика не трогает исходный факт (16 §2.6).

**Порядок.** Не гарантируется между событиями. Обработчик сверяется с текущим состоянием агрегата (`bookingVersion` в payload ≠ `current_version` → устаревшее, ничего не делать). Так перенос и отмена не шлют устаревших напоминаний (09 §6.4).

## События этапа 1

Все времена – ISO UTC; `branchTimezone` передаётся, чтобы потребитель не ходил за ним.

| `type` @ver | Когда публикуется (в транзакции какой команды) | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `hold.created` @1 | создано удержание (K5 `POST /holds`) | `1` | `{ holdId, branchId, clientId \| null, expiresAt, items: [{ itemId, resourceId, start, end }] }` | CRM-календарь (обновление) |
| `hold.extended` @1 | добавлен слот, таймер перезапущен (01 §7.2) | `<число позиций>` | `{ holdId, expiresAt, addedItem: { itemId, resourceId, start, end } }` | CRM-календарь |
| `hold.expired` @1 | задача истечения или гашение в чужой транзакции перевело удержание в `expired` | `'expired'` | `{ holdId, branchId, clientId \| null, itemIds: string[] }` | аудит системы (K2 `hold.expired`), CRM |
| `booking.confirmed` @1 | подтверждение удержания (K5) или создание администратором (S1-13) | `1` | `{ bookingId, number, checkoutId, branchId, branchTimezone, clientId, resourceId, resourceName, start, end, priceKop, source: 'site'\|'crm', bookingVersion: 1 }` | notifications: подтверждение + план напоминаний 21:00 и −15 мин (09 §6) |
| `booking.cancelled` @1 | отмена клиентом или клубом (S1-09) | `'cancelled'` | `{ bookingId, number, branchId, branchTimezone, clientId, start, end, bookingVersion, cancelledBy: 'client'\|'club', reasonCode \| null, publicReason \| null }` | notifications: отмена плановых, сервисное «отменено» при `club` (09 §8); loyalty Э2: снятие резерва брони `released('booking_cancelled')` (K15 §3; баллы до оплаты не списывались – возвращать нечего) |
| `booking.rescheduled` @1 | перенос подтверждён (новая версия записана) | `<новая версия>` | `{ bookingId, number, branchId, branchTimezone, clientId, previous: { version, resourceId, start, end }, current: { version, resourceId, resourceName, start, end, priceKop } }` | notifications: отмена старых, новые напоминания, сервисное «было/стало» (01 §11 п.5–6, 09 §8) |
| `visit.confirmed` @1 | отметка прихода (S1-10) | `<visitId>` | `{ visitId, bookingId, branchId, clientId, arrivedAt, plannedStart, plannedEnd, plannedMinutes, resourceType }` | loyalty Э2: начисление, **только если у брони уже есть живой платёж** не баллами (K15 §4, K10 §1; ключ `loyalty-accrual:<visitId>:<paymentId>`); основной сигнал начисления – `payment.recorded` |
| `visit.reverted` @1 | ошибочный приход исправлен | `'reverted:' + visitId` | `{ visitId, bookingId, clientId, reason }` | loyalty Э2: сторно начисления (ниже −50 – `loyalty_issues`, K15 §4); платёж не трогается (16 §5, Q-104) |
| `no_show.marked` @1 | отметка неявки (S1-10) | `<noShowId>` | `{ noShowId, bookingId, branchId, clientId, plannedStart }` | loyalty Э2: штраф −5 (07 §8, ключ `loyalty-penalty:<noShowId>`); в Э1 подписчика нет – событие копится, штраф применяется только к неявкам после старта Э2 (план 4.3 п.10) |
| `no_show.reverted` @1 | ошибочная неявка исправлена | `'reverted:' + noShowId` | `{ noShowId, bookingId, clientId, reason }` | loyalty Э2: сторно штрафа |
| `resource.blocked` @1 | создана блокировка (S1-04) | `1` | `{ blockId, branchId, unitIds, start, end, reasonCode, affectedBookingIds: string[] }` | CRM: список затронутых; notifications Э3 (TC-12) |
| `resource.unblocked` @1 | блокировка снята | `'lifted'` | `{ blockId, branchId, unitIds, liftedAt }` | CRM |
| `client.notification_prefs_changed` @1 | клиент изменил «Напоминания»/«Реклама» в ЛК | `<updated_at ms>` | `{ clientId, remindersEnabled, marketingEnabled }` | notifications: отмена запланированных напоминаний при выключении (09 §5.4) |

Дополнительные потребители событий Э1 в Э2 (K15 §3): `hold.expired` – loyalty ускоряет запись статуса резерва `released('hold_expired')`; `booking.confirmed` – loyalty переводит резерв удержания на брони (`converted` → `booking`); `booking.rescheduled` – loyalty пересчитывает резерв брони на новые минуты; `no_show.marked` – кроме штрафа, снятие резерва `released('no_show')` без списания (Q-46).

Решение: добавлены к списку плана (5.3) `hold.extended`, `visit.reverted`, `no_show.marked/reverted` с парами, `resource.unblocked`, `client.notification_prefs_changed` – без них потребитель не может исправить уже применённый эффект.

Имена в коде – dot-case (`booking.confirmed`); в плане они записаны как `BookingConfirmed` – это одно и то же.

## События этапа 2 (K10 §6; внесены S2-00 02.11.2026)

Тип агрегата `payment` (S2-06, `core/outbox.ts`). Схемы payload – `packages/contracts/src/events.ts`, типы – реестр `modules/finance/methods.ts` (S2-06).

| `type` @ver | Когда публикуется | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `payment.recorded` @1 | платёж проведён (K10 `recordPayment`) | `<paymentId>` | `{ paymentId, sessionId, bookingId, branchId, clientId, attempt, methods: PaymentMethod[], totalKop, pointsCenti \| null, certificateId \| null }` | loyalty: начисление (K15 §4), снятие резерва `released('paid_other')` при способе не `points` (K15 §3); CRM: статус |
| `payment.refunded` @1 | возврат проведён (K10 `refundPayment`) | `<refundId>` | `{ refundId, paymentId, bookingId, clientId, lines: [{ lineNo, method, amountKop, pointsCenti \| null, outcome }], reason, sessionStatus }` | loyalty: при `sessionStatus = 'refunded'` – сторно начисления (K15 §4, Q-102); CRM; отчёты Э4 |

Модули `loyalty` (K15) и `certificates` (K16) в Э2 **своих событий не публикуют**: их контракты событий не объявляют, эффекты видны через аудит K2 и чтение модуля. Тип агрегата `certificate` резервируется заранее (S2-06), чтобы будущее событие не требовало правки ядра; добавление события – правка этой таблицы и схемы (правило 5).

## События этапа 4 (K23 §5; внесены S4-00 04.11.2026)

Публикуют владельцы слагов в транзакции своей команды (S4-51); подписчик – `content` (`content/handlers.ts`, S4-52) пишет `seo_slug_history`. Событие, а не прямой вызов: `network` и `resources` не зависят от `content` (иначе цикл – `content` читает филиалы). Публикуется только при фактической смене слага; правка без смены – события нет.

| `type` @ver | Когда публикуется | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `city.slug_changed` @1 | смена слага города (`network/commands.ts`) | `<row_version города>` | `{ id, parentId: null, oldSlug, newSlug }` | content: история адресов (K23 §5) |
| `branch.slug_changed` @1 | смена слага филиала (`network/commands.ts`) | `<row_version филиала>` | `{ id, parentId: cityId, oldSlug, newSlug }` | content |
| `room.slug_changed` @1 | смена слага комнаты (`resources/routes.ts`) | `<row_version комнаты>` | `{ id, parentId: branchId, oldSlug, newSlug }` | content |

Остальные модули Э4 событий не публикуют: `notifications` (K21 §14) и `content` (K22 §16 – `content.published` не вводится, пока нет подписчика, как D2-09). Э4 – потребитель событий Э3: `shift.changed` (K18 §11), `repair.registered` / `repair.closed` (K19 §11) – лента событий CRM (S4-28, без push сотрудникам, Q-147); `event.cancelled` / `event.rescheduled` (K20 §12) – сервисное заказчику с профилем (S4-29).

## Правила

1. Публикуем только **фактом зафиксированное** изменение: `publish` вызывается после успешной записи в той же транзакции.
2. Payload – без лишних ПДн: телефон и имя клиента в событие не кладём, только `clientId` (решение). Потребитель читает нужное через `clients/index.ts`.
3. Обработчик идемпотентен дважды: `processed_events` + собственный ключ эффекта (`notifications.dedupe_key`, `ledger_entries.idempotency_key`).
4. Внешний вызов (push) обработчик делает **не** внутри своей транзакции: обработчик только создаёт строки `notifications`, отправку делает задача `notifications:send` (K14).
5. Новое событие или поле – правка этого файла + схема в `packages/contracts/src/events.ts`; добавление необязательного поля версию не меняет.

## Проверка (S0-08)

- Откат транзакции факта → события нет у подписчика.
- Обработчик бросает 2 раза → третья попытка успешна, эффект один.
- Двойная доставка одной задачи (имитация) → `processed_events` гасит вторую.
- `publish` того же факта дважды в одной команде → одна строка outbox.
