# K13. Публичные входы модулей `network` и `resources`

Файлы: `apps/api/src/modules/network/index.ts` (S0-11, S1-03), `apps/api/src/modules/resources/index.ts` (S1-01, S1-02). Другие модули читают сеть и ресурсы **только** через эти функции (ADR 0002 п.1–2).
Потребители: `booking` (K5, K6, K11), `notifications` (зона и название филиала), `pricing`, `clients` (зона для поиска), сайт и CRM через маршруты.
Основа: 01 §4.1, §5; 02 §5–8, §12; 15 §5–6; ADR 0003; K8.

## network

```ts
export type BranchStatus = 'preparing' | 'active' | 'temporarily_closed' | 'archived';

export interface BranchInfo {
  id: string; cityId: string; citySlug: string; cityName: string;
  slug: string; name: string; address: string; timezone: TimeZone; status: BranchStatus;
  tempClosed: { from: Date; to: Date | null; reason: string } | null;
}

/** Один филиал. Нет → null (вызывающий решает, NOT_FOUND или ошибка программиста). */
export function getBranch(db: Db | Tx, branchId: string): Promise<BranchInfo | null>;
export function getBranches(db: Db | Tx, branchIds: string[]): Promise<Map<string, BranchInfo>>;

/** Принимает ли филиал НОВЫЕ записи на момент `at`: status='active' и не во временном закрытии. */
export function isAcceptingBookings(b: BranchInfo, at: Date): boolean;

/** Филиалы городов – для K1 loadAccess (city → branches). */
export function branchIdsOfCities(db: Db | Tx, cityIds: string[]): Promise<string[]>;

/** Открытые интервалы дня (UTC) для филиала/комнаты/ресурса с приоритетом 15 §6.3:
 *  исключение ресурса → исключение комнаты → исключение филиала → branch_weekly_hours на дату.
 *  closed/holiday/technical → []; short_day/special_hours → часы исключения; иначе недельный график.
 *  Не через полночь (ADR 0003 п.6). Перевод – K8 hoursToInterval по зоне филиала. */
export function openIntervals(db: Db | Tx, input: { branchId: string; date: LocalDate; roomId?: string | null; resourceId?: string }): Promise<Interval[]>;

/** Для сетки сразу по многим ресурсам одного дня – один запрос. */
export function openIntervalsBulk(db: Db | Tx, input: { branchId: string; date: LocalDate; resources: Array<{ resourceId: string; roomId: string | null }> }): Promise<Map<string, Interval[]>>;

/** Изменение графика/исключения: до сохранения – список затронутых будущих броней (15 §6.5, 01 §4.1 п.5).
 *  Брони не отменяются и не переносятся автоматически. Вызов booking.findBookingsOutside – через index booking. */
export function previewHoursChange(db: Db, ctx: AccessContext, input: HoursChange): Promise<{ affectedBookingIds: string[] }>;
export function applyHoursChange(tx: Tx, ctx: AccessContext, input: HoursChange & { confirmedAffected: string[] }, meta: AuditRequestMeta): Promise<void>;
// confirmedAffected ≠ текущему списку → 409 AFFECTED_CHANGED (список обновился, показать заново)

export type HoursChange =
  | { kind: 'weekly'; branchId: string; validFrom: LocalDate; days: Array<{ weekday: 1|2|3|4|5|6|7; open: LocalTime | null; close: LocalTime | null }> }
  | { kind: 'exception'; branchId: string; scope: { type: 'branch' } | { type: 'room'; id: string } | { type: 'resource'; id: string };
      date: LocalDate; exceptionKind: 'closed' | 'short_day' | 'special_hours' | 'holiday' | 'technical'; open?: LocalTime; close?: LocalTime; reason: string };
```

Смена зоны филиала (`timezone`) – отдельная команда `changeBranchTimezone`: прошлые события не сдвигаются (ADR 0003 п.8), будущие брони возвращаются списком затронутых.

## resources

```ts
export interface ResourceInfo {
  id: string; branchId: string; roomId: string | null; roomName: string | null; roomStatus: string | null;
  type: string; name: string; status: 'active' | 'unavailable' | 'archived';
  selfBookable: boolean; stepMinutes: number;      // override ?? dict_resource_types.step_minutes (15 §7.2)
  zone: 'pc' | 'vr' | 'ps';                        // pc ← pc; vr ← vr_seat, room_whole/composite в VR-комнате; ps ← ps_room
}

export function getResource(db: Db | Tx, resourceId: string): Promise<ResourceInfo | null>;
/** Для сайта и сетки: только active, selfBookable, комната active и published (02 §7.4). */
export function listBookableResources(db: Db | Tx, branchId: string, zone?: ResourceInfo['zone']): Promise<ResourceInfo[]>;
/** Бронируем ли сейчас: active + selfBookable + комната active (02 §7.3). Иначе RESOURCE_UNAVAILABLE. */
export function assertBookable(r: ResourceInfo): void;

// Состав и единицы – K6:
export { expandToUnits, changeComposition } from './composite';
```

## Ошибки

`NOT_FOUND`, `RESOURCE_UNAVAILABLE` (K5), `AFFECTED_CHANGED` (409), `SCHEDULE_CONFLICT` (409 – два исключения на объект и дату, ловит EXCLUDE `calendar_exceptions`), `INVALID_HOURS` (422 – `close ≤ open`), `CITY_HAS_ACTIVE_BRANCHES` (409 – архив города, 02 §5.2), `OBJECT_IN_USE` (409 – физическое удаление использованного объекта, 02 §12).

## Проверка

`openIntervals`: недельный 10–22; исключение филиала «сокращённый 10–18»; исключение комнаты «закрыто» перекрывает филиальное; исключение ресурса «спецчасы» перекрывает комнату; по зонам Москва и Новосибирск – разные UTC для одних «10:00». `previewHoursChange` на сокращении часов возвращает бронь 20:00–21:00, после `applyHoursChange` бронь `confirmed` (TC-17 частично).
