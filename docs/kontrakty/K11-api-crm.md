# K11. API CRM: календарь, списки, брони администратора

Схемы: `packages/contracts/src/crm/*.ts` (Zod 4) → OpenAPI. Сервер: `apps/api/src/modules/booking/routes.crm.ts` (S1-13; маршруты Э2 – раздел «Маршруты Э2»), `modules/network/routes.ts` (S0-11), `modules/resources/routes.ts` (S1-01). Потребители: `apps/crm` (S0-14…S0-15, S1-22…S1-25).
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

## Маршруты Э2 (внесено S2-00 02.11.2026)

Номера продолжают таблицу выше; полные описания – в контрактах-владельцах, правила «Общее» действуют без изменений (IDOR → `404`, `Idempotency-Key` у изменяющих).

| № | Раздел | Контракт | Модуль, файл |
|---|---|---|---|
| 19–23 | оплата сеанса, возврат, «к оплате», статусы для календаря | K10 §11 | `finance`, `routes.payments.ts` (S2-22) |
| 24–28 | бонусный счёт клиента, корректировка, товары за баллы | K15 §11 | `loyalty`, `routes.crm.ts` (S2-40) |
| 29–36 | сертификаты: список, карточка, продажа, отмена, корректировка, «требует проверки», получатель, проверка по коду | K16 §11 | `certificates`, `routes.crm.ts` (S2-53) |
| 37–48 | касса: журнал, предпросмотр, начальный остаток, доход, расход, изъятие, перевод между местами, сторно, исправление, категории, закрытие месяца, сводка | K17 §10 | `finance`, `routes.crm.ts` (S2-14, S2-15) |
| 49–50 | кассовая смена | K17 §10 | `finance`, `routes.crm.ts` (S2-17) |
| 51–54 | настройки: действующие значения области, изменение с даты, возврат к наследованию, история | K7 «HTTP CRM» | `settings`, `routes.crm.ts` |
| 55–56 | кассовая смена: текущая и флаг, список смен (Администратору – свои, без сумм) | K17 §10 | `finance`, `routes.crm.ts`, `shift.ts` (S2-62) |

**Изменение №4 в Э2 (K15 §8, S2-35):** тело `CrmCreateBooking` получает необязательное `overrideLoyaltyLimit: { reason: string }`. Клиент с балансом ≤ −50 без поля → `403 LOYALTY_LIMIT_REACHED`; с полем – только при праве `loyalty.book_below_limit` (Владелец, Директор), иначе `403 FORBIDDEN`; причина пишется в аудит брони (R-13). Администратор обойти не может.

`CrmBooking` в Э2 не получает полей оплаты (ADR 0002 п.1: статус оплаты живёт в `finance`): карточка брони читает №19, календарь – №23.

## Маршруты Э3 (внесено S3-00 04.11.2026)

Номера Э3 – 3xx (Э4 – 2xx, сход С23); полные описания – в контрактах-владельцах, правила «Общее» без изменений.

| № | Раздел | Контракт | Модуль, файл |
|---|---|---|---|
| 301–310 | смены: список, создать, изменить, отменить, приход/уход, факт, покрытие, мои изменения, ставки, «временно не работает» | K18 §14 | `shifts`, `routes.crm.ts` (S3-14) |
| 311–318 | зарплата: периоды, расчёт, ведомости, выплата, расход выплаты, штрафы, корректировки, отчёт | K18 §14 | `shifts`, `routes.payroll.ts` (S3-20, S3-21) |
| 331–337 | оборудование: список, карточка, статус, перемещение, история мест, учётки, категории | K19 §14 | `equipment`, `routes.crm.ts` (S3-33) |
| 341–349 | ремонт: список, регистрация, карточка, статусы и согласование, блокировки, закрытие, расход, гарантии, исполнители | K19 §14 | `equipment`, `routes.repairs.ts` (S3-39) |
| 350 | вложения: загрузка телом запроса, выдача, «недействителен» | K19 §14, §9 | `attachments`, `routes.crm.ts` (S3-07) |
| 361–370 | мероприятия: список, карточка, статусы, состав и пакеты, ресурсы и перенос, связанные брони, чек-лист, деньги, справочники | K20 §15 | `events`, `routes.crm.ts` (S3-55) |
| 376–379 | подарки: список, выдача, отмена, окна, запись; праздничный календарь | K20 §15 | `events`, `routes.gifts.ts` (S3-60); календарь – `network` (S3-56) |
| 380–382 | делегирование: выдать, отозвать, список (только Владелец) | K1 «Делегирование» | `staff`, `routes.crm.ts` (S3-89) |
| П1–П5 | публичные: мои подарки и окна, удержание подарка, мои мероприятия, заявка на праздник, сведения о празднике | K20 §15 | `events`, `routes.gifts.ts`, `routes.public.ts` (S3-60, S3-61) |

