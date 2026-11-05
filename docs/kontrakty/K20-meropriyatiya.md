# K20. Мероприятия, платный праздник, подарок имениннику

Статус: контракт Э3 (04.11.2026), черновик до ревью архитектуры (шаг S3-00). Модуль-владелец: `events` (`apps/api/src/modules/events/*`: `events.ts`, `lines.ts`, `resources.ts`, `checklist.ts`, `money.ts`, `gifts.ts`, `gift-booking.ts`, `routes.crm.ts`, `routes.gifts.ts`, `routes.public.ts`). Праздничный календарь – `network` (`modules/network/holidays.ts`). Таблицы: `event_types`, `event_packages`, `events`, `event_lines`, `event_checklist`, `event_resources`, `event_bookings` (`0305_events.sql`), `holiday_dates` (`0308_holidays.sql`), `birthday_gifts`, `gift_uses` (`0309_gifts.sql`).
Основа: 11 §2–§17; 20 §4.10, §4.11, §5 «День рождения», «Подарок имениннику», TC-13, TC-14, R-09, R-10, R-11, R-22; 16 §8.4, §9, §10; 15 §6.4; 19 §4.7; 18 §7.2 п.15–16, §7.4; K4, K5, K6, K9, K10, K15, K17.

Пометки: «по умолчанию, ждёт заказчика (Q-xx)» – умолчание плана; «решение» – вывод архитектора; **«по 20 §4.10 (R-22)»** – правило платного праздника, которого нет в 11: 19 §4.7 и §5 утверждают, что «дополнения» внесены в 11, но в присланных файлах их нет (проверено grep: в 11 нет «10 гост», «120», «весь день»); опираемся на 20 §4.10 и ждём актуальную версию 11 (Q-70, Q-89).

## 1. Главные решения

1. **Мероприятие – не сеанс оплаты K10** (решение по 11 §7.2, Q-74). Правило «один сеанс – один способ» (K10 §2, 20 §4.5) действует для брони; у мероприятия нет `payment_session`. Деньги мероприятия – отдельные операции кассы K17 (`income` с `source='event'`, `refund`, `expense`), каждая ровно одним денежным способом (`cash | card | transfer`) – «каждая оплата однозначно классифицирована» (11 §7.2). Частей и способов может быть сколько угодно: предоплата, доплата, допуслуги. Конфликта с K10 нет: K10 не видит этих операций, K17 уже знает `source='event'` и `ref event`.
   Баллы и сертификаты мероприятие не принимает – по умолчанию, ждёт заказчика (Q-113): погашение сертификата и оплата баллами в K10/K15/K16 привязаны к брони; принять их на мероприятие – новая работа, не флаг.
2. **Комната занимается через K6 `occupy` с `source.type='event'`**, источник – строка `event_resources` (не всё мероприятие): у мероприятия может быть несколько ресурсов и интервалов, каждый освобождается отдельно (правка K6, §11). Конфликт с обычной бронью и удержанием даёт `EXCLUDE` той же таблицы (TC-13, 11 §5.3, приёмка 5–6). Блокировки K6 мероприятие тоже не перекрывает (`assertNotBlocked`).
3. **Обычные брони, связанные с мероприятием** (групповое посещение по отдельным броням), – только ссылки `event_bookings`; мероприятие ими не управляет. При отмене мероприятия они выводятся списком «требуют решения», а не отменяются (11 §10, 16 §12 «не отменять молча» – тот же принцип).
4. **Подарок имениннику – отдельная сущность-право** `birthday_gifts`, не сертификат K16 и не баллы (11 §9.2, §9.5, приёмка 19): фиксированный состав, свой срок, свои дни. Бронь подарка – обычная бронь K5/K6 на служебный составной ресурс «Подарок: 2 VR» (`VR1 + VR2`, без `PS4`), который нельзя выбрать обычной записью (`self_bookable = false`) – запись в выходной или праздник «через обычную запись» невозможна (11 §9.3).
5. **Связь операции кассы с объектом** – новая таблица finance `finance_operation_links` (K17 §14, §11 ниже): одна операция – не больше одного живого объекта (мероприятие, ремонт K19, выплата K18). Расход, внесённый в кассу раньше, привязывается к мероприятию без новой операции (11 §8.4).

## 2. Мероприятие (11 §3–§4)

```ts
export type EventStatus = 'new_request' | 'negotiation' | 'awaiting_confirmation' | 'confirmed' | 'preparing'
  | 'in_progress' | 'completed' | 'cancelled' | 'not_held';   // 11 §4.3, 9 статусов

export interface EventDto {
  id: string; number: string;                     // 'EV-000123', последовательность сети
  typeId: string; typeCode: string; title: string;
  branchId: string; timezone: string;
  plannedStart: string | null; plannedEnd: string | null;   // могут быть пусты в 'new_request'
  status: EventStatus;
  customer: { clientId: string | null; name: string; phoneMasked: string };   // без профиля – допустимо (11 §3.2, §4.1)
  birthdayPerson: { clientId: string | null; name: string | null };           // основание подарка (§8)
  participantsCount: number | null;
  responsibleStaffId: string | null; wishes: string | null;
  packageId: string | null;                       // шаблон, из которого собран состав (§3)
  party: { format: 'h2' | 'h3plus' | 'full_day'; guests: number; catering: boolean } | null;   // только тип birthday_party (§4)
  money: EventMoneySummary;                       // §6
  source: 'crm' | 'site';
  cancel: { reason: string; by: string; at: string } | null;
  rowVersion: number;
}
export function createEvent(tx, ctx, input: { typeId; branchId; title?; plannedStart?; plannedEnd?; customer: { clientId? ; name; phone };
  birthdayPerson?; participantsCount?; responsibleStaffId?; wishes?; packageId?; party? }, meta): Promise<EventDto>;
export function updateEvent(tx, ctx, id, input: { rowVersion; ...поля; reason?: string }, meta): Promise<EventDto>;
export function changeEventStatus(tx, ctx, id, input: { rowVersion; to: EventStatus; reason?: string }, meta): Promise<EventDto>;
```

- Создаётся без брони и без профиля (11 §2 п.5, §4.1, приёмка 1); из карточки клиента, календаря, раздела «Мероприятия», с сайта (заявка, §10).
- Телефон заказчика без профиля хранится как у гостевой брони K9 (`normalizePhone`, маска в списках); профиль клиента по телефону **не создаётся** (решение: заказчик мероприятия – контакт, а не клиент ЛК; привязка `clientId` – явным выбором сотрудника).
- **Переходы** (история – аудит `event.status_changed`, автор, время, причина):

