# K5. Публичный API записи

Схемы: `packages/contracts/src/booking.ts` (Zod 4) → OpenAPI. Сервер: `apps/api/src/modules/booking/routes.public.ts` (S1-08). Потребители: сайт (П6: острова `BranchPicker`, `Schedule`, `HoldTimer`, `Checkout`), ЛК (П5), контракт-тест `tests/contracts/booking.contract.test.ts`.
Основа: 01 §6–10, §12, §15.1; 16 §3, §15; 17 §4.1, §10; 12 §4.3; ADR 0002 (ошибки), 0003 (время), 0004 (идемпотентность).

## Общее

- База: `${API_URL}/api/public/v1`. JSON, UTF-8. Время – ISO 8601 UTC с `Z` (`2026-11-15T07:00:00Z`); локальные даты филиала – `YYYY-MM-DD`; деньги – целые копейки (`priceKop`).
- **Кто вызывает.** Кука `yu_visitor` (HttpOnly, Secure, SameSite=Lax, 1 год, uuid) ставится сервером только на `GET /branches/{id}/availability` (booking), если её нет; `GET /branches/{id}` остаётся общим и кэшируемым (решение координатора 01.11) (чтобы состояние `mine` и удержание работали с первого клика). `POST /holds` без куки → `400 VISITOR_REQUIRED` (сайт повторяет после GET; решение по ревью п.6). Кука `yu_client` – сессия клиента (K9). Удержание принадлежит посетителю или клиенту; при входе удержание посетителя переходит к клиенту (`POST /holds/{id}/attach`, ниже).
- **Идемпотентность**: заголовок `Idempotency-Key: <uuid>` обязателен у всех `POST` этого контракта (ADR 0004). Повтор → тот же ответ и `Idempotent-Replay: true`; тот же ключ с другим телом → `409 IDEMPOTENCY_KEY_REUSED`. Клиент сайта генерирует ключ на одно нажатие и повторяет **с тем же ключом** при обрыве сети (16 §15.1).
- **CSRF**: для `POST/DELETE` с кукой – заголовок `X-Requested-With: yu-site` + проверка `Origin ∈ {PUBLIC_SITE_URL}` (решение).
- **Ошибка**: `{ "error": { "code": string, "message": string, "details"?: object, "requestId": string } }`.
- Чужие данные не раскрываются: занятость показывается состоянием слота без «кем» (17 §7.2).
- Лимиты (решение по ревью п.6): `/holds*` – 30 запросов/мин на посетителя **и** 60/мин на IP (кука сбрасывается, IP – нет); `/availability` – 120/мин на IP; иначе `429 RATE_LIMITED`. Потолок одновременных **анонимных** удержаний на филиал – `booking.max_anonymous_holds_per_branch` (K7, по умолчанию 30): сверх → `429 RATE_LIMITED` для новых анонимных, у вошедших клиентов потолка нет (у них ≤ 1 удержания на филиал). Так бот без входа не займёт всё расписание.

## Типы ответа (TypeScript, выводятся из Zod)

