// K8. Время филиала. Единственное место, где используется Temporal (ADR 0003 п.9).
// Наружу – только Date (момент UTC) и брендированные строки LocalDate / LocalTime / TimeZone.
// Результат не зависит от TZ процесса: все вычисления идут через явную зону филиала.
import { AppError } from './errors.ts';

export type LocalDate = string & { readonly __brand: 'LocalDate' }; // 'YYYY-MM-DD'
export type LocalTime = string & { readonly __brand: 'LocalTime' }; // 'HH:mm', 00:00..23:59
export type TimeZone = string & { readonly __brand: 'TimeZone' }; // IANA
export interface Interval {
  start: Date;
  end: Date;
} // [start, end), start < end

const MS_PER_MINUTE = 60_000;

// ---- часы

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(
  at: Date | string,
): Clock & { set(at: Date | string): void; advance(ms: number): void } {
  let ms = toMs(at);
  return {
    now: () => new Date(ms),
    set: (next) => {
      ms = toMs(next);
    },
    advance: (delta) => {
      ms += delta;
    },
  };
}

function toMs(at: Date | string): number {
  const ms = typeof at === 'string' ? Temporal.Instant.from(at).epochMilliseconds : at.getTime();
  if (!Number.isFinite(ms)) throw new Error(`fixedClock: неверный момент ${String(at)}`);
  return ms;
}

// ---- разбор и проверка

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseLocalDate(s: string): LocalDate {
  if (DATE_RE.test(s)) {
    try {
      return Temporal.PlainDate.from(s, { overflow: 'reject' }).toString() as LocalDate;
    } catch {
      // нет такой даты – ниже
    }
  }
  throw new AppError('VALIDATION_FAILED', 400, 'Неверная дата', { value: s, expected: 'YYYY-MM-DD' });
}

export function parseLocalTime(s: string): LocalTime {
  if (!TIME_RE.test(s)) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверное время', { value: s, expected: 'HH:mm' });
  }
  return s as LocalTime;
}