| Из | В |
|---|---|
| `new_request` | `negotiation`, `awaiting_confirmation`, `cancelled` |
| `negotiation` | `awaiting_confirmation`, `cancelled` |
| `awaiting_confirmation` | `confirmed`, `negotiation`, `cancelled` |
| `confirmed` | `preparing`, `in_progress`, `cancelled`, `not_held` |
| `preparing` | `in_progress`, `cancelled`, `not_held` |
| `in_progress` | `completed` |
| `completed`, `cancelled`, `not_held` | – (конечные) |

- **Подтверждённым нельзя сделать** без даты и времени, филиала и хотя бы одной активной строки состава (11 §4.2) → `EVENT_NOT_READY` со списком полей. Для `birthday_party` дополнительно – занятая комната по правилам §4.
- `completed` фиксирует факт оказания услуг (16 §10); финансовые операции после него разрешены (поздняя оплата, расход по счёту подрядчика).
- Изменение даты, филиала, состава и цены – только с историей (аудит `before/after`, 11 §7.4, приёмка 21); смена филиала при занятых ресурсах – только через перенос (§7).

## 3. Состав и пакеты (11 §5.1–5.2)

```ts
export interface EventLineDto {
  id; eventId; kind: 'service' | 'goods' | 'room_rent' | 'game_time' | 'animator' | 'catering' | 'decor' | 'activity' | 'other';
  name: string; quantity: number /* numeric(10,2) > 0 */; unit: string;
  priceKop: number;            // цена для клиента за единицу, ≥ 0
  discountKop: number; discountReason: string | null;   // скидка с причиной (11 §5.2)
  planCostKop: number | null;  // плановая себестоимость строки
  supplier: string | null; comment: string | null;
  status: 'active' | 'removed'; removedReason: string | null;
}
export function addLine / updateLine / removeLine(tx, ctx, ...): Promise<EventLineDto>;   // removeLine = status 'removed' с причиной
export function applyPackage(tx, ctx, eventId, input: { packageId }, meta): Promise<EventLineDto[]>;   // копия строк шаблона
```

- **Согласованная стоимость** = Σ активных строк `quantity × priceKop − discountKop` (11 §7.1); хранится вычислением, снимок – в аудите при каждом изменении и в `events.agreed_snapshot` при переходе в `confirmed`.
- **Пакет** (`event_packages`: тип, название, строки-шаблон `jsonb`, ориентировочная цена, статус) – справочник Владельца. `applyPackage` копирует строки в мероприятие; правка строк мероприятия шаблон не меняет (11 §5.2, приёмка 4). Нужны ли пакеты вообще – 11 §17 п.2; справочник может быть пустым.
- Индивидуальная цена и скидка – право `event.price.manage` (Владелец, Директор); Администратор ведёт строки по цене шаблона или с `priceKop`, равным цене пакета – по умолчанию, ждёт заказчика (11 §17 п.8, Q-70).
- Фактическая себестоимость строки не вводится руками: она складывается из связанных расходов с `lineId` (§6). Плановая – поле строки.

## 4. Ресурсы мероприятия и платный праздник (11 §5.3; 20 §4.10, R-22)

```ts
export function reserveResource(tx, ctx, eventId, input: { resourceId; start; end }, meta): Promise<{ eventResourceId: string }>;
export function releaseResource(tx, ctx, eventId, input: { eventResourceId; reason }, meta): Promise<void>;
export function moveEvent(tx, ctx, eventId, input: { rowVersion; plannedStart; plannedEnd; resources: Array<{ eventResourceId; resourceId; start; end }>; reason }, meta): Promise<EventDto>;
```

- `reserveResource`: `expandToUnits` → K6 `occupy({ source: { type: 'event', id: eventResourceId }, clientId: null })` в одной транзакции со вставкой `event_resources`; ошибки K6 (`SLOT_TAKEN`, `SLOT_HELD`, `RESOURCE_BLOCKED`, `OUTSIDE_SCHEDULE`) – как есть. `client_time` мероприятие не пишет (K6: у мероприятия его нет) – заказчик может параллельно иметь обычную бронь (решение: он не играет сам; ограничение 01 §9 – про клиента-игрока).
- Резервировать можно в любом незавершённом статусе (решение: сотрудник сам решает, держать ли комнату на время согласования); в `new_request` CRM предупреждает «комната занята под необработанную заявку». Удержание комнаты под `new_request` живёт не дольше `event.request_hold_hours` (48 ч от `reserveResource`): за `event.request_hold_remind_hours` (24) до конца – напоминание ответственному (лента CRM Э4, до неё – отметка в списке мероприятий), по истечении задача `events:request-hold-expire` освобождает ресурс (`releaseResource`, причина `request_hold_expired`), мероприятие остаётся `new_request` (ревью 04.11).
- **Платный праздник** (`event_types.code = 'birthday_party'`) – по 20 §4.10 (R-22):

| Правило | Проверка | Ошибка |
|---|---|---|
| только комната VR+PS4 целиком (ресурс `room_whole`) | тип ресурса | `PARTY_RESOURCE_INVALID` |
| непрерывно не меньше `event.party.min_minutes` (120) | один интервал `event_resources` ≥ 120 мин; два встык – не считаются одним (решение: «непрерывное время комнаты») | `PARTY_TOO_SHORT` |
| гостей 1…`event.party.max_guests` (10) | `party.guests`, `participantsCount` | `PARTY_GUESTS_LIMIT` |
| формат `h2` (120 мин) / `h3plus` (≥ 180 мин) / `full_day` (от открытия до закрытия филиала в эту дату по графику) | длительность по формату | `PARTY_FORMAT_MISMATCH` |
| праздничный стол/кейтеринг – опционально, отдельной строкой `catering` | – | – |
| цена не рассчитывается, пока `event.party.price_confirmed = false` | у строк праздника нет цены из тарифа; сотрудник с `event.price.manage` вводит её руками, на сайте – «цена уточняется» | – |

  TC-13: «непрерывный блок VR+PS4 минимум 120 минут, гости 1–10, стол отдельно; неподтверждённая цена не рассчитывается».
- Тарифы K6 `quote` для мероприятий не вызываются никогда (решение: стоимость мероприятия – строки состава, 11 §7.1; тариф брони – про сеанс).
- `moveEvent` (перенос, 11 §10): в одной транзакции `release(old)` → `occupy(new)`; конфликт нового интервала откатывает всё – старое время остаётся (16 §9 «если недоступен, исходная остаётся»). История старой даты – аудит `event.rescheduled`.

## 5. Чек-лист (11 §6)

`event_checklist (event_id, code, title, status: 'todo' | 'done' | 'not_needed', responsible_staff_id, comment, updated_by, updated_at)`. При создании засевается 10 пунктов 11 §6 (подтверждение даты, состава, участников, ответственного, подрядчика, кейтеринга, подготовка комнаты, закупка, проверка оплаты, подарок имениннику); пункты добавляются и помечаются «не нужно», не удаляются. Чек-лист не заменяет финансовых операций (11 §6) – пункт «проверка оплаты» показывает остаток к оплате из §6, но не меняет его.