```ts
type Iso = string;          // UTC
type LocalDate = string;    // 'YYYY-MM-DD' по зоне филиала

interface CityDto   { id: string; slug: string; name: string; timezone: string }
interface BranchDto {
  id: string; cityId: string; slug: string; name: string; address: string; timezone: string;
  status: 'active' | 'temporarily_closed';            // 'preparing' и 'archived' не отдаются (15 §5.3)
  phone: string | null; publicContacts: Record<string, string>;
  bookingWindow: { defaultDays: number; maxDays: number };   // из K7 на сейчас
  holdMinutes: number;
}
interface ZoneDto { code: 'pc' | 'vr' | 'ps'; name: string }   // группировка для сайта (12 §7)
interface ResourceDto {
  id: string; branchId: string; roomId: string | null; roomName: string | null;
  roomSlug: string | null;                             // rooms.slug – адрес карточки комнаты на сайте, английскими словами (карта сайта п.5)
  type: 'pc' | 'vr_seat' | 'ps_room' | 'room_whole' | 'composite';
  zone: ZoneDto['code']; name: string; stepMinutes: number;
  selfBookable: true;                                  // несамостоятельные (PS4) не отдаются вовсе (01 §5.2)
}

type SlotState = 'free' | 'mine' | 'held' | 'booked' | 'blocked' | 'closed';   // 6 состояний 01 §6.3
interface SlotDto { start: Iso; end: Iso; state: SlotState }
interface ResourceDayDto { resourceId: string; slots: SlotDto[] }     // слоты длиной stepMinutes ресурса
interface AvailabilityDto {
  branchId: string; date: LocalDate; timezone: string;
  dayState: 'open' | 'closed' | 'outside_window';      // 'closed' → сайт пишет «Филиал не работает» (01 §4.1 п.6)
  openIntervals: { start: Iso; end: Iso }[];           // рабочие часы с учётом исключений
  resources: ResourceDayDto[];
  generatedAt: Iso;                                     // данные устаревают; окончательное решение – сервер (17 §10)
}

interface HoldItemDto { id: string; resourceId: string; resourceName: string; start: Iso; end: Iso; priceKop: number | null }
interface HoldDto {
  id: string; branchId: string; status: 'active' | 'converted' | 'expired' | 'released';
  expiresAt: Iso; serverNow: Iso;                      // таймер на сайте = expiresAt − serverNow, не локальные часы (01 §7.4)
  items: HoldItemDto[];
  totalKop: number | null;                             // null, если какой-то позиции нет тарифа (тогда confirm даст TARIFF_NOT_CONFIGURED)
  owner: 'visitor' | 'client';
}

interface BookingDto {
  id: string; number: number; branchId: string; branchName: string; branchAddress: string; timezone: string;
  resourceId: string; resourceName: string; start: Iso; end: Iso; durationMinutes: number;
  priceKop: number; paymentNote: 'pay_at_club';        // «оплата в клубе» (01 §10.1, 18 §2)
  status: 'confirmed' | 'arrived' | 'completed' | 'no_show' | 'cancelled_by_client' | 'cancelled_by_club';
  canCancel: boolean;                                   // считает сервер (R-12)
}
interface ConfirmResultDto { checkoutId: string; bookings: BookingDto[] }
```

## Маршруты

| # | Метод и путь | Кто | Тело / параметры | Успех |
|---|---|---|---|---|
| 1 | `GET /cities` | все | – | `200 { items: CityDto[] }` – города с хотя бы одним `active`/`temporarily_closed` филиалом |
| 2 | `GET /branches?city={slug}` | все | `city` необязателен | `200 { items: BranchDto[] }` |
| 3 | `GET /branches/{branchId}` | все | – | `200 BranchDto & { hoursToday: { start: 'HH:mm'; end: 'HH:mm' }[] }` – расширение: часы сегодня по местному времени филиала (openIntervals с исключениями календаря; пусто – сегодня закрыт); `preparing`/`archived` → `404` |
| 4 | `GET /branches/{branchId}/resources?zone=` | все | `zone` – `pc`/`vr`/`ps` | `200 { items: ResourceDto[] }` |
| 5 | `GET /branches/{branchId}/availability?date=&resourceIds=` | все | `date` LocalDate обязателен; `resourceIds` – через запятую, ≤ 50, иначе все | `200 AvailabilityDto` за ≤ 2 с (17 §4.1) |
| 6 | `POST /holds` | visitor / client | `{ branchId, items: [{ resourceId, start, end }] }` (1..10 позиций) | `201 HoldDto` – **все или ничего** для первой порции |
| 7 | `GET /holds/{holdId}` | владелец удержания | – | `200 HoldDto` (истёкшее → `status:'expired'`, слоты пусты, 01 §7.4) |
| 8 | `POST /holds/{holdId}/items` | владелец | `{ resourceId, start, end }` | `200 HoldDto` с новым `expiresAt` (общий таймер перезапущен, 01 §7.2) |
| 9 | `DELETE /holds/{holdId}/items/{itemId}` | владелец | – | `200 HoldDto` (таймер не меняется); последняя позиция → удержание `released` |
| 10 | `POST /holds/{holdId}/release` | владелец | – | `200 HoldDto` `status:'released'` |
| 11 | `POST /holds/{holdId}/attach` | client (после входа) | – | `200 HoldDto` `owner:'client'`; проверка пересечений клиента по всем позициям |
| 12 | `POST /holds/{holdId}/confirm` | client | `{ comment?: string ≤ 500 }` (клиентский комментарий не нужен в MVP – поле зарезервировано) | `201 ConfirmResultDto` |
| 13 | `POST /bookings/{bookingId}/cancel` | client – только своя | `{ reason?: string ≤ 300 }` (01 §12: причина клиенту не обязательна) | `200 BookingDto` `status:'cancelled_by_client'` |

