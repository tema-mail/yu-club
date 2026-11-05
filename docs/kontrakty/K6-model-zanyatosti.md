# K6. Модель занятости: единицы, составные конфигурации, снимок

Модули: `resources` (единицы и состав: `apps/api/src/modules/resources/composite.ts`, S1-02), `booking` (строки занятости, доступность: `availability.ts`, S1-05), `pricing` (снимок цены, S1-14). Таблицы: `occupancy_units`, `resource_units`, `occupancy`, `client_time`, `resource_block_units` (model-dannyh 0102, 0104, 0108).
Потребители: П4 (брони), П9b (оборудование и ремонт → блокировки, Э3), П9c (мероприятия занимают комнату, Э3), П6 через K5.
Основа: 01 §5, §8; 02 §3.4–3.6, §8.3–8.4; 15 §7.5; 16 §4; 17 §10; R-01 / Q-08 по умолчанию.

## Модель

- **Ресурс** (`resources`) – то, что выбирает клиент: «ПК-3», «VR-место 1», «VR-место 2», «VR-комната целиком», «PS5-комната 2».
- **Единица занятости** (`occupancy_units`) – то, что физически нельзя отдать двоим: `PC3`, `VR1`, `VR2`, `PS4`, `PS5-2`.
- **Состав** (`resource_units`) – какие единицы занимает ресурс, с периодом действия. Обычный ресурс → одна своя единица; составной → несколько.
- **Занятость** (`occupancy`) – строка на (единица, интервал, источник). Пересечение активных строк одной единицы запрещено базой (`occupancy_no_overlap`).
- **Время клиента** (`client_time`) – строка на (клиент, интервал, источник). Пересечение запрещено базой (`client_time_no_overlap`).

Стартовая VR-комната (R-01 по умолчанию, 01 §5.1–5.2):

| Ресурс | `self_bookable` | Состав (единицы) |
|---|---|---|
| VR-место 1 (`vr_seat`) | да | `VR1` |
| VR-место 2 (`vr_seat`) | да | `VR2` |
| VR-комната целиком (`room_whole`) | да | `VR1`, `VR2`, `PS4` |
| PS4 | ресурса нет | единица `PS4` существует только в составе комнаты (01 §5.2: отдельно не предлагается) |

Следствия, которые даёт база без кода: место VR и комната на пересекающееся время – конфликт по `VR1`/`VR2`; два места VR одновременно – нет конфликта (TC-02); отмена комнаты гасит только строки своей брони (18 §5.3 п.5–6). Подарок имениннику (Э3, Q-72) – отдельный ресурс `composite` «2 VR без PS4» = `VR1`, `VR2`, одна бронь одного клиента.

## Типы и функции

