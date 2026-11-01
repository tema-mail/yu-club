// S1-05. K6 availability / K5 №5: сетка доступности дня филиала – слоты по шагу ресурса, 6 состояний (01 §6.3).
// Без записи: читает снимок на момент запроса; окончательное решение – команда занятия (EXCLUDE, 17 §10).
// Границы суток – по зоне филиала (branchDay), окно записи – из настроек K7 (booking.window_max_days / default_days):
// даты [сегодня, сегодня + N) по зоне; слот с началом ≤ now – прошлое (closed).
// Запросов на день – постоянное число (филиал, настройки, ресурсы, график, состав, занятость, блокировки), расчёт в памяти.
import type { Db, Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { resolveSettings } from '../../core/settings.ts';
import { addDays, branchDay, isDateInWindow, systemClock, toPgRange, type Clock, type Interval, type LocalDate } from '../../core/time.ts';
import { getBranch, isAcceptingBookings, openIntervals, openIntervalsBulk, type BranchInfo } from '../network/index.ts';
import { compositionsDuring, listBookableResources, type CompositionRow, type ResourceInfo } from '../resources/index.ts';

export type SlotState = 'free' | 'mine' | 'held' | 'booked' | 'blocked' | 'closed';
export interface SlotDto {
  start: string;
  end: string;
  state: SlotState;
}
export interface ResourceDayDto {
  resourceId: string;
  slots: SlotDto[];
}
export interface AvailabilityDto {
  branchId: string;
  date: LocalDate;
  timezone: string;
  dayState: 'open' | 'closed' | 'outside_window';
  openIntervals: Array<{ start: string; end: string }>;
  resources: ResourceDayDto[];
  generatedAt: string;
}

export interface Viewer {
  visitorId?: string | undefined;
  clientId?: string | undefined;
}

/** Позиции удержаний этого посетителя/клиента в филиале (для 'mine'). Реализация – hold.ts (S1-06). */
export type OwnHoldItems = (db: Db | Tx, branchId: string, viewer: Viewer, now: Date) => Promise<ReadonlySet<string>>;
export const noOwnHoldItems: OwnHoldItems = async () => new Set();

interface Busy {
  unitId: string;
  start: number;
  end: number;
  kind: 'booked' | 'held' | 'mine';
}

const MS_MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

/** Окно записи филиала на момент now (K7): maxDays – граница записи, defaultDays – показ по умолчанию. */
export async function bookingWindowOf(db: Db | Tx, branchId: string, now: Date): Promise<{ defaultDays: number; maxDays: number }> {
  const s = await resolveSettings(db, ['booking.window_default_days', 'booking.window_max_days'], { branchId }, now);
  return { defaultDays: s['booking.window_default_days'].value, maxDays: s['booking.window_max_days'].value };
}

/** Публичный филиал: preparing / archived – как несуществующий (K5 №3). */
async function publicBranch(db: Db | Tx, branchId: string): Promise<BranchInfo> {
  const b = await getBranch(db, branchId);
  if (!b || b.status === 'preparing' || b.status === 'archived') throw new AppError('NOT_FOUND', 404, 'Не найдено');
  return b;
}

/** Слоты шага внутри интервалов сетки: от начала интервала, только целые шаги (хвост короче шага отбрасывается). */
function grid(intervals: Interval[], stepMinutes: number): Array<[number, number]> {
  const step = stepMinutes * MS_MIN;
  const out: Array<[number, number]> = [];
  for (const i of intervals) for (let t = i.start.getTime(); t + step <= i.end.getTime(); t += step) out.push([t, t + step]);
  return out.sort((a, b) => a[0] - b[0]);
}

const within = (s: number, e: number, list: Interval[]) => list.some((i) => i.start.getTime() <= s && e <= i.end.getTime());

/** Единицы ресурса, действующие на момент t (состав на начало слота, K6). */
function unitsAt(rows: CompositionRow[], t: number): string[] {
  return rows.filter((r) => r.validFrom.getTime() <= t && (r.validTo === null || r.validTo.getTime() > t)).map((r) => r.unitId);
}

/** K6 availability: сетка одного дня. resourceIds – подмножество бронируемых (≤ 50), иначе все. */
export async function availability(
  db: Db | Tx,
  input: { branchId: string; date: LocalDate; resourceIds?: string[]; viewer: Viewer },
  opts: { clock?: Clock; ownHoldItems?: OwnHoldItems } = {},
): Promise<AvailabilityDto> {
  const now = (opts.clock ?? systemClock).now();
  const branch = await publicBranch(db, input.branchId);
  const tz = branch.timezone;
  const base = { branchId: branch.id, date: input.date, timezone: tz, generatedAt: now.toISOString() };
  const window = await bookingWindowOf(db, branch.id, now);
  if (!isDateInWindow(input.date, { now: () => now }, tz, window.maxDays)) {
    return { ...base, dayState: 'outside_window', openIntervals: [], resources: [] };
  }
  const day = branchDay(input.date, tz);
  let resources: ResourceInfo[] = await listBookableResources(db, branch.id);
  if (input.resourceIds) {
    const want = new Set(input.resourceIds.map((s) => s.toLowerCase()));
    resources = resources.filter((r) => want.has(r.id));
  }
  const branchOpen = await openIntervals(db, { branchId: branch.id, date: input.date });
  const perResource = await openIntervalsBulk(db, { branchId: branch.id, date: input.date, resources: resources.map((r) => ({ resourceId: r.id, roomId: r.roomId })) });
  const anyOpen = branchOpen.length > 0 || [...perResource.values()].some((l) => l.length > 0);
  const dayClosed = !anyOpen || (!isAcceptingBookings(branch, day.start) && !isAcceptingBookings(branch, new Date(day.end.getTime() - 1)));
  const openDto = branchOpen.map((i) => ({ start: i.start.toISOString(), end: i.end.toISOString() }));
  if (resources.length === 0 || dayClosed) {
    return { ...base, dayState: anyOpen && !dayClosed ? 'open' : 'closed', openIntervals: openDto, resources: resources.map((r) => ({ resourceId: r.id, slots: [] })) };
  }

  const ids = resources.map((r) => r.id);
  const comps = await compositionsDuring(db, ids, day.start, day.end);
  const allUnits = [...new Set([...comps.values()].flat().map((c) => c.unitId))];
  const range = toPgRange(day);
  const occ = await db.query<{ unit_id: string; s: Date; e: Date; source_type: string; source_id: string }>(
    `SELECT unit_id, lower(period) AS s, upper(period) AS e, source_type, source_id FROM app.occupancy
     WHERE active AND unit_id = ANY($1::uuid[]) AND period && $2::tstzrange
       AND (source_type <> 'hold_item' OR hold_expires_at > $3)`,
    [allUnits, range, now],
  );
  const blk = await db.query<{ unit_id: string; s: Date; e: Date }>(
    `SELECT unit_id, lower(period) AS s, upper(period) AS e FROM app.resource_block_units
     WHERE active AND unit_id = ANY($1::uuid[]) AND period && $2::tstzrange`,
    [allUnits, range],
  );
  const mine = await (opts.ownHoldItems ?? noOwnHoldItems)(db, branch.id, input.viewer, now);
  const busy = new Map<string, Busy[]>();
  for (const o of occ.rows) {
    const kind = o.source_type === 'hold_item' ? (mine.has(o.source_id) ? 'mine' : 'held') : 'booked';
    const list = busy.get(o.unit_id) ?? [];
    list.push({ unitId: o.unit_id, start: o.s.getTime(), end: o.e.getTime(), kind });
    busy.set(o.unit_id, list);
  }
  const blocks = new Map<string, Array<[number, number]>>();
  for (const b of blk.rows) blocks.set(b.unit_id, [...(blocks.get(b.unit_id) ?? []), [b.s.getTime(), b.e.getTime()]]);
  const closure: [number, number] | null = branch.tempClosed ? [branch.tempClosed.from.getTime(), branch.tempClosed.to?.getTime() ?? Infinity] : null;

  const out: ResourceDayDto[] = resources.map((r) => {
    const own = perResource.get(r.id) ?? [];
    const rows = comps.get(r.id) ?? [];
    const slots = grid([...branchOpen, ...own].length > 0 ? mergeHull([...branchOpen, ...own]) : [], r.stepMinutes).map(([s, e]): SlotDto => {
      const state = ((): SlotState => {
        if (s <= now.getTime() || !within(s, e, own) || (closure && s < closure[1] && closure[0] < e)) return 'closed';
        const units = unitsAt(rows, s);
        if (units.length === 0) return 'closed';
        if (units.some((u) => (blocks.get(u) ?? []).some(([bs, be]) => bs < e && s < be))) return 'blocked';
        const hits = units.flatMap((u) => (busy.get(u) ?? []).filter((x) => x.start < e && s < x.end));
        if (hits.length === 0) return 'free';
        if (hits.every((h) => h.kind === 'mine')) return 'mine';
        if (hits.some((h) => h.kind === 'booked')) return 'booked';
        return 'held';
      })();
      return { start: iso(s), end: iso(e), state };
    });
    return { resourceId: r.id, slots };
  });
  return { ...base, dayState: 'open', openIntervals: openDto, resources: out };
}

/** Объединение пересекающихся интервалов (сетка одна для филиала и спецчасов ресурса). */
function mergeHull(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start.getTime() <= last.end.getTime()) {
      if (i.end > last.end) out[out.length - 1] = { start: last.start, end: i.end };
    } else out.push({ ...i });
  }
  return out;
}

/** Расписание филиала за период (CRM, до 7 дней): дни подряд от from. 17 §4.1 – ≤ 3 с. */
export async function availabilityRange(
  db: Db | Tx,
  input: { branchId: string; from: LocalDate; days: number; resourceIds?: string[]; viewer: Viewer },
  opts: { clock?: Clock; ownHoldItems?: OwnHoldItems } = {},
): Promise<AvailabilityDto[]> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 7) throw new AppError('RANGE_TOO_LONG', 422, 'Период – от 1 до 7 дней', { days: input.days });
  const out: AvailabilityDto[] = [];
  for (let k = 0; k < input.days; k++) {
    const day = { branchId: input.branchId, date: addDays(input.from, k), viewer: input.viewer, ...(input.resourceIds ? { resourceIds: input.resourceIds } : {}) };
    out.push(await availability(db, day, opts));
  }
  return out;
}
