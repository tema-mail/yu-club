// S1-03. Календарь филиала: недельный график + исключения (сокращённый день, закрытие, спецграфик) – K13, 15 §6.2–6.3.
// Приоритет на дату: исключение ресурса → комнаты → филиала → branch_weekly_hours (15 §6.3).
// closed / holiday / technical → []; short_day / special_hours → часы исключения; иначе недельный график.
// Через полночь – нет (ADR 0003 п.6). Перевод в UTC – только core/time.ts по зоне филиала (K8).
// Таблицы: 0008 branch_weekly_hours, 0103 calendar_exceptions. index.ts не импортируется (он импортирует этот файл).
// Изменение графика и исключений (K13 previewHoursChange / applyHoursChange): брони не отменяются и не переносятся,
// до сохранения возвращается список затронутых (15 §6.5, 01 §4.1 п.5). Брони читаются через AffectedBookingsProvider
// (реализацию подключит booking), комнаты и ресурсы – через CalendarTargets (подключит resources): ADR 0002 п.1–2.
import { z } from 'zod';
import { writeAudit, type AuditAction, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, roleAllows, type AccessContext } from '../../core/permissions.ts';
import {
  addDays,
  branchDay,
  contains,
  hoursToInterval,
  instantToLocal,
  isValidTimeZone,
  parseLocalDate,
  systemClock,
  todayIn,
  type Clock,
  type Interval,
  type LocalDate,
  type LocalTime,
  type TimeZone,
} from '../../core/time.ts';
import type { Denial } from './commands.ts';

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

// ---- зависимости от других модулей (подключает server.ts)

/** Будущая бронь – только поля, нужные для проверки «помещается ли в новые часы». */
export interface FutureBooking {
  id: string;
  resourceId: string;
  roomId: string | null;
  start: Date;
  end: Date;
}

/** Действующие брони филиала, пересекающие [from, to) (to = null – без верха). Реализация – модуль booking (K13). */
export interface AffectedBookingsProvider {
  futureBookings(db: Db | Tx, input: { branchId: string; from: Date; to: Date | null }): Promise<FutureBooking[]>;
}
/** Пока броней нет (S1-07): затронутых нет. */
export const noAffectedBookings: AffectedBookingsProvider = { futureBookings: async () => [] };

/** Комната / ресурс существует и принадлежит филиалу. Реализация – modules/resources/index.ts (K13). */
export interface CalendarTargets {
  belongsToBranch(db: Db | Tx, target: { type: 'room' | 'resource'; id: string }, branchId: string): Promise<boolean>;
}
/** Без модуля ресурсов: исключение комнаты или ресурса не создаётся (NOT_FOUND). */
export const unconnectedTargets: CalendarTargets = { belongsToBranch: async () => false };

export interface CalendarDeps {
  clock?: Clock;
  bookings?: AffectedBookingsProvider;
  targets?: CalendarTargets;
}

// ---- входные данные изменений

export type WeeklyChangeDay = { weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; open: LocalTime | null; close: LocalTime | null };

export type HoursChange =
  | { kind: 'weekly'; branchId: string; validFrom: LocalDate; days: WeeklyChangeDay[] }
  | {
      kind: 'exception';
      branchId: string;
      scope: ExceptionScope;
      date: LocalDate;
      exceptionKind: ExceptionKind;
      open?: LocalTime;
      close?: LocalTime;
      reason: string;
    }
  | { kind: 'cancel_exception'; branchId: string; exceptionId: string; reason: string };

const DATE = z.string().transform((s, c) => {
  try {
    return parseLocalDate(s);
  } catch {
    c.addIssue({ code: 'custom', message: 'Дата YYYY-MM-DD' });
    return z.NEVER;
  }
});
const TIME = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время HH:mm')
  .transform((s) => s as LocalTime);
const UUID = z.string().regex(UUID_RE, 'uuid');
const REASON = z.string().trim().min(1).max(500);
const WEEKDAY = z.number().int().min(1).max(7).transform((n) => n as WeeklyChangeDay['weekday']);

const changeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('weekly'),
    branchId: z.string(),
    validFrom: DATE,
    days: z.array(z.object({ weekday: WEEKDAY, open: TIME.nullable(), close: TIME.nullable() })).min(1).max(7),
  }),
  z.object({
    kind: z.literal('exception'),
    branchId: z.string(),
    scope: z.discriminatedUnion('type', [
      z.object({ type: z.literal('branch') }),
      z.object({ type: z.literal('room'), id: UUID }),
      z.object({ type: z.literal('resource'), id: UUID }),
    ]),
    date: DATE,
    exceptionKind: z.enum(['closed', 'short_day', 'special_hours', 'holiday', 'technical']),
    open: TIME.optional(),
    close: TIME.optional(),
    reason: REASON,
  }),
  z.object({ kind: z.literal('cancel_exception'), branchId: z.string(), exceptionId: z.string(), reason: REASON }),
]);

function parseChange(raw: unknown): HoursChange {
  const r = changeSchema.safeParse(raw ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data as HoursChange;
}

// ---- права (как в commands.ts: вне зоны – 404 как у несуществующего, в зоне без права – 403)

const DENIALS = new WeakMap<AppError, Denial>();
/** Отказ по правам команд календаря (для writeDenied в HTTP-слое) или undefined. */
export const calendarDenialOf = (err: unknown): Denial | undefined => (err instanceof AppError ? DENIALS.get(err) : undefined);

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

function deny(code: 'NOT_FOUND' | 'FORBIDDEN', d: Omit<Denial, 'reason'>): never {
  const err = code === 'NOT_FOUND' ? notFound() : new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'network.hours.manage' });
  DENIALS.set(err, { ...d, reason: `${code}: network.hours.manage` });
  throw err;
}

const AUDIT_OF: Record<HoursChange['kind'], AuditAction> = {
  weekly: 'branch.hours_changed',
  exception: 'calendar.exception_created',
  cancel_exception: 'calendar.exception_cancelled',
};

interface BranchHead {
  id: string;
  cityId: string;
  tz: TimeZone;
}