```ts
export interface UnitSet { resourceId: string; unitIds: string[] }   // отсортированы по id

/** resources: развернуть ресурс в единицы на момент `at` (состав, действующий на начало интервала).
 *  Ошибки: ресурс/комната не active, self_bookable=false, пустой состав → RESOURCE_UNAVAILABLE. */
export function expandToUnits(tx: Tx, resourceId: string, at: Date): Promise<UnitSet>;

/** resources: изменить состав с даты. Прошлые брони хранят unit_ids снимком и не меняются (02 §8.4).
 *  Если есть активные брони/удержания ресурса с end > validFrom – ОТКАЗ COMPOSITION_HAS_FUTURE_BOOKINGS
 *  со списком (details.bookingIds, details.holdIds): каждую сотрудник решает вручную (перенос/отмена), по духу
 *  01 §12–13 «не удалять и не переносить автоматически». Потом – повтор или validFrom после последней брони.
 *  Можно вызвать с dryRun: true – только список, без изменений (CRM показывает его до сохранения, 15 §8.3). */
export function changeComposition(tx: Tx, input: { resourceId: string; unitIds: string[]; validFrom: Date; dryRun?: boolean }, meta: AuditRequestMeta):
  Promise<{ affectedBookingIds: string[]; affectedHoldIds: string[]; applied: boolean }>;

/** booking: погасить истёкшие удержания на единицах/клиенте в ТЕКУЩЕЙ транзакции, до вставки новых строк.
 *  1) найти кандидатов и заблокировать удержания по id:
 *     SELECT h.id FROM holds h WHERE h.status='active' AND h.expires_at <= $now AND h.id IN (
 *       SELECT hi.hold_id FROM occupancy o JOIN hold_items hi ON hi.id = o.source_id
 *        WHERE o.active AND o.source_type='hold_item' AND o.unit_id = ANY($units) AND o.period && $period
 *       UNION SELECT hi.hold_id FROM client_time ct JOIN hold_items hi ON hi.id = ct.source_id
 *        WHERE ct.active AND ct.source_type='hold_item' AND ct.client_id = $client AND ct.period && $period)
 *     ORDER BY h.id FOR UPDATE SKIP LOCKED;
 *     (заблокированное другим – его сейчас подтверждают или гасят; не ждём, конфликт вставки даст SLOT_HELD)
 *  2) для найденных: occupancy и client_time их позиций → active=false, released_at=$now, release_reason='expired';
 *     hold_items → 'expired'; holds → status 'expired', closed_at=$now; hold.expired (K4) на каждое.
 *  $now – из Clock команды (ADR 0003 п.10), не now(). */
export function releaseExpiredHolds(tx: Tx, now: Date, scope: { unitIds?: string[]; clientId?: string; period: Interval }): Promise<{ expiredHoldIds: string[] }>;

/** booking: занять единицы. Порядок внутри:
 *  0) SELECT … FROM app.resources WHERE id=$1 FOR SHARE – против FOR UPDATE в changeComposition (ревизия S1-02, 01.11);
 *  1) SELECT id FROM occupancy_units WHERE id = ANY($units) ORDER BY id FOR NO KEY UPDATE – видимость против блокировок
 *     и сериализация записей одной единицы (FOR SHARE давал 40P01 на взаимной проверке EXCLUDE; решение 01.11 по ревизии);
 *     так же берут convertHoldItem и перенос. В этой транзакции – никаких внешних вызовов (оплата, push): только outbox.
 *     Цена – занятия одной единицы идут по одному до COMMIT;
 *  2) assertNotBlocked;
 *  3) ВСЕ строки команды (всех позиций) – одним INSERT ... SELECT ... ORDER BY unit_id; затем client_time одним INSERT;
 *  4) 23P01 по occupancy_no_overlap → SLOT_TAKEN | SLOT_HELD (по source_type конфликтующей строки, без раскрытия
 *     владельца); по client_time_no_overlap → CLIENT_OVERLAP; 40P01/40001 → повтор команды один раз, затем SLOT_HELD
 *     (ADR 0004 §3). */
export function occupy(tx: Tx, input: {
  branchId: string; units: UnitSet; period: Interval;
  source: { type: 'hold_item'; id: string; holdExpiresAt: Date } | { type: 'booking'; id: string; version: number } | { type: 'event'; id: string };
  clientId: string | null;            // null → client_time не пишется (посетитель без входа, мероприятие без клиента)
}): Promise<void>;

/** booking: проверка блокировок на единицах (после FOR NO KEY UPDATE на occupancy_units). Есть пересечение → RESOURCE_BLOCKED. */
export function assertNotBlocked(tx: Tx, unitIds: string[], period: Interval): Promise<void>;

/** booking: создать блокировку (S1-04). Порядок: SELECT ... FROM occupancy_units WHERE id = ANY($units) ORDER BY id
 *  FOR UPDATE → INSERT resource_blocks + resource_block_units → список затронутых активных строк occupancy
 *  (брони и удержания) на этих единицах. FOR UPDATE против FOR NO KEY UPDATE из occupy сериализует гонку
 *  «удержание против блокировки»: либо блокировка видит новую бронь в списке затронутых, либо удержание видит
 *  блокировку и получает RESOURCE_BLOCKED. Брони не трогаются (01 §13). */
export function createBlock(tx: Tx, ctx: AccessContext, input: {
  branchId: string; target: { type: 'unit' | 'resource' | 'room' | 'resources'; ids: string[] }; period: Interval;
  reasonId: string; comment?: string;
}, meta: AuditRequestMeta): Promise<{ blockId: string; affectedBookingIds: string[]; affectedHoldIds: string[] }>;

/** booking: освободить строки источника (отмена, перенос, удаление позиции). */
export function release(tx: Tx, source: { type: 'hold_item' | 'booking' | 'event'; id: string },
  reason: 'released' | 'cancelled' | 'rescheduled' | 'converted'): Promise<void>;

/** booking: перевести строки удержания в бронь без окна свободного слота (K5 confirm, шаг 5).
 *  UPDATE occupancy SET source_type='booking', source_id=$booking, booking_version=1, hold_expires_at=NULL
 *   WHERE active AND source_type='hold_item' AND source_id=$item AND hold_expires_at > $now RETURNING unit_id;
 *  число строк < hold_items.unit_ids.length (часть погашена истечением) → HOLD_EXPIRED, вся транзакция откатывается.
 *  Так же client_time (ожидается ровно 1 строка, если у удержания есть клиент). */
export function convertHoldItem(tx: Tx, now: Date, holdItemId: string, booking: { id: string; version: 1 }): Promise<void>;

/** booking: сетка доступности для K5 №5 и CRM-календаря. Без записи, читает снимок на момент запроса. */
export function availability(db: Db, input: {
  branchId: string; date: LocalDate; resourceIds?: string[];
  viewer: { visitorId?: string; clientId?: string };   // для состояния 'mine'
}): Promise<AvailabilityDto>;                           // K5
```

