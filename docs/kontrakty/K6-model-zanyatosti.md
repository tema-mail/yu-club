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

/** resources: изменить состав с даты. Старые брони хранят unit_ids снимком и не меняются (02 §8.4).
 *  Возвращает будущие брони и удержания, у которых снимок отличается от нового состава – CRM показывает их. */
export function changeComposition(tx: Tx, input: { resourceId: string; unitIds: string[]; validFrom: Date }, meta: AuditRequestMeta):
  Promise<{ affectedBookingIds: string[] }>;

/** booking: погасить истёкшие удержания на единицах/клиенте в ТЕКУЩЕЙ транзакции, до вставки новых строк.
 *  UPDATE occupancy SET active=false, released_at=now(), release_reason='expired'
 *    WHERE active AND source_type='hold_item' AND hold_expires_at <= now() AND unit_id = ANY($1) AND period && $2;
 *  то же для client_time по client_id; затронутые holds → status 'expired' + hold.expired (K4). */
export function releaseExpiredHolds(tx: Tx, scope: { unitIds?: string[]; clientId?: string; period: Interval }): Promise<{ expiredHoldIds: string[] }>;

/** booking: занять единицы. Все строки одной позиции – одним INSERT; 23P01 по occupancy_no_overlap
 *  переводится в SLOT_TAKEN | SLOT_HELD (по source_type конфликтующей строки, без раскрытия её владельца),
 *  по client_time_no_overlap – в CLIENT_OVERLAP. */
export function occupy(tx: Tx, input: {
  branchId: string; units: UnitSet; period: Interval;
  source: { type: 'hold_item'; id: string; holdExpiresAt: Date } | { type: 'booking'; id: string; version: number } | { type: 'event'; id: string };
  clientId: string | null;            // null → client_time не пишется (посетитель без входа, мероприятие без клиента)
}): Promise<void>;

/** booking: проверка блокировок на единицах (FOR SHARE по resource_block_units). Есть пересечение → RESOURCE_BLOCKED. */
export function assertNotBlocked(tx: Tx, unitIds: string[], period: Interval): Promise<void>;

/** booking: освободить строки источника (отмена, перенос, удаление позиции). */
export function release(tx: Tx, source: { type: 'hold_item' | 'booking' | 'event'; id: string },
  reason: 'released' | 'cancelled' | 'rescheduled' | 'converted'): Promise<void>;

/** booking: перевести строки удержания в бронь без окна свободного слота (K5 confirm, шаг 5). */
export function convertHoldItem(tx: Tx, holdItemId: string, booking: { id: string; version: 1 }): Promise<void>;

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

Строки удержаний с `hold_expires_at <= now` при расчёте игнорируются (даже если задача ещё не погасила их).

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
3. Мероприятие (Э3) занимает комнату через `occupy` с `source.type='event'` – общая таблица, TC-13.
4. Изменение схемы VR-комнаты по ответу заказчика на R-01 – это данные (`resource_units`), не смена таблиц (план 9, риск 1).

## Ошибки

`SLOT_TAKEN`, `SLOT_HELD`, `CLIENT_OVERLAP`, `RESOURCE_UNAVAILABLE`, `RESOURCE_BLOCKED`, `COMPOSITE_CHANGED`, `TARIFF_NOT_CONFIGURED`, `TARIFF_AMBIGUOUS` – значения и HTTP по K5.

## Проверка

6 тестов VR + PS4 (план 8, 18 §5.3) – интеграционные на настоящей Postgres, параллельными соединениями; после каждого прогона SQL-проверка «нет двух активных строк одной единицы с пересечением». Удержание истекло в момент подтверждения → `HOLD_EXPIRED`, слот свободен для следующего.