## 6. Деньги мероприятия (11 §7–§8, §11.3; K17)

```ts
export function recordEventIncome(tx, ctx, eventId, input: { place; method: MoneyMethod; amountKop; occurredAt; comment?; receiptIssued? }, meta): Promise<FinanceOperationDto>;
export function refundEventIncome(tx, ctx, eventId, input: { incomeOperationId; amountKop; method: MoneyMethod; place; reason }, meta): Promise<FinanceOperationDto>;
export function addEventExpense(tx, ctx, eventId, input: { place; method; amountKop; categoryId; subcategoryId?; supplier?; lineId?; inCost?: boolean; occurredAt; comment; attachmentId? }, meta): Promise<FinanceOperationDto>;
export function linkEventExpense(tx, ctx, eventId, input: { operationId; lineId?; inCost?: boolean }, meta): Promise<void>;

export interface EventMoneySummary {          // 11 §11.3 – отдельными показателями, не смешивая
  agreedKop: number;                          // согласованная стоимость (§3)
  receivedKop: number;                        // Σ живых income (без сторнированных)
  refundedKop: number;                        // Σ refund
  dueKop: number;                             // agreed − received + refunded (может быть < 0 – переплата, показывается отдельно)
  planCostKop: number;                        // Σ planCostKop активных строк
  factCostKop: number;                        // Σ живых связанных expense с inCost = true
  resultKop: number;                          // received − refunded − factCost (11 §3.5)
  deviationKop: number;                       // factCost − planCost; > 0 – перерасход (11 §8.3)
  discountsKop: number; giftsIssued: number;  // отдельно, не в результате (11 §3.5)
}
```

- **Поступление** – K17 `recordIncome` с `source='event'`, `ref { type: 'event', id }` + связь `(ref_type 'event', role 'income')` в той же транзакции. Филиал кассы = филиал мероприятия (решение: 11 §7.2 «филиал/касса»; межфилиальных операций в K17 нет). Право – `event.money.record` **и** K17 `finance.income.create` (Администратору – нет по умолчанию Q-29; «при наличии финансового права», 11 §13).
- **Предоплата** – обычное поступление до проведения (11 §7.3), отдельного типа нет; обязательность, размер и срок – `event.prepayment_required = false`, ждёт заказчика (Q-74). При `true` переход в `confirmed` требует `receivedKop ≥ event.prepayment_min_percent × agreed` – параметры добавятся вместе с ответом, флаг лишь зарезервирован (решение: не придумывать 11 §17 последний абзац).
- **Возврат** – K17 `refund` со ссылкой на исходное поступление (`ref operation`), сумма ≤ `поступление − уже возвращено по нему` → иначе `EVENT_REFUND_EXCEEDS_INCOME`; под `FOR UPDATE` строки мероприятия; после `lockPlaces` поступление перечитывается – сторнировано за это время → `OPERATION_REVERSED`. Сторно поступления, у которого есть живые возвраты, запрещено (`INCOME_HAS_REFUNDS`: сначала сторно возвратов) – иначе возврат повисает без основания. Причина обязательна; штрафов и удержаний при отмене система не считает (11 §10, §17) – сумму возврата вводит сотрудник с правом `finance.refund`. Сторно поступления (ошибка ввода) – обычное K17 `reverseOperation` по `finance.correct`.
- **Расход** – K17 `recordExpense` (категории «Подрядчики и услуги» → «Аниматор», «Кейтеринг», «Доставка»; «Закупки и материалы» → «Продукты», «Напитки»…, посев 0202) с `ref event` и связью `(role 'expense', in_cost, line_id)`. Одна операция видна и в карточке мероприятия, и в журнале филиала (11 §8.4, §11.4, приёмка 8) – это одна строка `finance_operations`.
- **Уже внесённый расход** (кейтеринг в общих расходах) – `linkEventExpense`: связь без новой операции; уже связанная → `OPERATION_ALREADY_LINKED` (11 §8.4 «нельзя повторно учитывать»).
- Накладные филиала в себестоимость не идут (11 §8.5): `inCost = false` по умолчанию только у привязанных, у созданных из карточки – `true`.
- Сверка (16 §14 «расходы мероприятия совпадают со связанными операциями») – ночная проверка S3-95.

## 7. Отмена и перенос (11 §10)

- `changeEventStatus(to: 'cancelled' | 'not_held', reason)`: причина обязательна, инициатор и время – в событии. В той же транзакции освобождаются **свои** строки занятости (`event_resources` → K6 `release('cancelled')`). Связанные обычные брони, выданные подарки и остаток денег возвращаются в ответе списком «требуют решения» (`details.bookingIds`, `giftIds`, `dueKop`, `receivedKop`) – система их не трогает (11 §10 «обрабатываются по правилам…», «выданный подарок – по отдельным правилам»).
- Финансовые операции не удаляются; понесённые расходы остаются в факте себестоимости (11 §10, приёмка 12).
- Уведомление заказчику – событие `event.cancelled` / `event.rescheduled` (§12); отправка – Э4: обработчик `notifications` (S4-29) пишет категорию `service`, вид `event_cancelled` / `event_rescheduled` (K21 §2; категория `event_cancel` из 0111 снимается в 0401 – K20 строк `notifications` не пишет, поэтому снятие ничего не ломает; правка S4-00). Заказчику без профиля система ничего не отправляет – по умолчанию, ждёт заказчика (Q-116, 11 §17 п.18).

## 8. Подарок имениннику (11 §9; 20 §4.10; 16 §8.4)

### 8.1. Право

```ts
export type GiftStatus = 'issued' | 'reserved' | 'used' | 'expired' | 'cancelled';   // 11 §9.2 + 'reserved' (решение: есть живая запись)
export interface BirthdayGiftDto {
  id: string; number: string;                 // 'GF-000123'
  clientId: string;                           // именинник с профилем – иначе ему нечем записаться и нечего увидеть в ЛК (11 §12)
  basisEventId: string | null;                // мероприятие-основание
  issuedOn: LocalDate; validUntil: LocalDate; // issuedOn + gift.valid_days (60), включительно, по зоне филиала выдачи
  issueBranchId: string; timezone: string;
  terms: { devices: 2; device: 'Meta Quest 3S'; minutesEach: 30; roomMinutes: 40; weekdays: [1, 2, 3, 4, 5];
           excludesHolidays: true; notIncluded: ['PS4', 'PS VR', 'food'] };   // снимок на выдаче (15 §3.4)
  status: GiftStatus; bookingId: string | null; cancelReason: string | null;
}
export function issueGift(tx, ctx, input: { clientId; basisEventId?; reason?: string }, meta): Promise<BirthdayGiftDto>;
export function cancelGift(tx, ctx, giftId, input: { reason }, meta): Promise<BirthdayGiftDto>;
```

