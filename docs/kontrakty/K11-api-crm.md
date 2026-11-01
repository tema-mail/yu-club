# K11. API CRM: календарь, списки, брони администратора

Схемы: `packages/contracts/src/crm/*.ts` (Zod 4) → OpenAPI. Сервер: `apps/api/src/modules/booking/routes.crm.ts` (S1-13), `modules/network/routes.ts` (S0-11), `modules/resources/routes.ts` (S1-01). Потребители: `apps/crm` (S0-14…S0-15, S1-22…S1-25).
Основа: 01 §10.2, §11–13, §15; 04 §5, §8, §12; 13 §7, §10; 16 §15.4; 17 §4.1, §4.4; K1, K5, K6, K9.

## Общее

- База: `${API_URL}/api/crm/v1`. Вход – кука `yu_staff` (K12). Каждый маршрут регистрируется `crmRoute({ method, url, action, target, schema, handler })` – без `action` не регистрируется (ADR 0005).
- Права: `loadAccess` на каждый запрос (K1); цель берётся из пути (`branchId`) или из загруженного объекта (бронь → её `branch_id`, клиент → `{ clientId }`). Объект вне зоны – `404`, тело как у несуществующего.
- Время – ISO UTC; в ответе у каждого объекта филиала – `timezone`, CRM показывает время **филиала**, не браузера (S1-22).
- Изменяющие маршруты – `Idempotency-Key` обязателен (ADR 0004); редактирование карточек – `row_version` в теле, устарело → `409 VERSION_CONFLICT` с `details.current` (16 §15.4).
- Списки: курсорная пагинация `?cursor=&limit=` (`limit` 1..100, по умолчанию 50), порядок фиксирован для каждого списка, `total` – только если ≤ 10 000 (решение, 17 §4.4); фильтр зоны – `scopeFilter` в SQL.
- Ошибки – тело ADR 0002, коды K1, K5, K6 и ниже.

## Маршруты Э0–Э1

| # | Метод и путь | Право (K1) | Тело / параметры | Успех |
|---|---|---|---|---|
| 1 | `GET /me` | – | – | `200 { staff: { id, firstName, lastName, role }, access: { network, cityIds, branchIds }, actions: Action[] }` – меню строится по `actions`, но защита – на сервере |
| 2 | `GET /branches/{branchId}/calendar?from=&to=&resourceIds=` | `schedule.view` | `from`/`to` – LocalDate, ≤ 7 дней | `200 { branchId, timezone, openIntervals[], resources: [{ id, name, type, roomName }], items: CalendarItem[] }` за ≤ 3 с (17 §4.1) |
| 3 | `GET /branches/{branchId}/bookings?date=&status=&needsDecision=` | `schedule.view` | `needsDecision=true` – прошедшие `confirmed` без отметки (R-08) | `200 { items: CrmBookingRow[], nextCursor }`, порядок `(start, number)` |
| 4 | `POST /branches/{branchId}/bookings` | `booking.create` | `CrmCreateBooking` (K9) | `201 CrmBooking` |
| 5 | `GET /bookings/{bookingId}` | `schedule.view` | – | `200 CrmBooking` + `timeline: AuditEventView[]` (K2 `objectTimeline`) |
| 6 | `POST /bookings/{bookingId}/cancel` | `booking.cancel` | `{ rowVersion, initiator: 'club' \| 'client_by_phone', reasonId, comment }` – `comment` обязателен (01 §12) | `200 CrmBooking` |
| 7 | `POST /bookings/{bookingId}/reschedule` | `booking.reschedule` | `{ rowVersion, resourceId, start, end, reason }` | `200 CrmBooking` (новая версия) |
| 8 | `POST /bookings/{bookingId}/arrive` | `booking.visit.mark` | `{ rowVersion }` | `200 CrmBooking` `status:'arrived'` |
| 9 | `POST /bookings/{bookingId}/complete` | `booking.visit.mark` | `{ rowVersion }` | `200` `status:'completed'` |
| 10 | `POST /bookings/{bookingId}/no-show` | `booking.visit.mark` | `{ rowVersion, reasonId? }` | `200` `status:'no_show'` |
| 11 | `POST /bookings/{bookingId}/revert-visit` | `booking.visit.correct` | `{ rowVersion, reason }` – из `arrived`/`no_show` в `confirmed` | `200` |
| 12 | `PATCH /bookings/{bookingId}` | `booking.create` | `{ rowVersion, internalComment }` | `200` |
| 13 | `POST /branches/{branchId}/blocks` | `block.manage` | `{ target: { type, ids }, start, end, reasonId, comment? }` | `201 { block, affectedBookings: CrmBookingRow[] }` (K6 `createBlock`) |
| 14 | `POST /blocks/{blockId}/lift` | `block.manage` | `{ rowVersion, comment? }` | `200` |
| 15 | `GET /clients?q=&branchId=&cursor=` | `client.view.basic` | K9 `searchClients` | `200 { items, nextCursor }`, телефон маскирован (03 §14) |
| 16 | `GET /clients/{clientId}` | `client.view.basic` / `.full` | – | `200` карточка: состав полей по праву; без `.full` – записи только своей зоны (04 §8.3) |
| 17 | `PATCH /clients/{clientId}` | `client.update.limited` / `client.update` | `{ rowVersion, ...поля }` – поля вне права → `403` | `200` |
| 18 | сеть, справочники, ресурсы, график, исключения | `network.*`, `resources.*`, `dictionary.manage`, `network.hours.manage` | CRUD по K13 | стандартный `EntityList`/`EntityCard` (S0-15) |