Списки ЛК («мои записи») – в K9. Маршруты CRM (календарь, бронь/отмена/перенос администратором) – в K11.

**Э2 (внесено S2-00 02.11.2026).** Публичные маршруты баллов – K15 §11 (`GET /me/loyalty`, `GET /me/loyalty/history`, `POST`/`DELETE /holds/{holdId}/points-reserve`, `GET /goods`), сертификатов – K16 §8 (`GET /me/certificates`, `GET /me/certificates/{number}/history`). Оплаты на сайте в Э2 нет (K10 §1, Q-20): `BookingDto.paymentNote` остаётся `'pay_at_club'`. Резерв баллов живёт столько же, сколько удержание (K15 §3): таймер `HoldDto.expiresAt` – и срок резерва, отдельного поля нет. «Оплатить баллами» на шаге оформления – только резерв; списание – при оплате в клубе (K10).

**Э4 (внесено S4-00 04.11.2026).** Номера 201–217 (Э3 публичных маршрутов не добавляет; пересечения нет). Полные описания – в контрактах-владельцах, общие правила этого файла действуют без изменений (база `/api/public/v1`, коды ошибок ADR 0002, `Idempotency-Key` у изменяющих).

| № | Маршруты | Сессия | Контракт | Модуль, файл (шаг) |
|---|---|---|---|---|
| 201–204 | центр уведомлений ЛК: список, счётчик непрочитанных (`no-store`), прочтение одного и всех | кука `yu_client` | K21 §11 | `notifications`, `routes.public.ts` (S4-11) |
| 205–206 | отписка от рекламы по ссылке: проверка токена, `POST /unsubscribe`; 10 запросов в минуту с IP | без сессии | K21 §4, §11 | `notifications`, `unsubscribe.ts` (S4-19) |
| 207–215 | контент: главная, публикации (список и страница), игры (каталог и карточка), страницы по ключу, страницы комнат и филиалов, живые версии юридических документов; только живые версии, `Cache-Control: public, max-age=60`, `ETag` | без сессии | K22 §12 | `content`, `routes.public.ts` (S4-37) |
| 216 | `GET /redirects/resolve?path=` – 301 по истории адресов | без сессии | K23 §5, §8 | `content`, `routes.public.ts` (S4-53) |
| 217 | `GET /seo/sitemap-entries` – индексируемые сущности контента с `lastmod` | без сессии | K23 §7, §8 | `content`, `routes.public.ts` (S4-53, S4-56) |

Ошибки Э4 – в контрактах-владельцах (K21 §12, K22 §14, K23 §3). Новые коды для сайта: `UNSUBSCRIBE_TOKEN_INVALID` (400), `UNSUBSCRIBE_TOKEN_EXPIRED` (410), `MARKETING_DOCUMENT_MISSING` (409, K9). Черновики контента публичными маршрутами не отдаются по построению (K22 §3); предпросмотр – внутренний маршрут `GET /api/internal/v1/content/preview/{token}` (K22 §11), в нумерацию K5 не входит и на публичном домене отвечает `404` (S4-07).

### Поведение ключевых маршрутов

**6. `POST /holds`** – одна транзакция:
0. `const now = clock.now()` – один раз на команду (ADR 0003 п.10).
1. Филиал `active` (иначе `BRANCH_NOT_ACTIVE`); каждая позиция: ресурс самостоятельный, `active`, комната `active`; локальная дата начала в окне `[сегодня, сегодня + maxDays)` по зоне филиала (K8: `maxDays=30` → сегодня и 29 следующих; так же `defaultDays=7` → сегодня + 6 для показа по умолчанию) и `start > now` – иначе `OUTSIDE_BOOKING_WINDOW`; `start`, `end` выровнены по шагу, `end − start ≥ шаг`, не через полночь (ADR 0003); внутри открытых интервалов дня (K6 + календарь).
2. `releaseExpiredHolds(tx, now, …)` на затрагиваемых единицах (K6).
3. `occupy` (K6): `FOR SHARE` единиц → блокировки (`RESOURCE_BLOCKED`) → один INSERT всех строк в порядке `unit_id`.
4. Вставка `holds` (`expires_at = now + ttl`), `hold_items`, строки `occupancy` (`hold_expires_at = expiresAt`), при известном клиенте – `client_time`.
5. Нарушение `occupancy_no_overlap` → выясняем, с чем конфликт: `SLOT_TAKEN` (бронь/мероприятие) или `SLOT_HELD` (чужое удержание); нарушение `client_time_no_overlap` → `CLIENT_OVERLAP`. Всё откатывается, `details.items[]` называет каждую неудачную позицию.
6. `hold.created` (K4).
У клиента одновременно ≤ 1 активного удержания на филиал: новое `POST /holds` при активном → `HOLD_ALREADY_ACTIVE` с `details.holdId` (решение – слоты добавляются в существующее через №8).