- Состав – 2 × Meta Quest 3S по 30 минут, 40 минут комнаты с подготовкой, 60 дней, по записи, Пн–Пт кроме праздников; PS4, PS VR и еда не входят (11 §2 п.7–10, §9.1, приёмка 13–17). Состав – константа снимка, а не настройка; меняются только `gift.valid_days` и `gift.room_minutes` и только для новых подарков.
- **Основание** – мероприятие типа `birthday_party` или `birthday` в статусе `in_progress` или `completed`, где `birthdayPerson.clientId = clientId` – по умолчанию, ждёт заказчика (Q-115). Выдача без мероприятия – только Владелец (`gift.issue.manual`) с причиной.
- **Срок** – от даты выдачи (11 §9.2 «если иное не утверждено») – по умолчанию, ждёт заказчика (Q-71 / R-09). `validUntil` – последний день, когда может **проходить** подарочное посещение.
- **Один подарок на именинника в 365 дней** (`gift.per_client_days`), на передачу не рассчитан – `clientId` не меняется (Q-71 / R-09). База: `EXCLUDE (client_id WITH =, daterange(issued_on, issued_on + 365) WITH &&) WHERE (status <> 'cancelled')` → `GIFT_ALREADY_ISSUED`.
- Истечение – задача `events.gift_expire` (worker, раз в 10 мин): `issued` с `validUntil` < сегодня по зоне → `expired`; `reserved` с живой бронью позже срока невозможен (проверка §8.2 п.1).
- В CRM и ЛК подарок **не показывается среди сертификатов** (приёмка 19): свой блок, свой номер `GF-`, без номинала.

### 8.2. Запись по подарку – 7 проверок 11 §9.3

```ts
export function holdGift(tx, owner: HoldOwner, giftId, input: { branchId; start }, clock): Promise<HoldDto>;     // ЛК: удержание K5 на подарочный ресурс
export function bookGiftByStaff(tx, ctx, giftId, input: { branchId; start; comment? }, meta): Promise<CrmBooking>;   // CRM, бронь сразу
```

| № | 11 §9.3 | Как проверяется | Ошибка |
|---|---|---|---|
| 1 | подарок активен и не истёк | `status = 'issued'`, дата посещения ≤ `validUntil` | `GIFT_NOT_ACTIVE` / `GIFT_EXPIRED` |
| 2 | Пн–Пт | день недели **даты филиала** посещения (K8) | `GIFT_WEEKDAY_ONLY` |
| 3 | не праздник | `holiday_dates` сети и города филиала (§9) | `GIFT_HOLIDAY` |
| 4 | свободны комната и оба Quest 3S | K6 `occupy` единиц `VR1 + VR2` подарочного ресурса на 40 мин; один свободный шлем – отказ (Q-72) | `SLOT_TAKEN` / `SLOT_HELD` / `RESOURCE_BLOCKED` |
| 5 | без PS4 и PS VR | состав ресурса без `PS4` – данные K6; любые другие позиции в удержании подарка → отказ | `GIFT_COMPOSITION_INVALID` |
| 6 | резерв | одна живая запись на подарок: `gift_uses UNIQUE (gift_id) WHERE status IN ('held','booked','used')` | `GIFT_ALREADY_RESERVED` |
| 7 | «использован» после посещения | обработчик `visit.confirmed` (ниже) | – |
| 8 | подарок – клиенту-имениннику (ревью 04.11) | клиент брони = `gift.clientId` в `holdGift` (владелец удержания), `bookGiftByStaff`, переносе и `attachHold` (привязка удержания к профилю) | `GIFT_CLIENT_MISMATCH` |

- Подарочный ресурс – в каждом филиале, где есть VR-комната: `resources (type 'gift_vr', self_bookable = false, step_minutes = 5)`, состав `VR1 + VR2`; создаёт его `ensureGiftResource(branchId)` (S3-62) – при создании VR-комнаты и боевой идемпотентной процедурой для существующих комнат; демо-посев S3-96 вызывает её же. Только демо-посевом нельзя: в бою подарок иначе не записывается. PS4 подарок не занимает – её можно бронировать отдельно во время подарка (по умолчанию, Q-155). Тариф `gift_vr` – 0 ₽ (бронь проходит K6 `quote`, оплата – K10 `none`). Использовать подарок можно в любом филиале сети с таким ресурсом – по умолчанию, ждёт заказчика (Q-114).
- Начало – на сетке `gift.start_align_minutes` (15, как VR, 20 §4.3), длительность – `gift.room_minutes` (40): шаг ресурса 5 мин нужен только чтобы 40 прошло проверку K6 `assertSlotAligned`; выравнивание начала проверяет `events` (решение по Q-72; «хвост» 5 мин до следующего VR-слота – вопрос Q-118).
- **Хук бронирования** (правка booking, S3-58, §11): `createHold` (`hold.ts`) / `createStaffBooking` и `rescheduleBooking` (`change.ts`) принимают необязательный `serviceGrant: { kind: 'gift'; id }`; ресурс с `self_bookable = false` разрешён только при зарегистрированном валидаторе гранта для его типа (`registerServiceGrant('gift_vr', check)` из `events`), валидатор вызывается в той же транзакции до `occupy`. Без гранта – прежний `RESOURCE_UNAVAILABLE` (поведение Э1–Э2 не меняется).
- Жизненный цикл `gift_uses` – обработчики событий K4 (идемпотентны, состояние из базы):

| Событие | Было | Стало |
|---|---|---|
| удержание создано (`holdGift`, в транзакции) | – | `held`, подарок `reserved` |
| `hold.expired` / удаление позиции / `release` | `held` | `released`, подарок `issued` (если не истёк, иначе `expired`) |
| `booking.confirmed` | `held` | `booked` |
| `booking.cancelled`, `booking.rescheduled` на не-подарочный ресурс | `booked` | `released`, подарок `issued` |
| `visit.confirmed` | `booked` | `used`, подарок `used` |
| `visit.reverted` | `used` | `booked`, подарок `reserved` |
| `no_show.marked` | `booked` | `released`, подарок `issued` – по умолчанию, ждёт заказчика (Q-114); `gift.no_show_returns = false` → подарок `cancelled` с причиной `no_show` |

