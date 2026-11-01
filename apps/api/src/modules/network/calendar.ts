// S1-03. Календарь филиала: недельный график + исключения (сокращённый день, закрытие, спецграфик) – K13, 15 §6.2–6.3.
// Приоритет на дату: исключение ресурса → комнаты → филиала → branch_weekly_hours (15 §6.3).
// closed / holiday / technical → []; short_day / special_hours → часы исключения; иначе недельный график.
// Через полночь – нет (ADR 0003 п.6). Перевод в UTC – только core/time.ts по зоне филиала (K8).
// Таблицы: 0008 branch_weekly_hours, 0103 calendar_exceptions. index.ts не импортируется (он импортирует этот файл).
import type { Db, Tx } from '../../core/audit.ts';
import { hoursToInterval, isValidTimeZone, type Interval, type LocalDate, type LocalTime, type TimeZone } from '../../core/time.ts';

export type ExceptionKind = 'closed' | 'short_day' | 'special_hours' | 'holiday' | 'technical';
export const EXCEPTION_KINDS: readonly ExceptionKind[] = ['closed', 'short_day', 'special_hours', 'holiday', 'technical'];
const CLOSING_KINDS: ReadonlySet<ExceptionKind> = new Set(['closed', 'holiday', 'technical']);
export const isClosingKind = (k: ExceptionKind): boolean => CLOSING_KINDS.has(k);

export type ExceptionScope = { type: 'branch' } | { type: 'room'; id: string } | { type: 'resource'; id: string };

export interface CalendarException {
  id: string;
  branchId: string;
  scope: ExceptionScope;
  date: LocalDate;
  kind: ExceptionKind;
  open: LocalTime | null;
  close: LocalTime | null;
  reason: string;
  status: 'active' | 'cancelled';
  createdBy: string;
  createdAt: Date;
}

/** Строка недельного графика на дату: closed = выходной. null – строки нет (тоже закрыто). */
export type WeeklyDay = { closed: true } | { closed: false; open: LocalTime; close: LocalTime };