`timeline` карточек Э3 (смена, ремонт, мероприятие) – из аудита K2 (`objectTimeline`); суммы зарплаты и ставки в нём без `payroll.view` маскируются (K18 §10).
## Маршруты Э4 (внесено S4-00 04.11.2026)

Номера 201–250; маршруты Э3 – №3xx (K18–K20, вложения №350), пересечения нет. Полные описания – в контрактах-владельцах, правила «Общее» действуют без изменений (IDOR → `404`, `Idempotency-Key` у изменяющих, `row_version` у черновиков и кампаний).

| № | Раздел | Контракт | Модуль, файл (шаг) |
|---|---|---|---|
| 201–209 | кампании (список, создание, карточка, правка черновика, предпросмотр аудитории, подтверждение с `expectedTotal`, отмена), журнал строк уведомлений, ручной повтор критичного сервисного | K21 §11 | `notifications`, `routes.crm.ts` (S4-18) |
| 210–211 | шаблоны уведомлений | K21 §8, §11 | `notifications`, `routes.crm.ts` (S4-18) |
| 212 | сводка уведомлений в карточке клиента | K21 §9, §11 | `notifications`, `routes.crm.ts` (S4-18) |
| 213–218 | публикации: список, создание, карточка, черновик, `publish`/`unpublish`/`archive`/`rollback`, версии | K22 §13 | `content`, `routes.crm.publications.ts` (S4-38) |
| 219–223 | каталог игр и доступность по филиалам, страницы комнат и филиалов, страницы по ключу (юридические – `content.legal.publish`) | K22 §13 | `content`, `routes.crm.catalog.ts` (S4-39) |
| 224–227 | медиатека: загрузка (multipart, 10 МБ, путь через CRM – S4-09), список, `alt`/архив, где используется, физическое удаление | K22 §8, §13 | `content`, `routes.media.ts` (S4-31) |
| 228 | блоки главной и их порядок | K22 §13 | `content`, `routes.crm.catalog.ts` (S4-39) |
| 229–232 | резерв (комментарии к черновикам, шаблоны блоков – не в Э4) | K22 §13 | – |
| 233 | токен предпросмотра черновика | K22 §11 | `content`, `routes.crm.publications.ts` (S4-38) |
| 234–235 | резерв | – | – |
| 236–238 | слаги: черновой транслит, проверка, история адреса | K23 §8 | `content`, `routes.crm.catalog.ts` (S4-58) |
| 239–242 | отчёты: дашборд, отчёт, детализация (`total` = агрегат), календарь загрузки единицы | K24 §10 | `reports`, `routes.crm.ts` (S4-70) |
| 243–247 | экспорт: постановка, свои задачи, задача, файл (`attachment`, `no-store`, права на момент скачивания), отмена | K24 §7, §10 | `reports`, `routes.crm.export.ts` (S4-73) |
| 248 | запуски и расхождения ночной сверки (`audit.view`) | K24 §10 | `reports`, `routes.crm.ts` (S4-70) |
| 249 | резерв | – | – |
| 250 | глобальный поиск (`search.global`; тип без права в ответе отсутствует) | K24 §5 | `reports`, `routes.crm.ts` (S4-75) |

Загрузка тел больше 2 МБ (№224 и вложения Э3 №350) – отдельные маршруты Caddy с 11 МБ и потоковая передача тела прокси CRM (S4-09); остальные маршруты – прежние 2 МБ. Ошибки Э4 – K21 §12, K22 §14, K23 §3, K24 §10 (`COMMENT_REQUIRED` из таблицы ниже переиспользуется очисткой медиа S4-45).

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
