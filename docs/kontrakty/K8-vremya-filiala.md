# K8. Время филиала

Модуль: `apps/api/src/core/time.ts` (единственное место, где используется `Temporal`). Шаг: S0-04. Потребители: П4 (окно записи, сетка, выравнивание), П7 (напоминания), П10 (сутки отчётов), CRM (показ во времени филиала).
Основа: ADR 0003; 01 §3, §4, §4.1, §14; 09 §6.1–6.2, §13; 15 §7.1; Q-83; R-17.

## Типы

```ts
export type LocalDate = string & { readonly __brand: 'LocalDate' };   // 'YYYY-MM-DD'
export type LocalTime = string & { readonly __brand: 'LocalTime' };   // 'HH:mm', 00:00..23:59
export type TimeZone  = string & { readonly __brand: 'TimeZone' };    // IANA
export interface Interval { start: Date; end: Date }                  // [start, end), start < end

export interface Clock { now(): Date }
export const systemClock: Clock;
export function fixedClock(at: Date | string): Clock & { set(at: Date | string): void; advance(ms: number): void };  // тесты
```

## Функции

```ts
// ---- разбор и проверка
export function parseLocalDate(s: string): LocalDate;           // не 'YYYY-MM-DD' или нет такой даты → AppError VALIDATION_FAILED
export function parseLocalTime(s: string): LocalTime;
export function isValidTimeZone(tz: string): tz is TimeZone;
export function interval(start: Date, end: Date): Interval;     // start >= end → throw

// ---- перевод
/** Локальные дата+время филиала → момент UTC. Несуществующее время (переход вперёд) сдвигается вперёд,
 *  двойное – раньшее ('compatible'). */
export function localToInstant(date: LocalDate, time: LocalTime, tz: TimeZone): Date;
/** Момент → локальные дата и время филиала (для показа и правил). */
export function instantToLocal(at: Date, tz: TimeZone): { date: LocalDate; time: LocalTime; weekday: 1|2|3|4|5|6|7 };  // ISO, 1 = Пн
export function todayIn(clock: Clock, tz: TimeZone): LocalDate;
export function addDays(date: LocalDate, days: number): LocalDate;

// ---- сутки и окно
/** Сутки филиала [00:00 даты, 00:00 следующей даты) по зоне. В день перехода длина ≠ 24 ч – это правильно. */
export function branchDay(date: LocalDate, tz: TimeZone): Interval;
/** Окно записи (01 §4, 15 §7.1): даты [today, today + days). days=7 → сегодня и 6 следующих (решение). */
export function bookingWindow(clock: Clock, tz: TimeZone, days: number): { from: LocalDate; toExclusive: LocalDate };
export function isDateInWindow(date: LocalDate, clock: Clock, tz: TimeZone, days: number): boolean;

// ---- слоты
/** Начало кратно шагу от локальной полуночи; длительность кратна шагу и ≥ шага; не пересекает локальную полночь.
 *  Нарушение → AppError INVALID_DURATION с details.reason: 'misaligned' | 'too_short' | 'not_multiple' | 'crosses_midnight' | 'empty'. */
export function assertSlotAligned(i: Interval, stepMinutes: number, tz: TimeZone): void;
/** Нарезка интервала на слоты шага (для сетки K6). */
export function splitIntoSlots(i: Interval, stepMinutes: number): Interval[];
/** Открытые часы на дату → интервал UTC (close_time > open_time гарантирует схема). */
export function hoursToInterval(date: LocalDate, open: LocalTime, close: LocalTime, tz: TimeZone): Interval;

// ---- интервалы
export function overlaps(a: Interval, b: Interval): boolean;    // a.start < b.end && b.start < a.end
export function contains(outer: Interval, inner: Interval): boolean;
export function durationMinutes(i: Interval): number;
/** В/из Postgres: '[2026-11-15 07:00:00+00,2026-11-15 07:30:00+00)'. Только '[)'. */
export function toPgRange(i: Interval): string;
export function fromPgRange(s: string): Interval;               // не '[)' или бесконечная граница → throw

// ---- напоминания (П7)
/** «Накануне в 21:00 по филиалу» (09 §6.1). null, если этот момент ≤ createdAt (запись после 21:00 накануне
 *  или в день сеанса) – просроченное не планируем (R-17, 01 §14 п.4). */
export function reminderDayBefore(sessionStart: Date, tz: TimeZone, at: LocalTime /* '21:00' из K7 */, createdAt: Date): Date | null;
/** «За N минут» (09 §6.2). null, если момент ≤ createdAt. */
export function reminderBeforeStart(sessionStart: Date, minutes: number, createdAt: Date): Date | null;

// ---- показ
/** '15 ноября, 14:00' в зоне филиала, русская локаль. Для текстов push и CRM. */
export function formatLocal(at: Date, tz: TimeZone, style: 'date' | 'time' | 'datetime'): string;
```

## Правила

1. Код модулей не вызывает `getHours/getDate/setHours/toLocale*` без зоны и не создаёт `Temporal` сам (ADR 0003 п.9).
2. Зона берётся из филиала (`branches.timezone`), для показа старой брони – из `booking_versions.branch_timezone`.
3. День недели – ISO (1 = Пн), так же в `branch_weekly_hours.weekday`.
4. «Сегодня» у разных филиалов разное: окно записи считается от `todayIn(clock, tz филиала)`.
5. Расхождение 09 §6.1: «менее чем за сутки до начала – не отправлять» против «до 21:00 мало времени – всё равно отправить в 21:00». Принято второе: отправляем, если момент 21:00 накануне ещё впереди (решение; так же в плане 2.2, R-17).

## Проверка (S0-04)

Таблица кейсов, прогон с `TZ=America/New_York` процесса:
- Москва (`Europe/Moscow`), Новосибирск (`Asia/Novosibirsk`, +4 к Москве), Калининград (`Europe/Kaliningrad`), тестовая зона с переходом (`Europe/Berlin`: 29.03.2026 02:30 не существует, 25.10.2026 02:30 – дважды).
- `branchDay` в день перехода – 23 и 25 часов.
- `[14:00,14:30)` и `[14:30,15:00)` не пересекаются; `[14:00,14:30)` и `[14:15,15:15)` – пересекаются.
- `reminderDayBefore`: сеанс 15.11 10:00 НСК, бронь 14.11 12:00 → 14.11 21:00 НСК (= 14:00Z); бронь 14.11 21:30 → `null`; сеанс 15.11 00:30 (если график позволит) – 14.11 21:00.
- `reminderBeforeStart`: бронь за 10 мин до начала → `null`.
- `assertSlotAligned`: VR 14:10–14:25 → `misaligned`; ПК 14:00–14:15 → `too_short`; 21:30–00:30 → `crosses_midnight`.
- `bookingWindow(days=7)` 01.11 → `[01.11, 08.11)`.