- Перенос подарочной брони – только на будний не праздничный день того же срока: перенос K11 №7 для брони с `gift_uses` вызывает валидатор гранта (тот же хук); иначе `GIFT_WEEKDAY_ONLY` / `GIFT_HOLIDAY` / `GIFT_EXPIRED`.
- Доплатные услуги к подарочному посещению – отдельной бронью или позицией по общим правилам (11 §9.4); условия подарка не меняются.
- Баллы за подарочное посещение (оплата `none`, 0 ₽) начисляются как за бесплатный сеанс (Q-106) – по умолчанию, ждёт заказчика (Q-114).

## 9. Праздничный календарь (15 §6.4; R-10, Q-73)

```ts
export function isHoliday(db, input: { branchId: string; date: LocalDate }): Promise<boolean>;   // сеть ∪ город филиала
export function setHoliday(tx, ctx, input: { scope: 'network' | 'city'; cityId?; date: LocalDate; name; }, meta): Promise<void>;
export function cancelHoliday(tx, ctx, id, input: { reason }, meta): Promise<void>;
```

- Один календарь на сеть + праздники отдельных городов; ведёт Владелец вручную (15 §6.4 «на первом этапе вручную»), без внешнего источника – по умолчанию, ждёт заказчика (Q-73 / R-10).
- Влияет **только на подарок** (решение): график филиала в праздник меняют исключения календаря Э1 (`calendar_exceptions`), а не эта таблица.
- `holiday_dates (scope, city_id, local_date, name, status)`, `UNIQUE (scope, coalesce(city_id), local_date) WHERE status = 'active'`.

## 10. Клиент: сайт и ЛК (11 §12; 19 §4.7; карта сайта `/birthday/`)

- **Страница `/birthday/`** – по 20 §4.10 (R-22): только комната VR+PS4, до 10 гостей, 2 ч / 3+ ч / весь день, минимум 120 минут, стол/кейтеринг опционально, «цена уточняется» (пока `event.party.price_confirmed = false`), филиалы, где есть `room_whole`; блок «Подарок имениннику» с условиями 11 §12 (состав, 60 дней, Пн–Пт кроме праздников, без PS4/PS VR/еды). Тексты – статические в Э3, редактирование через CMS и SEO-поля – Э4 (сход с 6.6).
- **Заявка на праздник** (11 §12 «форма запроса»): `POST /api/public/v1/event-requests { branchId, preferredDate, format, guests, name, phone, comment, consent: true }` → мероприятие `birthday_party` в статусе `new_request`, `source='site'`, без занятия комнаты. Онлайн-оплаты и конструктора пакетов нет (11 §12). Согласие на обработку ПДн – обязательная пустая галочка; текст – от юриста заказчика (N-01, Q-117). Защита: лимит 5 заявок с телефона в сутки и 30 с IP в час (решение, как `client.otp_*`), повтор с тем же `Idempotency-Key` – та же заявка.
- **ЛК «Мой подарок»** (`GET /api/public/v1/me/gifts`): активные и прошлые подарки с условиями дословно, срок, статус, кнопка «Записаться» → расписание в режиме подарка (только будни без праздников в пределах срока, только подарочный ресурс) → обычное оформление K5 с ценой 0.
- **ЛК «Мои мероприятия»** (`GET /api/public/v1/me/events`): мероприятия, где клиент – заказчик, в статусах от `confirmed`: дата, филиал, состав (названия и количество, без себестоимости), связанные брони (11 §12 «если сценарий будет включён» – включаем только чтение, решение).

## 11. Изменения смежных контрактов (вносит шаг S3-00)

**K17 §14 «Связи операций кассы с объектами» (новый раздел, модуль finance):**

```ts
export type LinkRef = { type: 'event' | 'repair' | 'payroll_statement'; id: string };
export type LinkRole = 'income' | 'refund' | 'expense' | 'payout_expense';
/** Связать операцию с объектом. Одна операция – не больше одной живой связи (PK operation_id WHERE unlinked_at IS NULL).
 *  Проверки: роль совместима с kind операции (income ↔ income, refund ↔ refund, expense/payout_expense ↔ expense);
 *  операция не сторнирована; филиал в зоне ctx. Иначе OPERATION_LINK_INVALID / OPERATION_ALREADY_LINKED. */
export function linkOperation(tx, ctx, input: { operationId; ref: LinkRef; role: LinkRole; inCost?: boolean; lineId?: string }, meta): Promise<void>;
/** Создать операцию и связь в одной транзакции (обёртки над recordIncome / recordExpense / refund). */
export function createLinkedOperation(tx, ctx, input: NewOperation & { link: Omit<Parameters<typeof linkOperation>[2], 'operationId'> }, meta): Promise<FinanceOperationDto>;
/** Живые связи объекта с суммами; сторнированные операции исключены (reversedBy != null). */
export function linksOf(db, ref: LinkRef): Promise<Array<{ operation: FinanceOperationDto; role; inCost; lineId }>>;
/** Возврат по ссылке на поступление (не K10 и не K16): kind 'refund', ref { type: 'operation', id: incomeId }.
 *  Только для income с source 'event' | 'extra_service' | 'other'; Σ refund по поступлению ≤ его суммы (EVENT_REFUND_EXCEEDS_INCOME). */
export function refundIncome(tx, ctx, input: { incomeOperationId; amountKop; place; method; reason }, meta): Promise<FinanceOperationDto>;
```

- Таблица `app.finance_operation_links (operation_id uuid → finance_operations, ref_type, ref_id, role, in_cost boolean, line_id uuid, linked_by, linked_at, unlinked_at, unlink_reason)`, `UNIQUE (operation_id) WHERE unlinked_at IS NULL` (`0301_finance_links.sql`). Сторно операции в K17 сам связь не гасит – потребители читают `linksOf` (живая операция = без `reversed_by`). Отвязка – `unlinked_at` с причиной (ошибочная привязка), право `finance.correct`.
- K17 §4 «Возврат создаёт только K10 и K16» → «… K10, K16 и `refundIncome` для поступлений мероприятий и прочих (K20 §6)».
- Межмодульный вызов – только функциями `modules/finance/links.ts` (экспорт модуля finance, ADR 0002); другие модули таблицу связей не пишут.

**K6:** у `source.type = 'event'` источник – `event_resources.id` (не `events.id`); комментарий model-dannyh 0102 «`events.id`» поправить. `occupy` для мероприятия – через провайдер booking `occupyForEvent` / `releaseEvent` (S3-09), не прямым импортом `occupancy.ts`.

**K5 / K6 (бронирование):** необязательный `serviceGrant` у `createHold`, `addHoldItem`, CRM-брони и переноса; реестр `registerServiceGrant(resourceType, validator)` в booking; без гранта поведение прежнее. Ошибки валидатора проходят как есть (`GIFT_*`).

**K1, K2, K4, K7, K11** – строки §12–§16 этого файла и K18, K19.