### Состояние слота (01 §6.3, приоритет сверху вниз)

| Состояние | Условие для слота `[s, s+step)` ресурса |
|---|---|
| `closed` | вне открытых интервалов дня (график + исключения ресурс → комната → филиал → неделя, 15 §6.3) или комната/ресурс не `active` |
| `blocked` | любая единица состава пересекается с активной `resource_block_units` |
| `mine` | все пересечения единиц – с позициями удержания этого же посетителя/клиента |
| `booked` | пересечение с активной строкой `booking` или `event` |
| `held` | пересечение с активной `hold_item` другого владельца и `hold_expires_at > now` |
| `free` | иначе |

Строки удержаний с `hold_expires_at <= $now` при расчёте игнорируются (даже если задача ещё не погасила их).

## Цена (pricing, S1-14)

```ts
export interface Quote {
  tariffId: string; priceKop: number;
  snapshot: { tariffName: string; unitMinutes: number; pricePerUnitKop: number; units: number };
}
/** Тариф по филиалу, типу ресурса, моменту начала и длительности; status='active', valid на start.
 *  0 подходящих → TARIFF_NOT_CONFIGURED; ≥2 с наибольшим одинаковым priority → TARIFF_AMBIGUOUS. */
export function quote(tx: Tx, input: { branchId: string; resourceType: string; start: Date; durationMinutes: number }): Promise<Quote>;
```
Снимок цены и состава кладётся в `booking_versions` (`price_kop`, `price_snapshot`, `unit_ids`, `resource_snapshot`). Смена тарифа или состава не меняет созданные брони (15 §9.4, 02 §8.4).

## Правила

1. Код не проверяет пересечения «вручную» перед вставкой как гарантию – гарантию даёт `EXCLUDE`; предварительный `SELECT` допустим только ради понятного сообщения.
2. Блокировки не пишутся в `occupancy` (ложатся поверх броней, 01 §13); проверка `assertNotBlocked` – в той же транзакции, что и `occupy`.
3. Мероприятие (Э3) занимает комнату через `occupy` с `source.type='event'` – общая таблица, TC-13. Источник строки – `event_resources.id` (строка ресурса мероприятия), не `events.id`: у мероприятия несколько ресурсов и интервалов, каждый освобождается отдельно (K20 §1 п.2; правка S3-00 04.11). Модуль events не импортирует `occupancy.ts`: занятие, освобождение и перенос – провайдеры booking `occupyForEvent` / `releaseEvent` / `moveEventOccupancy` (ниже, S3-09).
4. Изменение схемы VR-комнаты по ответу заказчика на R-01 – это данные (`resource_units`), не смена таблиц (план 9, риск 1).

## Дополнения Э3 (внесено S3-00 04.11.2026; K19 §4, §8, K20 §4, §8)

