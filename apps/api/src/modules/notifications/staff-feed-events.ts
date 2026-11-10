// Лента событий CRM (13 §11; S4-28, D4-46): события без источника в outbox – проход таймера раз в час (worker.ts, как startShiftReview).
// Незаполненная смена (05 §6.3, Q-63: филиал открыт, ни одного сотрудника) – за notifications.feed_shift_unfilled_hours до открытия,
// зоне с shift.manage, ссылка на филиал; мероприятие требует подготовки (11 §6: confirmed/preparing, начало в пределах
// feed_event_prepare_days, есть пункты чек-листа todo) – зоне с event.view; окончание гарантии (10 §9: активная гарантия,
// ends_on в пределах feed_warranty_days по зоне филиала, оборудование не списано) – зоне с equipment.view.
// Идемпотентность: dedupe_key '<kind>:<сущность>:<порог>' – одна строка на сущность и порог при любом числе проходов и процессов;
// смена порога даёт новую строку. Дата «события» (occurred_at) – момент прохода: строка с будущей датой не читалась бы «отметить все».
import type { Db } from '../../core/audit.ts';
import { resolveSettings } from '../../core/settings.ts';
import { addDays, formatLocal, fromPgRange, isValidTimeZone, systemClock, todayIn, type Clock, type Interval, type LocalDate, type TimeZone } from '../../core/time.ts';
import { activeExceptions, resolveDay, weeklyDaysRange } from '../network/index.ts';
import { coverDay } from '../shifts/coverage.ts';
import { insertFeed } from './staff-feed.ts';

export interface StaffFeedTimersResult {
  shiftsUnfilled: number;
  eventsPreparation: number;
  warrantiesEnding: number;
}

const zoneOf = (tz: string): TimeZone => (isValidTimeZone(tz) ? tz : ('UTC' as TimeZone));
const HOUR_MS = 3_600_000;

/** Пустые дни филиалов: открытые интервалы дня (график и исключения) без единой смены planned|worked|needs_review. */
async function unfilledShifts(db: Db, now: Date, hours: number): Promise<number> {
  const branches = await db.query<{ id: string; timezone: string }>(`SELECT id, timezone FROM app.branches WHERE status = 'active'`);
  const deadline = now.getTime() + hours * HOUR_MS;
  let inserted = 0;
  for (const b of branches.rows) {
    const tz = zoneOf(b.timezone);
    const from = todayIn({ now: () => now }, tz);
    const to = addDays(from, Math.ceil(hours / 24) + 1);
    const weekly = await weeklyDaysRange(db, b.id, from, to);
    if (!weekly) continue;
    const exceptions = await activeExceptions(db, b.id, from, to);
    const shifts = await db.query<{ local_date: string; period: string }>(
      `SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date, period::text AS period FROM app.staff_shifts
        WHERE branch_id = $1 AND local_date BETWEEN $2::date AND $3::date AND status IN ('planned','worked','needs_review')`,
      [b.id, from, to],
    );
    const byDay = new Map<string, Interval[]>();
    for (const s of shifts.rows) byDay.set(s.local_date, [...(byDay.get(s.local_date) ?? []), fromPgRange(s.period)]);
    for (let date: LocalDate = from; date <= to; date = addDays(date, 1)) {
      const open = resolveDay({ date, tz: weekly.tz, weekly: weekly.days.get(date) ?? null, exceptions, target: {} });
      if (open.length === 0 || coverDay(open, byDay.get(date) ?? []).state !== 'empty') continue;
      const first = open[0]!;
      const last = open.at(-1)!;
      if (first.start.getTime() > deadline || last.end.getTime() <= now.getTime()) continue;
      const ok = await insertFeed(db, {
        branchId: b.id, staffId: null, action: 'shift.manage', kind: 'shift_unfilled', refType: 'branch', refId: b.id,
        title: `Смена ${formatLocal(first.start, tz, 'date')} не заполнена`,
        body: `Филиал открыт ${formatLocal(first.start, tz, 'time')}–${formatLocal(last.end, tz, 'time')}, ни одного сотрудника на смене`,
        dedupeKey: `shift_unfilled:${b.id}:${date}:${hours}`, occurredAt: now,
      }, now);
      if (ok) inserted++;
    }
  }
  return inserted;
}