**Для Э4 (K24 отчёты, K21 уведомления) – представления и провайдеры Э3** (миграция `0311_rpt_e3.sql`, шаг S3-95; владельцы – модули Э3, как 0211; 0410 Э4 эти представления не создаёт и не меняет – только то, чего по факту 0311 нет, решение техлида 04.11). **Права:** 0311 сама выдаёт `GRANT SELECT ON <все представления ниже> TO yu_reports` и отзывает запись у `yu_app` – пул отчётов ходит под этой ролью (K24 §9, §13, D4-23), иначе отчёты Э3 упадут с `permission denied`; проверяет `tests/reports/grants.test.ts`:

| Представление | Владелец | Поля |
|---|---|---|
| `rpt_events` | events | `event_id, number, branch_id, type_code, status, held_on` (дата `planned_start` по зоне филиала), `agreed_price_kop, planned_cost_kop, planned_cost_by_kind jsonb, discounts_kop, has_booking, has_resources, source, customer_client_id` |
| `rpt_event_money` | finance (по связям K17 §14) | `event_id, operation_id, kind, role, in_cost, line_kind, category_id, subcategory_id, amount_kop, direction, occurred_at, reversed` |
| `rpt_repair_money` | finance (по связям) | `repair_id, operation_id, amount_kop, occurred_at, payer_branch_id, reversed` |
| `rpt_shifts` | shifts | `shift_id, branch_id, staff_id, local_date, planned_period, actual_period, status, state` (`planned`; `worked → closed`; `needs_review → unclosed`; `planned` идущая сейчас → `open`), `paid_minutes, rate_missing` |
| `rpt_shift_gaps` | shifts | `branch_id, local_date, gap_period` – пустые интервалы (state `empty` отчёта K24 3.9) |
| `rpt_payroll` | shifts | `period_id, staff_id, branch_id, hours_amount_kop, per_shift_kop, penalties_kop, bonuses_kop, adjustments_kop, to_pay_kop, paid_kop, paid_at, statement_status` |
| `rpt_equipment` | equipment | `equipment_id, branch_id, unit_id, room_id, resource_ids` (ресурсы, в составе которых единица), `status, inventory_no, serial_no, category_id` |
| `rpt_repairs` | equipment | `repair_id, equipment_id, branch_id, incident_at` (`broken_at`, иначе `detected_at` с флагом), `started_at` (первый переход в `in_repair`, иначе `null`), `finished_at` (`completed_at`), `contractor_id` (`executor_id`), `warranty boolean, priority, status, block_ids` |

Важно для K24: деньги мероприятий и ремонтов брать из `rpt_event_money` / `rpt_repair_money`, **а не** по `finance_operations.ref_type`: привязанный вручную расход (K17 §14 `linkOperation`) своего `ref_type` не имеет (журнал только на вставку). Аудитория `event` для K21 – провайдер `events.audienceOf(eventId)`: клиент-заказчик с профилем, именинник с профилем, клиенты связанных броней (`event_bookings`), без дублей.

## 12. События (дополняют K4)

| `type` @ver | Когда | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `event.confirmed` @1 | переход в `confirmed` | `row_version` | `{ eventId, number, branchId, branchTimezone, customerClientId \| null, plannedStart, plannedEnd }` | Э4: подтверждение заказчику с профилем |
| `event.rescheduled` @1 | `moveEvent` | `row_version` | `{ eventId, branchId, customerClientId \| null, previous: { start, end }, current: { start, end } }` | Э4 |
| `event.cancelled` @1 | `cancelled` / `not_held` | `'cancelled'` | `{ eventId, branchId, customerClientId \| null, reason, linkedBookingIds, giftIds }` | Э4: сервисное заказчику с профилем (K21 §2, S4-29) |
| `gift.issued` @1 | `issueGift` | `1` | `{ giftId, clientId, validUntil, issueBranchId }` | Э4: «вам подарок» в центре уведомлений ЛК |

Типы агрегатов – `event`, `gift` (S3-08). Подарок слушает `hold.expired`, `booking.confirmed`, `booking.cancelled`, `booking.rescheduled`, `visit.confirmed`, `visit.reverted`, `no_show.marked` (обработчики `events.gift.*`, worker).

## 13. Права (K1, шаг S3-01)

| Действие | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `event.view` | ✓ | ✓ | ✓ | branch | 11 §13 |
| `event.manage` (создать, оргданные, состав по цене шаблона, статусы, ресурсы, чек-лист) | ✓ | ✓ | ✓ | branch | 11 §13 «Администратор: создание, оргданные, чек-лист» |
| `event.price.manage` (индивидуальная цена, скидка) | ✓ | ✓ | | branch | 11 §13, §17 п.8 |
| `event.money.view` (себестоимость, результат) | ✓ | ✓ | | branch | 11 §13 «просмотр финансовых данных своей зоны» |
| `event.money.record` (поступление, расход, привязка) | ✓ | ✓ | ✓ | branch | 11 §13 «при наличии финансового права» – плюс K17 `finance.income.create` / `finance.expense.create` |
| `event.package.manage`, `event.type.manage` | ✓ | | | network | 11 §13 |
| `gift.issue` | ✓ | ✓ | ✓ | branch основания | 11 §13 «при выполнении условий и наличии разрешения» |
| `gift.issue.manual`, `gift.cancel` | ✓ | | | network | Q-115 |
| `gift.book` (запись подарка из CRM) | ✓ | ✓ | ✓ | branch | `booking.create` + грант |
| `holiday.manage` | ✓ | | | network | Q-73 |

Возврат денег мероприятия – существующее `finance.refund` (Владелец, Директор).

## 14. Данные (`0305_events.sql`, `0308_holidays.sql`, `0309_gifts.sql`)