async function branchForChange(db: Db | Tx, ctx: AccessContext, branchId: string, action: AuditAction, lock: boolean): Promise<BranchHead> {
  const r = isUuidLike(branchId)
    ? await db.query<{ id: string; city_id: string; timezone: string; status: string }>(
        `SELECT id, city_id, timezone, status FROM app.branches WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
        [branchId],
      )
    : { rows: [] };
  const row = r.rows[0];
  if (!row) {
    if (!roleAllows(ctx.role, 'network.hours.manage')) {
      deny('FORBIDDEN', { action, object: { type: 'branch', id: isUuidLike(branchId) ? branchId : null }, branchId: null, cityId: null });
    }
    throw notFound();
  }
  const d = { action, object: { type: 'branch' as const, id: row.id }, branchId: row.id, cityId: row.city_id };
  if (!can(ctx, 'network.view', { branchId: row.id })) deny('NOT_FOUND', d);
  if (!can(ctx, 'network.hours.manage', { branchId: row.id })) deny('FORBIDDEN', d);
  if (row.status === 'archived') throw new AppError('BRANCH_ARCHIVED', 409, 'Филиал в архиве');
  return { id: row.id, cityId: row.city_id, tz: zone(row.timezone) };
}

const pastDate = (field: string, value: LocalDate, today: LocalDate) =>
  new AppError('VALIDATION_FAILED', 400, 'Прошлое не меняется', { field, value, today });

function checkHours(open: LocalTime | null | undefined, close: LocalTime | null | undefined, required: boolean): void {
  if (!required && open == null && close == null) return;
  if (open == null || close == null || close <= open) {
    throw new AppError('INVALID_HOURS', 422, 'Время закрытия должно быть позже открытия, в пределах суток', {
      open: open ?? null,
      close: close ?? null,
    });
  }
}

const sameScope = (a: ExceptionScope, b: ExceptionScope): boolean =>
  a.type === b.type && (a.type === 'branch' || (b.type !== 'branch' && a.id === b.id));

const conflict = (existingId: string | null) =>
  new AppError('SCHEDULE_CONFLICT', 409, 'На эту дату для объекта уже есть исключение', { exceptionId: existingId });

// ---- подготовка: проверки и затронутые брони (общая для предпросмотра и применения)

interface Prepared {
  change: HoursChange;
  branch: BranchHead;
  now: Date;
  /** Для отмены – отменяемое исключение. */
  target: CalendarException | null;
  affectedBookingIds: string[];
}

async function prepare(db: Db | Tx, ctx: AccessContext, raw: unknown, deps: CalendarDeps, lock: boolean): Promise<Prepared> {
  const change = parseChange(raw);
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const branch = await branchForChange(db, ctx, change.branchId, AUDIT_OF[change.kind], lock);
  const today = todayIn(clock, branch.tz);
  let target: CalendarException | null = null;

  if (change.kind === 'weekly') {
    // Сегодняшний день уже идёт – его меняет исключение; график – с завтрашней даты филиала.
    if (change.validFrom <= today) throw pastDate('validFrom', change.validFrom, today);
    const weekdays = change.days.map((d) => d.weekday);
    if (new Set(weekdays).size !== weekdays.length) throw new AppError('VALIDATION_FAILED', 400, 'День недели повторяется', { weekdays });
    for (const d of change.days) checkHours(d.open, d.close, false);
    const later = await db.query<{ weekday: number; valid_from: string }>(
      `SELECT weekday, to_char(valid_from, 'YYYY-MM-DD') AS valid_from FROM app.branch_weekly_hours
       WHERE branch_id = $1 AND weekday = ANY($2::smallint[]) AND valid_from > $3::date ORDER BY weekday`,
      [branch.id, weekdays, change.validFrom],
    );
    if (later.rows.length > 0) {
      throw new AppError('SCHEDULE_CONFLICT', 409, 'С более поздней даты уже запланирован другой график', { planned: later.rows });
    }
  } else if (change.kind === 'exception') {
    if (change.date < today) throw pastDate('date', change.date, today);
    if (isClosingKind(change.exceptionKind)) {
      if (change.open !== undefined || change.close !== undefined) {
        throw new AppError('INVALID_HOURS', 422, 'У закрытия нет часов работы', { exceptionKind: change.exceptionKind });
      }
    } else checkHours(change.open, change.close, true);
    if (change.scope.type !== 'branch') {
      const targets = deps.targets ?? unconnectedTargets;
      if (!(await targets.belongsToBranch(db, change.scope, branch.id))) throw notFound();
    }
    const same = (await activeExceptions(db, branch.id, change.date, change.date)).find((e) => sameScope(e.scope, change.scope));
    if (same) throw conflict(same.id);
  } else {
    if (!isUuidLike(change.exceptionId)) throw notFound();
    const r = await db.query<ExceptionRow>(
      `SELECT ${EXCEPTION_COLUMNS} FROM app.calendar_exceptions WHERE id = $1 AND branch_id = $2 AND status = 'active'${lock ? ' FOR UPDATE' : ''}`,
      [change.exceptionId, branch.id],
    );
    if (!r.rows[0]) throw notFound();
    target = toException(r.rows[0]);
    if (target.date < today) throw pastDate('date', target.date, today);
  }

  const affectedBookingIds = await affectedBy(db, change, branch, now, target, deps.bookings ?? noAffectedBookings);
  return { change, branch, now, target, affectedBookingIds };
}

/** Брони, которые после изменения окажутся вне открытых часов своего дня. Сами брони не меняются. */
async function affectedBy(
  db: Db | Tx,
  change: HoursChange,
  branch: BranchHead,
  now: Date,
  target: CalendarException | null,
  provider: AffectedBookingsProvider,
): Promise<string[]> {
  const firstDate = change.kind === 'weekly' ? change.validFrom : change.kind === 'exception' ? change.date : target!.date;
  const day = branchDay(firstDate, branch.tz);
  const from = day.start > now ? day.start : now;
  const to = change.kind === 'weekly' ? null : day.end;
  const bookings = await provider.futureBookings(db, { branchId: branch.id, from, to });
  if (bookings.length === 0) return [];

  const days = new Map<LocalDate, { weekly: WeeklyDay | null; exceptions: CalendarException[] }>();
  const out = new Set<string>();
  for (const b of bookings) {
    const date = instantToLocal(b.start, branch.tz).date;
    let state = days.get(date);
    if (!state) {
      const w = await weeklyDay(db, branch.id, date);
      state = applyChange(change, date, branch.tz, w?.weekly ?? null, await activeExceptions(db, branch.id, date, date), target);
      days.set(date, state);
    }
    const open = resolveDay({ date, tz: branch.tz, ...state, target: { roomId: b.roomId, resourceId: b.resourceId } });
    if (!open.some((i) => contains(i, b))) out.add(b.id);
  }
  return [...out].sort();
}

/** День «как будет после изменения» – в памяти, для предпросмотра. */
function applyChange(
  change: HoursChange,
  date: LocalDate,
  tz: TimeZone,
  weekly: WeeklyDay | null,
  exceptions: CalendarException[],
  target: CalendarException | null,
): { weekly: WeeklyDay | null; exceptions: CalendarException[] } {
  if (change.kind === 'weekly') {
    if (date < change.validFrom) return { weekly, exceptions };
    const wd = instantToLocal(branchDay(date, tz).start, tz).weekday;
    const d = change.days.find((x) => x.weekday === wd);
    if (!d) return { weekly, exceptions };
    return { weekly: d.open && d.close ? { closed: false, open: d.open, close: d.close } : { closed: true }, exceptions };
  }
  if (change.kind === 'cancel_exception') return { weekly, exceptions: exceptions.filter((e) => e.id !== target!.id) };
  if (date !== change.date) return { weekly, exceptions };
  const added: CalendarException = {
    id: 'preview',
    branchId: change.branchId,
    scope: change.scope,
    date: change.date,
    kind: change.exceptionKind,
    open: change.open ?? null,
    close: change.close ?? null,
    reason: change.reason,
    status: 'active',
    createdBy: '',
    createdAt: new Date(0),
  };
  return { weekly, exceptions: [...exceptions.filter((e) => !sameScope(e.scope, change.scope)), added] };
}

// ---- команды

/** До сохранения: проверки и список затронутых будущих броней (15 §6.5). Ничего не пишет. */
export async function previewHoursChange(
  db: Db | Tx,
  ctx: AccessContext,
  input: unknown,
  deps: CalendarDeps = {},
): Promise<{ affectedBookingIds: string[] }> {
  const p = await prepare(db, ctx, input, deps, false);
  return { affectedBookingIds: p.affectedBookingIds };
}

export type HoursChangeResult =
  | { kind: 'weekly'; branchId: string; validFrom: LocalDate; days: WeeklyChangeDay[]; affectedBookingIds: string[] }
  | { kind: 'exception' | 'cancel_exception'; exception: CalendarException; affectedBookingIds: string[] };

/** Применить изменение в транзакции вызывающего. confirmedAffected ≠ текущему списку → 409 AFFECTED_CHANGED.
 *  Брони не отменяются и не переносятся: решение по каждой – за сотрудником (01 §4.1 п.5). */
export async function applyHoursChange(
  tx: Tx,
  ctx: AccessContext,
  input: unknown,
  meta: AuditRequestMeta,
  deps: CalendarDeps = {},
): Promise<HoursChangeResult> {
  const confirmed = z.object({ confirmedAffected: z.array(z.string()).max(10_000) }).safeParse(input ?? {});
  if (!confirmed.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Нужен список подтверждённых затронутых записей', { field: 'confirmedAffected' });
  }
  const p = await prepare(tx, ctx, input, deps, true);
  const want = [...new Set(confirmed.data.confirmedAffected)].sort();
  if (want.length !== p.affectedBookingIds.length || want.some((id, i) => id !== p.affectedBookingIds[i])) {
    throw new AppError('AFFECTED_CHANGED', 409, 'Список затронутых записей изменился – проверьте заново', {
      affectedBookingIds: p.affectedBookingIds,
    });
  }
  const clock = deps.clock ?? systemClock;
  const where = { branchId: p.branch.id, cityId: p.branch.cityId };
  const affectedBookingIds = p.affectedBookingIds;
  const c = p.change;

  if (c.kind === 'weekly') {
    const before = await writeWeekly(tx, ctx, p.branch.id, c);
    await writeAudit(
      tx,
      meta,
      {
        action: 'branch.hours_changed',
        object: { type: 'branch', id: p.branch.id },
        ...where,
        before: { validFrom: c.validFrom, days: before },
        after: { validFrom: c.validFrom, days: c.days, affectedBookingIds },
      },
      clock,
    );
    return { kind: 'weekly', branchId: p.branch.id, validFrom: c.validFrom, days: c.days, affectedBookingIds };
  }

  if (c.kind === 'exception') {
    const r = await tx
      .query<ExceptionRow>(
        `INSERT INTO app.calendar_exceptions (branch_id, scope_type, room_id, resource_id, local_date, kind, open_time, close_time, reason, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${EXCEPTION_COLUMNS}`,
        [
          p.branch.id,
          c.scope.type,
          c.scope.type === 'room' ? c.scope.id : null,
          c.scope.type === 'resource' ? c.scope.id : null,
          c.date,
          c.exceptionKind,
          c.open ?? null,
          c.close ?? null,
          c.reason,
          ctx.actor.staffId,
          p.now,
        ],
      )
      .catch((err: unknown) => {
        // гонка двух сотрудников: EXCLUDE calendar_exceptions_one_per_day
        if ((err as { code?: string }).code === '23P01') throw conflict(null);
        throw err;
      });
    const exception = toException(r.rows[0]!);
    await writeAudit(
      tx,
      meta,
      {
        action: 'calendar.exception_created',
        object: { type: 'calendar_exception', id: exception.id },
        ...where,
        after: { ...exception, affectedBookingIds },
        reason: c.reason,
      },
      clock,
    );
    return { kind: 'exception', exception, affectedBookingIds };
  }

  const r = await tx.query<ExceptionRow>(
    `UPDATE app.calendar_exceptions SET status = 'cancelled', cancelled_at = $2, cancelled_by = $3 WHERE id = $1 RETURNING ${EXCEPTION_COLUMNS}`,
    [p.target!.id, p.now, ctx.actor.staffId],
  );
  const exception = toException(r.rows[0]!);
  await writeAudit(
    tx,
    meta,
    {
      action: 'calendar.exception_cancelled',
      object: { type: 'calendar_exception', id: exception.id },
      ...where,
      before: { status: 'active' },
      after: { status: 'cancelled', affectedBookingIds },
      reason: c.reason,
    },
    clock,
  );
  return { kind: 'cancel_exception', exception, affectedBookingIds };
}

/** Новый недельный график с validFrom: действующая строка закрывается накануне, будущая строка той же даты – правится.
 *  Прошлое не переписывается (0008). Возвращает прежние значения изменённых дней – для аудита. */
async function writeWeekly(tx: Tx, ctx: AccessContext, branchId: string, c: Extract<HoursChange, { kind: 'weekly' }>): Promise<WeeklyChangeDay[]> {
  const before: WeeklyChangeDay[] = [];
  for (const d of c.days) {
    const r = await tx.query<{ id: string; valid_from: string; valid_to: string | null; open_time: string | null; close_time: string | null }>(
      `SELECT id, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to,
              to_char(open_time, 'HH24:MI') AS open_time, to_char(close_time, 'HH24:MI') AS close_time
       FROM app.branch_weekly_hours
       WHERE branch_id = $1 AND weekday = $2 AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $3::date)
       FOR UPDATE`,
      [branchId, d.weekday, c.validFrom],
    );
    const cur = r.rows[0];
    before.push({ weekday: d.weekday, open: (cur?.open_time ?? null) as LocalTime | null, close: (cur?.close_time ?? null) as LocalTime | null });
    const closed = d.open === null || d.close === null;
    const open = closed ? null : d.open;
    const close = closed ? null : d.close;
    if (cur && cur.valid_from === c.validFrom) {
      await tx.query('UPDATE app.branch_weekly_hours SET open_time = $2, close_time = $3, is_closed = $4 WHERE id = $1', [cur.id, open, close, closed]);
      continue;
    }
    if (cur) await tx.query('UPDATE app.branch_weekly_hours SET valid_to = $2 WHERE id = $1', [cur.id, addDays(c.validFrom, -1)]);
    await tx.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, is_closed, valid_from, valid_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [branchId, d.weekday, open, close, closed, c.validFrom, cur?.valid_to ?? null, ctx.actor.staffId],
    );
  }
  return before;
}

// ---- чтение для CRM

const rangeSchema = z.object({ from: DATE, to: DATE });

/** Исключения филиала за [from, to] (≤ 366 дней), включая отменённые – история видна. Вне зоны – 404. */
export async function listExceptions(db: Db, ctx: AccessContext, branchId: string, raw: unknown): Promise<{ items: CalendarException[] }> {
  const q = rangeSchema.safeParse(raw ?? {});
  if (!q.success || q.data.to < q.data.from || addDays(q.data.from, 366) < q.data.to) {
    throw new AppError('VALIDATION_FAILED', 400, 'Период from..to, не больше года', { field: 'from,to' });
  }
  await visibleBranch(db, ctx, branchId);
  const r = await db.query<ExceptionRow>(
    `SELECT ${EXCEPTION_COLUMNS} FROM app.calendar_exceptions
     WHERE branch_id = $1 AND local_date BETWEEN $2::date AND $3::date ORDER BY local_date, scope_type, created_at`,
    [branchId, q.data.from, q.data.to],
  );
  return { items: r.rows.map(toException) };
}

export interface WeeklyHoursRow {
  weekday: number;
  open: LocalTime | null;
  close: LocalTime | null;
  closed: boolean;
  validFrom: LocalDate;
  validTo: LocalDate | null;
}

/** Недельный график: действующие сегодня и будущие строки (прошлые – в аудите). Вне зоны – 404. */
export async function getWeeklyHours(
  db: Db,
  ctx: AccessContext,
  branchId: string,
  clock: Clock = systemClock,
): Promise<{ timezone: TimeZone; items: WeeklyHoursRow[] }> {
  const tz = await visibleBranch(db, ctx, branchId);
  const r = await db.query<{ weekday: number; open_time: string | null; close_time: string | null; is_closed: boolean; valid_from: string; valid_to: string | null }>(
    `SELECT weekday, to_char(open_time, 'HH24:MI') AS open_time, to_char(close_time, 'HH24:MI') AS close_time, is_closed,
            to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to
     FROM app.branch_weekly_hours WHERE branch_id = $1 AND (valid_to IS NULL OR valid_to >= $2::date)
     ORDER BY valid_from, weekday`,
    [branchId, todayIn(clock, tz)],
  );
  return {
    timezone: tz,
    items: r.rows.map((x) => ({
      weekday: x.weekday,
      open: x.open_time as LocalTime | null,
      close: x.close_time as LocalTime | null,
      closed: x.is_closed,
      validFrom: x.valid_from as LocalDate,
      validTo: x.valid_to as LocalDate | null,
    })),
  };
}

async function visibleBranch(db: Db, ctx: AccessContext, branchId: string): Promise<TimeZone> {
  if (!isUuidLike(branchId)) throw notFound();
  const r = await db.query<{ timezone: string }>('SELECT timezone FROM app.branches WHERE id = $1', [branchId]);
  if (!r.rows[0] || !can(ctx, 'network.view', { branchId })) throw notFound();
  return zone(r.rows[0].timezone);
}