**8. Добавить слот** – как п.1–5 для одной позиции; при успехе `expiresAt = now + ttl` у удержания и **всех** его строк `occupancy`/`client_time` (01 §7.2). При отказе уже удержанные позиции и их таймер не меняются (01 §7.2 абзац 2), ответ – ошибка с `details.items[0]`.

**12. Подтвердить** – одна транзакция, `SELECT holds ... FOR UPDATE`:
1. Удержание `active` и `expiresAt > $now` (иначе `HOLD_EXPIRED`; если уже `converted` тем же клиентом – вернуть прежний результат, это повтор без ключа).
2. Восемь проверок 01 §8.2 заново по каждой позиции: филиал, график, ресурс, пересечения с бронями (строки удержания живы), активность удержания, блокировки и ремонт, ограничения клиента (`clients.assertCanBook`: статус `blocked`/`restricted` → `CLIENT_RESTRICTED`; с Э2 – ворота loyalty: баланс ≤ −50 → `LOYALTY_LIMIT_REACHED`, 07 §9.2, K15 §8), совместимость состава (`unit_ids` удержания = текущий состав ресурса, иначе `COMPOSITE_CHANGED`).
3. Цена – `pricing.quote` по каждой позиции (K6 §Цена: тариф филиал × тип × длительность) → нет тарифа `TARIFF_NOT_CONFIGURED`, два применимых – `TARIFF_AMBIGUOUS` (15 §9.3).
4. Позиции одного ресурса, идущие встык, сливаются в одну бронь; остальные – отдельные брони с общим `checkoutId` (решение).
5. Строки удержания переводятся в бронь `convertHoldItem` (K6): UPDATE … `RETURNING`, строк меньше, чем единиц, → `HOLD_EXPIRED` и откат – без окна, где слот свободен. `hold.status='converted'`.
6. `booking_versions(v1)` со снимками, аудит `booking.created`, событие `booking.confirmed` на каждую бронь.
Успех показывается на сайте **только после** `201` (D-07).

**13. Отмена клиентом** (R-12 по умолчанию): разрешена, пока `status='confirmed'` и `start > now`; деньги не трогаются (оплаты в Э1 нет). Строки занятости своей брони гасятся (`release_reason='cancelled'`) – соседние брони не задеваются (18 §5.3 п.5–6). Событие `booking.cancelled` с `cancelledBy:'client'`.

## Коды ошибок

`details.items[]` – для ошибок по позициям: `{ index, resourceId, start, end, code }`.