```sql
-- 0305 (events)
CREATE SEQUENCE app.event_number_seq; CREATE SEQUENCE app.gift_number_seq;
CREATE TABLE app.event_types (id uuid PK, code text NOT NULL UNIQUE, name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')));
-- посев: birthday_party «Платный праздник», birthday «День рождения без аренды комнаты», group_visit, program, other (11 §3.1; Q-70)
CREATE TABLE app.event_packages (id uuid PK, type_id uuid NOT NULL → event_types, name text NOT NULL, lines jsonb NOT NULL,
  approx_price_kop bigint, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')), row_version int NOT NULL DEFAULT 1);
CREATE TABLE app.events (id uuid PK, number text NOT NULL UNIQUE, type_id uuid NOT NULL → event_types, branch_id uuid NOT NULL → branches,
  title text NOT NULL, planned_start timestamptz, planned_end timestamptz, status text NOT NULL DEFAULT 'new_request' CHECK (status IN (…9…)),
  customer_client_id uuid → clients, customer_name text NOT NULL, customer_phone_e164 text NOT NULL,
  birthday_client_id uuid → clients, birthday_person_name text, participants_count int CHECK (participants_count > 0),
  responsible_staff_id uuid → staff, wishes text, package_id uuid → event_packages,
  party_format text CHECK (party_format IN ('h2','h3plus','full_day')), party_guests int, party_catering boolean,
  agreed_snapshot jsonb, source text NOT NULL CHECK (source IN ('crm','site')),
  cancel_reason text, cancelled_by uuid, cancelled_at timestamptz, created_by_type text NOT NULL, created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), row_version int NOT NULL DEFAULT 1,
  CHECK (planned_end IS NULL OR planned_end > planned_start),
  CHECK (status NOT IN ('confirmed','preparing','in_progress','completed') OR planned_start IS NOT NULL));
CREATE TABLE app.event_lines (id uuid PK, event_id uuid NOT NULL → events, kind text NOT NULL CHECK (kind IN (…9…)), name text NOT NULL,
  quantity numeric(10,2) NOT NULL CHECK (quantity > 0), unit text NOT NULL, price_kop bigint NOT NULL CHECK (price_kop >= 0),
  discount_kop bigint NOT NULL DEFAULT 0 CHECK (discount_kop >= 0), discount_reason text, plan_cost_kop bigint CHECK (plan_cost_kop >= 0),
  supplier text, comment text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')), removed_reason text,
  sort_order int NOT NULL DEFAULT 0, row_version int NOT NULL DEFAULT 1,
  CHECK (discount_kop = 0 OR discount_reason IS NOT NULL), CHECK (status = 'active' OR removed_reason IS NOT NULL));
CREATE TABLE app.event_checklist (id uuid PK, event_id uuid NOT NULL → events, code text, title text NOT NULL,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done','not_needed')), responsible_staff_id uuid, comment text,
  updated_by uuid, updated_at timestamptz);
CREATE TABLE app.event_resources (id uuid PK, event_id uuid NOT NULL → events, branch_id uuid NOT NULL → branches,
  resource_id uuid NOT NULL → resources, period tstzrange NOT NULL /* [) конечные */, unit_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')), released_at timestamptz, release_reason text);
CREATE TABLE app.event_bookings (event_id uuid NOT NULL → events, booking_id uuid NOT NULL UNIQUE → bookings,
  linked_by uuid NOT NULL, linked_at timestamptz NOT NULL, PRIMARY KEY (event_id, booking_id));
-- 0308 (network)
CREATE TABLE app.holiday_dates (id uuid PK, scope text NOT NULL CHECK (scope IN ('network','city')), city_id uuid → cities,
  local_date date NOT NULL, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK ((scope = 'city') = (city_id IS NOT NULL)));
CREATE UNIQUE INDEX holiday_dates_one ON app.holiday_dates (scope, coalesce(city_id, '00000000-0000-0000-0000-000000000000'), local_date) WHERE status = 'active';
-- 0309 (events)
CREATE TABLE app.birthday_gifts (id uuid PK, number text NOT NULL UNIQUE, client_id uuid NOT NULL → clients,
  basis_event_id uuid → events, issue_branch_id uuid NOT NULL → branches, issued_on date NOT NULL, valid_until date NOT NULL,
  terms jsonb NOT NULL, status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','reserved','used','expired','cancelled')),
  cancel_reason text, issued_by uuid NOT NULL, row_version int NOT NULL DEFAULT 1, CHECK (valid_until > issued_on),
  CONSTRAINT birthday_gifts_one_per_year EXCLUDE USING gist (client_id WITH =, daterange(issued_on, issued_on + 365) WITH &&) WHERE (status <> 'cancelled'));
CREATE TABLE app.gift_uses (id uuid PK, gift_id uuid NOT NULL → birthday_gifts, hold_id uuid → holds, booking_id uuid → bookings,
  status text NOT NULL CHECK (status IN ('held','booked','used','released')), changed_at timestamptz NOT NULL);
CREATE UNIQUE INDEX gift_uses_one_live ON app.gift_uses (gift_id) WHERE status IN ('held','booked','used');
```

`REVOKE DELETE` на все таблицы. Константа `365` в `EXCLUDE` – копия умолчания `gift.per_client_days` (решение: ограничение базы не читает настройку; смена срока – миграцией, вопрос Q-71).

## 15. API (номера 3xx)

| # | Метод и путь | Право | Успех |
|---|---|---|---|
| 361 | `GET /events?from=&to=&branchId=&typeId=&status=&customer=&responsibleId=&hasDue=&cursor=` | `event.view` | `200` колонки 11 §11.1; суммы – только с `event.money.view`, иначе только `dueKop` |
| 362 | `POST /events`, `GET /events/{id}`, `PATCH /events/{id}` | `event.manage` / `event.view` | `201` / `200` + `timeline` (K2) |
| 363 | `POST /events/{id}/status` | `event.manage` | `200`; отмена – `{ event, needsDecision }` |
| 364 | `POST /events/{id}/lines`, `PATCH /event-lines/{id}`, `POST /event-lines/{id}/remove`, `POST /events/{id}/apply-package` | `event.manage` (`event.price.manage` для цены и скидки) | `201` / `200` |
| 365 | `POST /events/{id}/resources`, `POST /events/{id}/resources/{rid}/release`, `POST /events/{id}/move` | `event.manage` | `201` / `200` |
| 366 | `POST /events/{id}/bookings` (`{ bookingId }`), `POST /events/{id}/bookings/{bid}/unlink` | `event.manage` | `200` |
| 367 | `GET/POST/PATCH /events/{id}/checklist` | `event.manage` | `200` |
| 368 | `GET /events/{id}/money` | `event.money.view` | `200 { summary, operations }` |
| 369 | `POST /events/{id}/income`, `/refund`, `/expense`, `/expense/link` | `event.money.record` (`finance.refund` для возврата) | `201` |
| 370 | `GET/POST/PATCH /event-packages`, `GET/POST/PATCH /event-types` | `event.view` / `event.package.manage` | архив вместо удаления |
| 376 | `GET /gifts?clientId=&status=`, `POST /gifts`, `POST /gifts/{id}/cancel` | `event.view` / `gift.issue` / `gift.cancel` | `201` / `200` |
| 377 | `GET /gifts/{id}/slots?branchId=&date=` | `event.view` | `200` – подарочные окна дня с учётом будней и праздников |
| 378 | `POST /gifts/{id}/book` | `gift.book` | `201 CrmBooking` |
| 379 | `GET/POST /holidays`, `POST /holidays/{id}/cancel` | `event.view` / `holiday.manage` | `200` |
| П1 | `GET /api/public/v1/me/gifts`, `GET /api/public/v1/me/gifts/{id}/slots?branchId=&date=` | клиент, свой | `200` |
| П2 | `POST /api/public/v1/me/gifts/{id}/hold` `{ branchId, start }` | клиент, свой | `201 HoldDto` (K5) |
| П3 | `GET /api/public/v1/me/events` | клиент, свой | `200` (§10) |
| П4 | `POST /api/public/v1/event-requests` | без входа, лимиты §10 | `201 { requestNumber }` |
| П5 | `GET /api/public/v1/party-info?branchId=` | без входа | `200 { branches: [{ id, name, hasRoom }], minMinutes, maxGuests, formats, priceConfirmed, giftTerms }` |