```ts
interface CalendarItem {
  kind: 'booking' | 'hold' | 'block';
  id: string; resourceIds: string[]; start: Iso; end: Iso;
  booking?: { number: number; status: BookingStatus; clientName: string; phoneMasked: string; needsDecision: boolean };
  hold?: { expiresAt: Iso };             // без данных посетителя
  block?: { reasonName: string };
}
interface CrmBookingRow { id: string; number: number; status: BookingStatus; resourceName: string; start: Iso; end: Iso;
  client: { id: string; name: string | null; phoneMasked: string; isGuest: boolean }; source: 'site' | 'crm'; rowVersion: number }
interface CrmBooking extends CrmBookingRow {
  branchId: string; timezone: string; resourceId: string; currentVersion: number; priceKop: number;
  internalComment: string | null; cancel: { at: Iso; by: string; reasonName: string; comment: string } | null;
  versions: Array<{ version: number; resourceName: string; start: Iso; end: Iso; priceKop: number; createdAt: Iso; reason: string | null }>;
  allowedActions: Array<'cancel' | 'reschedule' | 'arrive' | 'complete' | 'no_show' | 'revert_visit'>;   // считает сервер
}
```

## Правила команд над бронью (№6–12)

Одна транзакция, по порядку:
1. `const now = clock.now()`; `SELECT ... FROM bookings WHERE id = $1 FOR UPDATE`; нет или вне зоны → `404`.
2. `row_version` ≠ переданному → `409 VERSION_CONFLICT` (форма устарела, 16 §15.4).
3. Переход статуса разрешён `dict_status_transitions` (model-dannyh 0109), иначе `409 INVALID_STATUS_TRANSITION` с `details.from`, `details.to`.
4. Изменение: отмена – `release` строк своей брони (K6, `cancelled`), соседние брони не трогаются (18 §5.3 п.5–6); перенос – K6 `release(rescheduled)` + `occupy` новой версии одним INSERT + `booking_versions(v+1)`; ошибка занятия → откат, старая версия действует (01 §11); приход – `visits` (`visits_one_active_idx` гасит повтор, 16 §5); неявка – `no_shows`.
5. `row_version = row_version + 1`, аудит (K2), событие (K4), фиксация.

Отмена клубом – `cancelled_by_club`; отмена по звонку клиента (`initiator:'client_by_phone'`) – `cancelled_by_client`, автор – сотрудник; комментарий обязателен в обоих (01 §12). Подтверждение «было/стало» показывает CRM до вызова (13 §10), сервер его не требует.

Создание (№4) не обходит проверки доступности и пересечений (01 §9 п.6, §10.2): те же шаги, что K5 confirm, кроме удержания; принудительного исключения нет.

## Ошибки (сверх K1, K5, K6)

| Код | HTTP | Когда |
|---|---|---|
| `VERSION_CONFLICT` | 409 | устаревший `rowVersion` |
| `INVALID_STATUS_TRANSITION` | 409 | переход не разрешён |
| `COMMENT_REQUIRED` | 422 | отмена без комментария, исправление без причины |
| `RANGE_TOO_LONG` | 422 | календарь > 7 дней |

## Проверка

Генерируемый тест IDOR: каждый маршрут таблицы с `branchId`/`bookingId`/`clientId` чужой зоны → `404` с телом, равным `404` несуществующего. Двойной клик «Отменить» (тот же ключ) → одна отмена; два сотрудника с одним `rowVersion` → второй `VERSION_CONFLICT`. Календарь CRM и K5 availability на одних данных совпадают по занятым интервалам (18 §5.5).
