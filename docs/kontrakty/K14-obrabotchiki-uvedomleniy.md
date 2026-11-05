# K14. Обработчики уведомлений (сервисные push Э1)

Модуль: `notifications` (`apps/api/src/modules/notifications/reminders.ts`, `sender.ts`; S1-15, S1-16). Таблицы: `notifications`, `push_subscriptions` (model-dannyh 0111). Вход – события K4; выход – Web Push.
Основа: 01 §14; 09 §3–6, §8–10, §13; 16 §2.6, §13, §15.3, §15.5; R-17; K4, K7, K8, K9.

## Подписки на события (K4 `subscribe`)

| Обработчик (`processed_events.handler`) | Событие | Что делает (в своей транзакции, без внешних вызовов) |
|---|---|---|
| `notifications.onBookingConfirmed` | `booking.confirmed` | 1) `booking_confirmed` (category `service`, `planned_at = $now`); 2) `reminder_day_before` – `planned_at = reminderDayBefore(start, tz, '21:00', createdAt)` (K8), `null` → не создаётся (R-17); 3) `reminder_before_start` – `reminderBeforeStart(start, 15, createdAt)`, `null` → не создаётся (01 §14 п.4). Времена – из K7 на момент события |
| `notifications.onBookingRescheduled` | `booking.rescheduled` | плановые строки `previous.version` в статусе `planned` → `skipped_booking_changed`; сервисное `booking_rescheduled` «было/стало» (09 §8); новые напоминания для `current.version` как выше |
| `notifications.onBookingCancelled` | `booking.cancelled` | плановые строки брони → `skipped_booking_changed`; при `cancelledBy='club'` – `booking_cancelled` (critical service, независимо от настроек, 09 §3.1, §8); при `client` – решение: не шлём (клиент сам отменил, видит в ЛК) |
| `notifications.onPrefsChanged` | `client.notification_prefs_changed` | `remindersEnabled=false` → все `planned` категории `reminder` клиента → `skipped_by_prefs` (09 §5.4) |

`dedupe_key = <kind>:<bookingId>:<bookingVersion>` – повтор события не создаёт вторую строку (`ON CONFLICT DO NOTHING`), одно напоминание на этап и версию (09 §6.4 п.7). Текст – без лишних ПДн: «Ю-Клуб», дата и время **по филиалу** (`formatLocal`), город, филиал, ресурс, ссылка в ЛК (09 §6.3).

## Отправка (задачи pg-boss)

- `notifications:dispatch` – раз в 30 с: `SELECT ... WHERE status='planned' AND planned_at <= $now ORDER BY planned_at LIMIT 200 FOR UPDATE SKIP LOCKED` → `queued` и задача `notifications:send` с `singletonKey = notificationId`.
- `notifications:send(id)`:
  1. Транзакция А: строка `FOR UPDATE`; статус не `queued` → выход. Повторная проверка (09 §6.4): бронь есть; не отменена; `current_version = booking_version` и время не изменилось; клиент тот же; для `reminder` – `remindersEnabled`; есть активная подписка; этот `dedupe_key` ещё не `sent_to_provider`. Не прошло → `skipped_booking_changed` / `skipped_by_prefs` / `no_channel` (16 §15.5: бронь не страдает). Прошло → `sending`, `attempts + 1`, фиксация.
  2. Вне транзакции: `web-push` по каждой активной подписке клиента, TTL 1 ч для напоминания −15 мин и 12 ч для остальных (решение), заголовок `Topic = dedupe_key` (повтор заменяет, а не дублирует на устройстве).
  3. Транзакция Б: хотя бы одна подписка `201/202` → `sent_to_provider`, `sent_at`; `404/410` → подписка `revoked('gone')`; все подписки ушли → `no_channel`; `429/5xx`/тайм-аут → `error` при исчерпании `notifications.push_retry_limit` (K7), иначе обратно `queued` с задержкой 1, 5, 15 мин. Аудит `notification.sent` / `failed` / `skipped` (K2, системный актор).
- Статус `delivered` не ставится: Web Push не подтверждает показ (09 §9).
- Тайм-аут шага 2 = неизвестный исход: повтор допустим, потому что `Topic` схлопывает дубль на устройстве; это принятый риск (ADR 0004 §2).
- Просроченное: `reminder_before_start` с `planned_at` старше начала сеанса – `skipped_booking_changed` (после начала не шлём, 09 §6.2).

## Функции модуля (`notifications/index.ts`)

```ts
/** Для карточки брони и клиента в CRM (01 §14 п.6), в пределах прав K1 'notifications.view'. */
export function listForBooking(db: Db, ctx: AccessContext, bookingId: string): Promise<NotificationView[]>;
export function listForClient(db: Db, ctx: AccessContext, clientId: string, page: Cursor): Promise<Page<NotificationView>>;
/** Ручной повтор критичного сервисного с ошибкой (09 §10, 16 §15.3) – Э4; в Э1 только просмотр. */
```

**Э4 (внесено S4-00 04.11.2026).** Отправку и решение об отправке Э4 дополняет K21 §7: `send` вызывает единую `decideSend` (K21 §2) для не-брони, у `marketing` – тихие часы и частота под `pg_advisory_xact_lock`, payload с `unsubscribeUrl`, две очереди `dispatch` (сервисные впереди рекламы, K21 §6), новые статусы `skipped_by_frequency` и `inbox_only` (0401). Ручной повтор – K21 §9. Правила этого файла для броней (повторная проверка версии, `dedupe_key`, `Topic`, повторы 1/5/15 мин) не меняются – TC-11 и TC-18 остаются регрессией S4-16.

## Проверка (S1-15, S1-16)

TC-18: перенос → старые `skipped_booking_changed`, новые запланированы; отмена клубом → `booking_cancelled` уходит при выключенных напоминаниях; бронь 14.11 21:30 на 15.11 → нет `reminder_day_before`; бронь за 10 мин → нет `reminder_before_start`; двойная доставка события → одна строка; провайдер `410` → подписка отозвана, статус `no_channel`; `fixedClock` двигает время, база получает тот же `$now`.