export function isValidTimeZone(tz: string): tz is TimeZone {
  if (tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('ru', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function interval(start: Date, end: Date): Interval {
  const s = start.getTime();
  const e = end.getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error('interval: неверная граница');
  if (s >= e) throw new Error(`interval: начало ${start.toISOString()} не раньше конца ${end.toISOString()}`);
  return { start: new Date(s), end: new Date(e) };
}

// ---- перевод

function toInstant(at: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime());
}

function toZoned(at: Date, tz: TimeZone): Temporal.ZonedDateTime {
  return toInstant(at).toZonedDateTimeISO(tz);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Локальные дата+время филиала → момент UTC. Несуществующее время (переход вперёд) сдвигается вперёд,
 *  двойное – раньшее ('compatible'). */
export function localToInstant(date: LocalDate, time: LocalTime, tz: TimeZone): Date {
  const pd = Temporal.PlainDate.from(date, { overflow: 'reject' });
  const pt = Temporal.PlainTime.from(time, { overflow: 'reject' });
  const zdt = pd.toPlainDateTime(pt).toZonedDateTime(tz, { disambiguation: 'compatible' });
  return new Date(zdt.epochMilliseconds);
}

/** Момент → локальные дата и время филиала (для показа и правил). */
export function instantToLocal(
  at: Date,
  tz: TimeZone,
): { date: LocalDate; time: LocalTime; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7 } {
  const z = toZoned(at, tz);
  return {
    date: z.toPlainDate().toString() as LocalDate,
    time: `${pad2(z.hour)}:${pad2(z.minute)}` as LocalTime,
    weekday: z.dayOfWeek as 1 | 2 | 3 | 4 | 5 | 6 | 7,
  };
}

export function todayIn(clock: Clock, tz: TimeZone): LocalDate {
  return instantToLocal(clock.now(), tz).date;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) throw new Error(`addDays: дни должны быть целыми, получено ${days}`);
  return Temporal.PlainDate.from(date, { overflow: 'reject' }).add({ days }).toString() as LocalDate;
}

// ---- сутки и окно

/** Сутки филиала [00:00 даты, 00:00 следующей даты) по зоне. В день перехода длина ≠ 24 ч – это правильно. */
export function branchDay(date: LocalDate, tz: TimeZone): Interval {
  const pd = Temporal.PlainDate.from(date, { overflow: 'reject' });
  const start = pd.toZonedDateTime(tz); // начало суток, Temporal учитывает переход в полночь
  const end = pd.add({ days: 1 }).toZonedDateTime(tz);
  return interval(new Date(start.epochMilliseconds), new Date(end.epochMilliseconds));
}

/** Окно записи (01 §4, 15 §7.1): даты [today, today + days). days=7 → сегодня и 6 следующих (решение). */
export function bookingWindow(
  clock: Clock,
  tz: TimeZone,
  days: number,
): { from: LocalDate; toExclusive: LocalDate } {
  if (!Number.isInteger(days) || days < 1) throw new Error(`bookingWindow: days ≥ 1, получено ${days}`);
  const from = todayIn(clock, tz);
  return { from, toExclusive: addDays(from, days) };
}

export function isDateInWindow(date: LocalDate, clock: Clock, tz: TimeZone, days: number): boolean {
  const w = bookingWindow(clock, tz, days);
  const d = Temporal.PlainDate.from(date, { overflow: 'reject' });
  return (
    Temporal.PlainDate.compare(d, Temporal.PlainDate.from(w.from)) >= 0 &&
    Temporal.PlainDate.compare(d, Temporal.PlainDate.from(w.toExclusive)) < 0
  );
}

// ---- слоты

type SlotReason = 'misaligned' | 'too_short' | 'not_multiple' | 'crosses_midnight' | 'empty';

function invalidDuration(reason: SlotReason, stepMinutes: number): AppError {
  return new AppError('INVALID_DURATION', 422, `Выберите время кратно ${stepMinutes} минутам`, {
    reason,
    stepMinutes,
  });
}

function assertStep(stepMinutes: number): void {
  if (!Number.isInteger(stepMinutes) || stepMinutes < 1) {
    throw new Error(`шаг должен быть целым числом минут ≥ 1, получено ${stepMinutes}`);
  }
}

/** Начало кратно шагу от локальной полуночи; длительность кратна шагу и ≥ шага; не пересекает локальную полночь.
 *  Нарушение → AppError INVALID_DURATION с details.reason. */
export function assertSlotAligned(i: Interval, stepMinutes: number, tz: TimeZone): void {
  assertStep(stepMinutes);
  const s = i.start.getTime();
  const e = i.end.getTime();
  if (!(s < e)) throw invalidDuration('empty', stepMinutes);

  const z = toZoned(i.start, tz);
  const minuteOfDay = z.hour * 60 + z.minute;
  const subMinute = z.second !== 0 || z.millisecond !== 0 || z.microsecond !== 0 || z.nanosecond !== 0;
  if (subMinute || minuteOfDay % stepMinutes !== 0) throw invalidDuration('misaligned', stepMinutes);

  const stepMs = stepMinutes * MS_PER_MINUTE;
  const len = e - s;
  if (len < stepMs) throw invalidDuration('too_short', stepMinutes);
  if (len % stepMs !== 0) throw invalidDuration('not_multiple', stepMinutes);

  const day = branchDay(z.toPlainDate().toString() as LocalDate, tz);
  if (e > day.end.getTime()) throw invalidDuration('crosses_midnight', stepMinutes);
}

/** Нарезка интервала на слоты шага (для сетки K6). Длина интервала должна быть кратна шагу. */
export function splitIntoSlots(i: Interval, stepMinutes: number): Interval[] {
  assertStep(stepMinutes);
  const stepMs = stepMinutes * MS_PER_MINUTE;
  const s = i.start.getTime();
  const e = i.end.getTime();
  if (!(s < e)) throw invalidDuration('empty', stepMinutes);
  if ((e - s) % stepMs !== 0) throw invalidDuration('not_multiple', stepMinutes);
  const out: Interval[] = [];
  for (let t = s; t < e; t += stepMs) out.push({ start: new Date(t), end: new Date(t + stepMs) });
  return out;
}

/** Открытые часы на дату → интервал UTC (close_time > open_time гарантирует схема). */
export function hoursToInterval(date: LocalDate, open: LocalTime, close: LocalTime, tz: TimeZone): Interval {
  return interval(localToInstant(date, open, tz), localToInstant(date, close, tz));
}

// ---- интервалы

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime();
}

export function durationMinutes(i: Interval): number {
  return (i.end.getTime() - i.start.getTime()) / MS_PER_MINUTE;
}

function pgTimestamp(at: Date): string {
  // '2026-11-15T07:00:00.000Z' → '2026-11-15 07:00:00+00' (доли секунды – только если есть)
  const iso = at.toISOString();
  const ms = iso.slice(20, 23);
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${ms === '000' ? '' : `.${ms}`}+00`;
}

/** В/из Postgres: '[2026-11-15 07:00:00+00,2026-11-15 07:30:00+00)'. Только '[)'. */
export function toPgRange(i: Interval): string {
  const checked = interval(i.start, i.end);
  return `[${pgTimestamp(checked.start)},${pgTimestamp(checked.end)})`;
}

const PG_RANGE_RE = /^\[("?)([^",()[\]]+)\1,("?)([^",()[\]]+)\3\)$/;
const PG_TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)([+-]\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/;

function parsePgTimestamp(s: string, whole: string): Date {
  const m = PG_TS_RE.exec(s.trim());
  if (!m) throw new Error(`fromPgRange: неверная граница «${s}» в ${whole}`);
  const [, d, t, h, mm = '00', ss] = m;
  const offset = `${h}:${mm}${ss !== undefined ? `:${ss}` : ''}`;
  return new Date(Temporal.Instant.from(`${d}T${t}${offset}`).epochMilliseconds);
}

export function fromPgRange(s: string): Interval {
  const m = PG_RANGE_RE.exec(s.trim());
  if (!m) throw new Error(`fromPgRange: ожидается диапазон '[)' с конечными границами, получено ${s}`);
  const [, , a = '', , b = ''] = m;
  if (/infinity/i.test(a) || /infinity/i.test(b)) throw new Error(`fromPgRange: бесконечная граница в ${s}`);
  return interval(parsePgTimestamp(a, s), parsePgTimestamp(b, s));
}

// ---- напоминания (П7)

/** «Накануне в 21:00 по филиалу» (09 §6.1). null, если этот момент ≤ createdAt (запись после 21:00 накануне
 *  или в день сеанса) – просроченное не планируем (R-17, 01 §14 п.4). */
export function reminderDayBefore(sessionStart: Date, tz: TimeZone, at: LocalTime, createdAt: Date): Date | null {
  const sessionDate = instantToLocal(sessionStart, tz).date;
  const moment = localToInstant(addDays(sessionDate, -1), at, tz);
  return moment.getTime() > createdAt.getTime() ? moment : null;
}

/** «За N минут» (09 §6.2). null, если момент ≤ createdAt. */
export function reminderBeforeStart(sessionStart: Date, minutes: number, createdAt: Date): Date | null {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`reminderBeforeStart: минуты ≥ 0, получено ${minutes}`);
  const moment = new Date(sessionStart.getTime() - minutes * MS_PER_MINUTE);
  return moment.getTime() > createdAt.getTime() ? moment : null;
}

// ---- показ

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: TimeZone, kind: 'date' | 'time'): Intl.DateTimeFormat {
  const key = `${kind}|${tz}`;
  let f = formatters.get(key);
  if (!f) {
    f =
      kind === 'date'
        ? new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long' })
        : new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(key, f);
  }
  return f;
}

/** '15 ноября, 14:00' в зоне филиала, русская локаль. Для текстов push и CRM. */
export function formatLocal(at: Date, tz: TimeZone, style: 'date' | 'time' | 'datetime'): string {
  if (style === 'date') return formatter(tz, 'date').format(at);
  if (style === 'time') return formatter(tz, 'time').format(at);
  return `${formatter(tz, 'date').format(at)}, ${formatter(tz, 'time').format(at)}`;
}