/** Мероприятия confirmed|preparing с началом в (now, now + days] и пунктами чек-листа todo. days = 0 – выключено. */
async function eventsPreparation(db: Db, now: Date, days: number): Promise<number> {
  if (days <= 0) return 0;
  const r = await db.query<{ id: string; number: string; title: string; branch_id: string; timezone: string; planned_start: Date; todo: number }>(
    `SELECT e.id, e.number, e.title, e.branch_id, b.timezone, e.planned_start,
            (SELECT count(*) FROM app.event_checklist c WHERE c.event_id = e.id AND c.status = 'todo')::int AS todo
       FROM app.events e JOIN app.branches b ON b.id = e.branch_id
      WHERE e.status IN ('confirmed','preparing') AND e.planned_start > $1 AND e.planned_start <= $1::timestamptz + make_interval(days => $2)
        AND EXISTS (SELECT 1 FROM app.event_checklist c WHERE c.event_id = e.id AND c.status = 'todo')
      ORDER BY e.planned_start`,
    [now, days],
  );
  let inserted = 0;
  for (const e of r.rows) {
    const ok = await insertFeed(db, {
      branchId: e.branch_id, staffId: null, action: 'event.view', kind: 'event_preparation', refType: 'event', refId: e.id,
      title: `Мероприятие № ${e.number}: подготовка`,
      body: `${e.title}, ${formatLocal(e.planned_start, zoneOf(e.timezone), 'datetime')}, не сделано пунктов чек-листа: ${e.todo}`,
      dedupeKey: `event_preparation:${e.id}:${days}`, occurredAt: now,
    }, now);
    if (ok) inserted++;
  }
  return inserted;
}

/** Активные гарантии с ends_on в [сегодня, сегодня + days] по зоне филиала; списанное и потерянное оборудование – нет. */
async function warrantiesEnding(db: Db, now: Date, days: number): Promise<number> {
  const r = await db.query<{ id: string; kind: 'manufacturer' | 'repair'; ends_on: string; equipment_id: string; name: string; inventory_number: string; branch_id: string }>(
    `SELECT w.id, w.kind, to_char(w.ends_on, 'DD.MM.YYYY') AS ends_on, e.id AS equipment_id, e.name, e.inventory_number, e.branch_id
       FROM app.equipment_warranties w JOIN app.equipment_items e ON e.id = w.equipment_id JOIN app.branches b ON b.id = e.branch_id
      WHERE w.status = 'active' AND e.status NOT IN ('written_off','lost')
        AND w.ends_on >= ($1::timestamptz AT TIME ZONE b.timezone)::date AND w.ends_on <= ($1::timestamptz AT TIME ZONE b.timezone)::date + $2::int
      ORDER BY w.ends_on, w.id`,
    [now, days],
  );
  let inserted = 0;
  for (const w of r.rows) {
    const ok = await insertFeed(db, {
      branchId: w.branch_id, staffId: null, action: 'equipment.view', kind: 'warranty_ending', refType: 'equipment', refId: w.equipment_id,
      title: `Гарантия на ${w.name} заканчивается ${w.ends_on}`,
      body: `${w.inventory_number}, гарантия ${w.kind === 'manufacturer' ? 'производителя' : 'на ремонт'} до ${w.ends_on}`,
      dedupeKey: `warranty_ending:${w.id}:${days}`, occurredAt: now,
    }, now);
    if (ok) inserted++;
  }
  return inserted;
}

/** Один проход всех трёх таймеров; пороги – K7 на момент прохода. Возвращает число новых строк по видам. */
export async function runStaffFeedTimers(db: Db, clock: Clock = systemClock): Promise<StaffFeedTimersResult> {
  const now = clock.now();
  const s = await resolveSettings(db, ['notifications.feed_shift_unfilled_hours', 'notifications.feed_event_prepare_days', 'notifications.feed_warranty_days'], { network: true }, now);
  return {
    shiftsUnfilled: await unfilledShifts(db, now, s['notifications.feed_shift_unfilled_hours'].value),
    eventsPreparation: await eventsPreparation(db, now, s['notifications.feed_event_prepare_days'].value),
    warrantiesEnding: await warrantiesEnding(db, now, s['notifications.feed_warranty_days'].value),
  };
}

/** Проход раз в час (по умолчанию); как startShiftReview: setInterval с unref, ошибка – в onError, следующий проход по расписанию. */
export function startStaffFeedTimers(opts: { pool: Db; clock?: Clock; intervalMs?: number; onError?: (err: unknown) => void }): { stop(): void } {
  const timer = setInterval(() => {
    runStaffFeedTimers(opts.pool, opts.clock).catch((err: unknown) => (opts.onError ?? ((e) => console.error('notifications:staff-feed-timers', e)))(err));
  }, opts.intervalMs ?? HOUR_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