| Код | HTTP | Когда | Текст для клиента (пример) | Проверка 01 §8.2 |
|---|---|---|---|---|
| `VALIDATION_FAILED` | 400 | тело не по схеме | «Проверьте данные» + `details.fields` | – |
| `VISITOR_REQUIRED` | 400 | `POST /holds` без куки `yu_visitor` | – (сайт повторяет после GET) | – |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | нет заголовка | – | – |
| `AUTH_REQUIRED` | 401 | confirm/attach/cancel без сессии клиента | «Войдите, чтобы завершить запись» | – |
| `NOT_FOUND` | 404 | филиал/ресурс/удержание/бронь нет или чужое | «Не найдено» | – |
| `BRANCH_NOT_ACTIVE` | 409 | филиал не `active` | «Филиал сейчас не принимает записи» | филиал |
| `OUTSIDE_BOOKING_WINDOW` | 422 | дата вне окна или `start ≤ now` | «Запись доступна на N дней вперёд» | – |
| `OUTSIDE_SCHEDULE` | 409 | вне рабочих часов / день закрыт | «В это время филиал не работает» | график |
| `INVALID_DURATION` | 422 | не кратно шагу, короче шага, через полночь, `end ≤ start` | «Выберите время кратно 15/30 минутам» | – |
| `RESOURCE_UNAVAILABLE` | 409 | ресурс/комната не `active`, несамостоятельный (PS4, 01 §5.2), состав пуст | «Это место недоступно для записи» | ресурс |
| `RESOURCE_BLOCKED` | 409 | блокировка / ремонт | «Место временно недоступно» | блокировки |
| `SLOT_TAKEN` | 409 | подтверждённая бронь или мероприятие | «Это время уже занято» | пересечения |
| `SLOT_HELD` | 409 | чужое активное удержание | «Это время сейчас оформляет другой гость» | пересечения |
| `CLIENT_OVERLAP` | 409 | у клиента бронь/удержание на пересекающееся время (01 §9) | «У вас уже есть запись на это время» + `details.conflictBookingNumber` (только своя) | ограничения клиента |
| `CLIENT_RESTRICTED` | 403 | клиент `blocked`/`restricted` | «Запись временно недоступна, обратитесь в клуб» (внутренняя причина не раскрывается, 03 §8.3) | ограничения клиента |
| `LOYALTY_LIMIT_REACHED` | 403 | Э2: баланс баллов ≤ −50 при `POST /holds` и `/attach` известного клиента и при `/confirm` (K15 §8; S2-34, S2-35) | 07 §9.2: «Предварительная запись временно недоступна: баланс бонусных баллов достиг минимального значения −50. Обратитесь к администратору клуба» – причину не скрываем, клиент и так видит баланс в ЛК | ограничения клиента |
| `COMPOSITE_CHANGED` | 409 | состав конфигурации изменился с момента удержания | «Конфигурация изменилась, выберите заново» | совместимость |
| `HOLD_EXPIRED` | 410 | удержание истекло | «Время на оформление истекло, слоты освобождены» (01 §7.3) | активность удержания |
| `HOLD_ALREADY_ACTIVE` | 409 | у владельца уже есть активное удержание в филиале | – (`details.holdId`) | – |
| `HOLD_LIMIT_REACHED` | 422 | > 10 позиций в удержании (решение) | «Слишком много слотов в одной записи» | – |
| `TARIFF_NOT_CONFIGURED` | 422 | нет тарифа | «Запись на это время пока недоступна» (без 0 ₽, 15 §9.3) | (16 §3.1 «тариф настроен») |
| `TARIFF_AMBIGUOUS` | 422 | два тарифа одного приоритета | то же | то же |
| `BOOKING_NOT_CANCELLABLE` | 409 | отмена не из `confirmed` или после начала | «Эту запись уже нельзя отменить онлайн» | – |
| `IDEMPOTENCY_KEY_REUSED` | 409 | тот же ключ, другое тело | – | – |
| `RATE_LIMITED` | 429 | лимит | «Слишком много запросов, подождите минуту» | – |
| `INTERNAL` | 500 | прочее | «Что-то пошло не так, попробуйте ещё раз» | – |
| `SERVICE_UNAVAILABLE` | 503 | база недоступна | «Сервис временно недоступен» (17 §6.3) | – |

Соответствие 12 состояниям интерфейса 01 §15.1: загрузка/загружен/нет слотов – `AvailabilityDto`; удерживается/скоро истечёт/истекло – `HoldDto.expiresAt` и `HOLD_EXPIRED`; конфликт – `SLOT_TAKEN`/`SLOT_HELD`/`CLIENT_OVERLAP`; ошибка загрузки – `5xx`; нет прав – `401/403`; заблокирован – `RESOURCE_BLOCKED`/`state:'blocked'`; отменена – `status:'cancelled_*'`; создана – `201 ConfirmResultDto`.

## Контракт-тест (S1-08)

На живом сервере с засеянными данными (S1-28): каждый маршрут × успех; каждый код ошибки вызывается минимум одним сценарием; `Idempotency-Key` повтор → тот же `201` и `Idempotent-Replay`; ответ проходит Zod-схему из `packages/contracts` (тот же файл импортирует сайт); удержание чужого посетителя → `404`; в ответах нет телефонов и имён других клиентов.