/** Объект, для которого считаем часы: ресурс (с его комнатой), комната или филиал целиком. */
export interface CalendarTarget {
  roomId?: string | null;
  resourceId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuidLike = (s: string): boolean => UUID_RE.test(s);

function zone(tz: string): TimeZone {
  if (!isValidTimeZone(tz)) throw new Error(`network: неверная зона в базе: ${tz}`);
  return tz;
}

// ---- чистое правило приоритета

/** Исключение, действующее для объекта на дату: ресурс → комната → филиал. Только активные этой даты. */
export function effectiveException(exceptions: readonly CalendarException[], target: CalendarTarget): CalendarException | null {
  const active = exceptions.filter((e) => e.status === 'active');
  const byResource = target.resourceId ? active.find((e) => e.scope.type === 'resource' && e.scope.id === target.resourceId) : undefined;
  if (byResource) return byResource;
  const byRoom = target.roomId ? active.find((e) => e.scope.type === 'room' && e.scope.id === target.roomId) : undefined;
  if (byRoom) return byRoom;
  return active.find((e) => e.scope.type === 'branch') ?? null;
}

/** Открытые интервалы дня (UTC) по правилу приоритета 15 §6.3. Чистая функция – её же использует предпросмотр изменений. */
export function resolveDay(input: {
  date: LocalDate;
  tz: TimeZone;
  weekly: WeeklyDay | null;
  exceptions: readonly CalendarException[];
  target: CalendarTarget;
}): Interval[] {
  const ex = effectiveException(input.exceptions.filter((e) => e.date === input.date), input.target);
  if (ex) {
    if (isClosingKind(ex.kind) || ex.open === null || ex.close === null) return [];
    return [hoursToInterval(input.date, ex.open, ex.close, input.tz)];
  }
  const w = input.weekly;
  if (!w || w.closed) return [];
  return [hoursToInterval(input.date, w.open, w.close, input.tz)];
}

// ---- чтение из базы

interface ExceptionRow {
  id: string;
  branch_id: string;
  scope_type: 'branch' | 'room' | 'resource';
  room_id: string | null;
  resource_id: string | null;
  local_date: string;
  kind: ExceptionKind;
  open_time: string | null;
  close_time: string | null;
  reason: string;
  status: 'active' | 'cancelled';
  created_by: string;
  created_at: Date;
}

export const EXCEPTION_COLUMNS = `id, branch_id, scope_type, room_id, resource_id, to_char(local_date, 'YYYY-MM-DD') AS local_date, kind,
  to_char(open_time, 'HH24:MI') AS open_time, to_char(close_time, 'HH24:MI') AS close_time, reason, status, created_by, created_at`;

export function toException(r: ExceptionRow): CalendarException {
  const scope: ExceptionScope =
    r.scope_type === 'room' ? { type: 'room', id: r.room_id! } : r.scope_type === 'resource' ? { type: 'resource', id: r.resource_id! } : { type: 'branch' };
  return {
    id: r.id,
    branchId: r.branch_id,
    scope,
    date: r.local_date as LocalDate,
    kind: r.kind,
    open: r.open_time as LocalTime | null,
    close: r.close_time as LocalTime | null,
    reason: r.reason,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}
export type { ExceptionRow };

/** Активные исключения филиала за даты [from, to] включительно. */
export async function activeExceptions(db: Db | Tx, branchId: string, from: LocalDate, to: LocalDate): Promise<CalendarException[]> {
  if (!isUuidLike(branchId)) return [];
  const r = await db.query<ExceptionRow>(
    `SELECT ${EXCEPTION_COLUMNS} FROM app.calendar_exceptions
     WHERE branch_id = $1 AND status = 'active' AND local_date BETWEEN $2::date AND $3::date
     ORDER BY local_date, scope_type, created_at`,
    [branchId, from, to],
  );
  return r.rows.map(toException);
}

interface DayRow {
  timezone: string;
  has_row: boolean;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean | null;
}

/** Зона филиала и строка недельного графика на дату (valid_to включительно). Нет филиала → null. */
export async function weeklyDay(db: Db | Tx, branchId: string, date: LocalDate): Promise<{ tz: TimeZone; weekly: WeeklyDay | null } | null> {
  if (!isUuidLike(branchId)) return null;
  const r = await db.query<DayRow>(
    `SELECT b.timezone, h.id IS NOT NULL AS has_row,
            to_char(h.open_time, 'HH24:MI') AS open_time, to_char(h.close_time, 'HH24:MI') AS close_time, h.is_closed
     FROM app.branches b
     LEFT JOIN app.branch_weekly_hours h ON h.branch_id = b.id
       AND h.weekday = extract(isodow FROM $2::date)
       AND h.valid_from <= $2::date AND (h.valid_to IS NULL OR h.valid_to >= $2::date)
     WHERE b.id = $1`,
    [branchId, date],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { tz: zone(row.timezone), weekly: toWeekly(row) };
}

function toWeekly(row: { has_row: boolean; open_time: string | null; close_time: string | null; is_closed: boolean | null }): WeeklyDay | null {
  if (!row.has_row) return null;
  if (row.is_closed || row.open_time === null || row.close_time === null) return { closed: true };
  return { closed: false, open: row.open_time as LocalTime, close: row.close_time as LocalTime };
}

/** Всё для расчёта одного дня филиала: зона, недельная строка, активные исключения даты. */
export async function loadDay(
  db: Db | Tx,
  branchId: string,
  date: LocalDate,
): Promise<{ tz: TimeZone; weekly: WeeklyDay | null; exceptions: CalendarException[] } | null> {
  const w = await weeklyDay(db, branchId, date);
  if (!w) return null;
  return { ...w, exceptions: await activeExceptions(db, branchId, date, date) };
}

/** Открытые интервалы дня (UTC) для филиала/комнаты/ресурса (K13). Нет филиала → []. */
export async function openIntervals(
  db: Db | Tx,
  input: { branchId: string; date: LocalDate; roomId?: string | null; resourceId?: string },
): Promise<Interval[]> {
  const day = await loadDay(db, input.branchId, input.date);
  if (!day) return [];
  return resolveDay({ date: input.date, ...day, target: { roomId: input.roomId ?? null, resourceId: input.resourceId ?? null } });
}

/** Для сетки сразу по многим ресурсам одного дня – одна загрузка дня, расчёт в памяти. */
export async function openIntervalsBulk(
  db: Db | Tx,
  input: { branchId: string; date: LocalDate; resources: Array<{ resourceId: string; roomId: string | null }> },
): Promise<Map<string, Interval[]>> {
  const day = await loadDay(db, input.branchId, input.date);
  return new Map(
    input.resources.map((r) => [r.resourceId, day ? resolveDay({ date: input.date, ...day, target: r }) : []]),
  );
}
