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

Тип агрегата `payment` (S2-06, `core/outbox.ts`). Типы payload Э2 – `declare module` в `modules/finance/payment.ts` и реестр способов `modules/finance/methods.ts` (S2-06); файла `packages/contracts/src/events.ts` в коде нет (уточнено S3-00 04.11.2026: прежняя ссылка была планом, а не фактом).

| `type` @ver | Когда публикуется | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `payment.recorded` @1 | платёж проведён (K10 `recordPayment`) | `<paymentId>` | `{ paymentId, sessionId, bookingId, branchId, clientId, attempt, methods: PaymentMethod[], totalKop, pointsCenti \| null, certificateId \| null }` | loyalty: начисление (K15 §4), снятие резерва `released('paid_other')` при способе не `points` (K15 §3); CRM: статус |
| `payment.refunded` @1 | возврат проведён (K10 `refundPayment`) | `<refundId>` | `{ refundId, paymentId, bookingId, clientId, lines: [{ lineNo, method, amountKop, pointsCenti \| null, outcome }], reason, sessionStatus }` | loyalty: при `sessionStatus = 'refunded'` – сторно начисления (K15 §4, Q-102); CRM; отчёты Э4 |

Модули `loyalty` (K15) и `certificates` (K16) в Э2 **своих событий не публикуют**: их контракты событий не объявляют, эффекты видны через аудит K2 и чтение модуля. Тип агрегата `certificate` резервируется заранее (S2-06), чтобы будущее событие не требовало правки ядра; добавление события – правка этой таблицы и схемы (правило 5).

## События этапа 3 (K18 §11, K19 §11, K20 §12; внесено S3-00 04.11.2026)

Типы агрегатов Э3 – `shift`, `staff_rate`, `repair`, `event`, `gift` (S3-08, `core/outbox.ts`). Zod-схемы payload – `packages/contracts/src/events-e3.ts` (S3-08; API импортирует его относительным путём, как `crm/booking.ts`); типы выводятся из схем (`E3EventPayloads`), и `EventRegistry` ядра (`core/outbox.ts`) расширяет это отображение – производителям Э3 `declare module` не нужен. Проверка payload перед публикацией – `parseE3Payload`. Блокировки из ремонта публикуют существующие `resource.blocked` / `resource.unblocked`.

| `type` @ver | Когда публикуется | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `shift.changed` @1 | создание, правка, отмена смены не её сотрудником | `row_version` | `{ shiftId, staffId, branchId, branchTimezone, changedBy, kind: 'created'\|'updated'\|'cancelled', before: { start, end, branchId } \| null, after: … \| null, reason }` | Э4: уведомление сотруднику (K21) |
| `shift.attendance_changed` @1 | любое изменение факта смены | `fact_version` | `{ shiftId, staffId, branchId, localDate, factVersion }` | shifts: начисление (K18 §6) |
| `staff.rate_set` @1 | `setRate` | `<rateId>` | `{ rateId, staffId, validFrom, affectedShiftIds }` | shifts: пересчёт открытых периодов (K18 §3) |
| `repair.registered` @1 | `registerRepair` | `1` | `{ repairId, number, equipmentId, branchId, priority, impact, autoBlockId \| null }` | Э4 (K21) |
| `repair.closed` @1 | `closeRepair` | `'closed'` | `{ repairId, branchId, finalEquipmentStatus, stillBlockedIds }` | Э4 |
| `event.confirmed` @1 | переход в `confirmed` | `row_version` | `{ eventId, number, branchId, branchTimezone, customerClientId \| null, plannedStart, plannedEnd }` | Э4 |
| `event.rescheduled` @1 | `moveEvent` | `row_version` | `{ eventId, branchId, customerClientId \| null, previous: { start, end }, current: { start, end } }` | Э4 |
| `event.cancelled` @1 | `cancelled` / `not_held` | `'cancelled'` | `{ eventId, branchId, customerClientId \| null, reason, linkedBookingIds, giftIds }` | Э4 |
| `gift.issued` @1 | `issueGift` | `1` | `{ giftId, clientId, validUntil, issueBranchId }` | Э4: центр уведомлений ЛК |

Подарок (events) подписывается на `hold.expired`, `booking.confirmed`, `booking.cancelled`, `booking.rescheduled`, `visit.confirmed`, `visit.reverted`, `no_show.marked` (K20 §12, S3-59). Payload Э3 без сумм зарплаты и ставок (правило 2 – ПДн; K18 §10).

## Правила

1. Публикуем только **фактом зафиксированное** изменение: `publish` вызывается после успешной записи в той же транзакции.
2. Payload – без лишних ПДн: телефон и имя клиента в событие не кладём, только `clientId` (решение). Потребитель читает нужное через `clients/index.ts`.
3. Обработчик идемпотентен дважды: `processed_events` + собственный ключ эффекта (`notifications.dedupe_key`, `ledger_entries.idempotency_key`).
4. Внешний вызов (push) обработчик делает **не** внутри своей транзакции: обработчик только создаёт строки `notifications`, отправку делает задача `notifications:send` (K14).
5. Новое событие или поле – правка этого файла + схема (Э3 – `packages/contracts/src/events-e3.ts`); добавление необязательного поля версию не меняет.

## Проверка (S0-08)

- Откат транзакции факта → события нет у подписчика.
- Обработчик бросает 2 раза → третья попытка успешна, эффект один.
- Двойная доставка одной задачи (имитация) → `processed_events` гасит вторую.
- `publish` того же факта дважды в одной команде → одна строка outbox.