## 16. Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `EVENT_NOT_READY` | 422 | подтверждение без даты, филиала, состава (`details.fields`) |
| `EVENT_TRANSITION_INVALID` | 409 | переход не по таблице §2 |
| `EVENT_CLOSED` | 409 | правка состава/ресурсов в конечном статусе |
| `PARTY_RESOURCE_INVALID`, `PARTY_TOO_SHORT`, `PARTY_GUESTS_LIMIT`, `PARTY_FORMAT_MISMATCH` | 422 | правила праздника §4 (TC-13) |
| `EVENT_REFUND_EXCEEDS_INCOME` | 409 | возврат больше поступления |
| `OPERATION_ALREADY_LINKED`, `OPERATION_LINK_INVALID` | 409 / 422 | связь операции (§11) |
| `GIFT_NOT_ACTIVE`, `GIFT_EXPIRED`, `GIFT_WEEKDAY_ONLY`, `GIFT_HOLIDAY`, `GIFT_COMPOSITION_INVALID`, `GIFT_ALREADY_RESERVED`, `GIFT_CLIENT_MISMATCH` | 409 / 422 | проверки §8.2 (TC-14) |
| `OPERATION_REVERSED`, `INCOME_HAS_REFUNDS` | 409 | возврат по сторнированному поступлению; сторно поступления с живыми возвратами (§6) |
| `GIFT_ALREADY_ISSUED` | 409 | второй подарок клиенту в 365 дней |
| `GIFT_BASIS_INVALID` | 422 | основание – не день рождения этого клиента или не в нужном статусе |
| `CONSENT_REQUIRED` | 422 | заявка с сайта без согласия |
| `RATE_LIMITED` | 429 | лимит заявок |

Ошибки K6 (`SLOT_TAKEN`, `SLOT_HELD`, `RESOURCE_BLOCKED`, `OUTSIDE_SCHEDULE`) и K17 (`CASH_INSUFFICIENT`, `PERIOD_CLOSED`, `COMMENT_REQUIRED`, `SUBCATEGORY_REQUIRED`) проходят как есть.

## 17. Настройки (K7, шаг S3-01; сеть, Владелец)

| Ключ | Тип | По умолчанию | Основание |
|---|---|---|---|
| `event.party.min_minutes` | int 30..720 | 120 | 20 §4.10 (R-22) |
| `event.party.max_guests` | int 1..100 | 10 | 20 §4.10 (R-22) |
| `event.party.price_confirmed` | boolean | false | R-11 / Q-70 |
| `event.prepayment_required` | boolean | false | 11 §7.3, Q-74 (зарезервирован) |
| `event.requests_enabled` | boolean | true | 11 §12 |
| `event.request_hold_hours` | int 1..336 | 48 | решение (ревью 04.11) |
| `event.request_hold_remind_hours` | int 0..168 | 24 | решение |
| `gift.valid_days` | int 1..365 | 60 | 11 §9.1 |
| `gift.room_minutes` | int 30..120 | 40 | 11 §9.1 |
| `gift.start_align_minutes` | int 5..60 | 15 | Q-118 |
| `gift.per_client_days` | int | 365 | R-09 / Q-71 (копия в `EXCLUDE`) |
| `gift.no_show_returns` | boolean | true | Q-114 |

## 18. Проверка (приёмка 11 §16, TC-13, TC-14, 18 §7.4)

- Мероприятие без брони и без профиля; с клиентом-заказчиком; несколько строк; пакет изменён в заказе – шаблон прежний (приёмка 1–4).
- **TC-13**: праздник на комнату VR+PS4 14:00–16:00, 8 гостей – комната занята, `VR1`, `VR2`, `PS4` не продаются отдельно (бронь VR-места на 15:00 → `SLOT_TAKEN`); 14:00–15:30 → `PARTY_TOO_SHORT`; 11 гостей → `PARTY_GUESTS_LIMIT`; ресурс «VR-место 1» → `PARTY_RESOURCE_INVALID`; стол – отдельная строка `catering`; при `price_confirmed = false` строк с ценой из тарифа нет; параллельно 50 попыток брони VR-места и резервирования праздника на тот же час → ровно одна сторона (база).
- Деньги: предоплата наличными + доплата картой – две операции, каждая одного способа; `summary` = 11 §11.3; возврат больше поступления – `EVENT_REFUND_EXCEEDS_INCOME`; расход из карточки виден в журнале кассы одной строкой; привязка кейтеринга из общих расходов – новой операции нет, вторая привязка – `OPERATION_ALREADY_LINKED` (приёмка 7–11).
- Отмена: строки занятости освобождены, финоперации на месте, связанные брони и подарки – в `needsDecision`, а не отменены (приёмка 12).
- **TC-14** (часы теста – 2026 год): подарок выдан 01.06 (Пн) → `validUntil` 31.07; запись 06.06 (Сб) → `GIFT_WEEKDAY_ONLY`; 12.06 (праздник сети) → `GIFT_HOLIDAY`; 01.08 → `GIFT_EXPIRED`; занят один шлем (бронь `VR2`) → `SLOT_TAKEN`; добавить PS4 в удержание подарка → `GIFT_COMPOSITION_INVALID`; запись 40 минут занимает `VR1 + VR2`, не `PS4`; приход → подарок `used`, повторная запись → `GIFT_NOT_ACTIVE`; два параллельных `holdGift` → одна запись; обычная запись на подарочный ресурс без гранта → `RESOURCE_UNAVAILABLE`; второй подарок клиенту в течение года → `GIFT_ALREADY_ISSUED`; подарок не виден в «Мои сертификаты» (приёмка 13–19).
- Отчётность: мероприятия без брони попадают в выборки `reports` (приёмка 20, Э4 – по представлению `rpt_events`, S3-95).
- Аудит (11 §13, приёмка 21): `event.created/updated/status_changed/rescheduled/line_added/line_updated/line_removed/package_applied/resource_reserved/resource_released/booking_linked/checklist_changed`, `event.money_linked`, `gift.issued/cancelled/expired/reserved/used/released`, `holiday.set/cancelled`.
- IDOR: каждый маршрут №361–379 с объектом чужого филиала → `404`; П1–П3 – только своё (`404` на чужой подарок).