```ts
// booking/providers.ts (S3-09) – межмодульные вызовы Э3; модули equipment и events ходят только сюда.
/** Будущие брони, удержания и мероприятия на единицах с момента from (перемещение оборудования, K19 §4). */
export function bookingsOnUnits(db, unitIds: string[], from: Date): Promise<{ bookingIds: string[]; holdIds: string[]; eventIds: string[] }>;
/** Предпросмотр блокировки: те же затронутые, что дал бы createBlock, без записи (K19 §8 BlockProposal). */
export function previewBlock(db, input: { branchId; target; period }): Promise<{ unitIds: string[]; bookingIds: string[]; holdIds: string[]; eventIds: string[] }>;
/** Мероприятие занимает ресурс: occupy(source { type:'event', id: eventResourceId }), assertNotBlocked, clientId = null. */
export function occupyForEvent(tx, input: { branchId; resourceId; eventResourceId; period }): Promise<{ unitIds: string[] }>;
/** Освободить строки одного event_resources (не всего мероприятия). */
export function releaseEvent(tx, eventResourceId: string, reason: 'released' | 'cancelled' | 'rescheduled'): Promise<void>;
/** Перенос: старые строки источника гасятся, новые вставляются в той же транзакции; конфликт – откат, прежнее время цело. */
export function moveEventOccupancy(tx, input: { branchId; resourceId; eventResourceId; period }): Promise<{ unitIds: string[] }>;
/** Блокировка по команде equipment (ремонт, K19 §8): createBlock с проверкой block.manage. */
export function createBlockFor(tx, ctx, input: Parameters<typeof createBlock>[2], meta): ReturnType<typeof createBlock> & { affectedEventIds: string[] };
/** Блокировка по id; снятие по решению сотрудника с block.manage (закрытие ремонта, K19 §7); строки CRM затронутых броней с маской телефона (K19 §8). */
export function blockInfo(db, blockId: string): Promise<BlockInfo | null>;
export function liftBlockFor(tx, ctx, blockId: string, input: { comment?: string }, meta): Promise<BlockInfo>;
export function bookingRowsByIds(db, ids: string[], now: Date): Promise<CrmBookingRow[]>;
```

- `createBlock` (`affectedEventIds`) и `previewBlock` (`eventIds`) возвращают затронутые мероприятия отдельным списком, не в `bookingIds` (K19 §8 `affectedEvents`); общий источник – `affectedOnUnits` в `blocks.ts`. Преобразование «строки `event_resources` → мероприятие» регистрирует модуль events (`registerEventSourceResolver`, S3-52): booking его не импортирует, а таблицы `event_resources` до 0305 нет; без регистрации в списке – id строк источника (решение S3-09). `eventOccupancy(db, eventResourceId)` – активные строки источника для проверок.
- **Грант бронирования** (K5 «Дополнения Э3», S3-58): необязательный `serviceGrant { kind, id }` у `createHold`, `addHoldItem`, CRM-брони и переноса; ресурс `self_bookable=false` без гранта – `RESOURCE_UNAVAILABLE`, как в Э1; с грантом – валидатор `registerServiceGrant(resourceType, validator)` в той же транзакции до `occupy`, его ошибки проходят как есть (`GIFT_*`).

## Ошибки

`SLOT_TAKEN`, `SLOT_HELD`, `CLIENT_OVERLAP`, `RESOURCE_UNAVAILABLE`, `RESOURCE_BLOCKED`, `COMPOSITE_CHANGED`, `HOLD_EXPIRED`, `TARIFF_NOT_CONFIGURED`, `TARIFF_AMBIGUOUS` – значения и HTTP по K5. `COMPOSITION_HAS_FUTURE_BOOKINGS` – 409, `details: { bookingIds, holdIds }`.

## Проверка

6 тестов VR + PS4 (план 8, 18 §5.3) – интеграционные на настоящей Postgres, параллельными соединениями; после каждого прогона SQL-проверка «нет двух активных строк одной единицы с пересечением». Удержание истекло в момент подтверждения → `HOLD_EXPIRED`, слот свободен для следующего. 50 параллельных подтверждений одного слота – на пуле ≥ 50 соединений, ровно одна бронь. Гонка «блокировка ↔ удержание» 100 раз: каждая пара даёт либо `RESOURCE_BLOCKED`, либо бронь в `affectedBookingIds`.
