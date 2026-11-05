// S3-12. Покрытие смен (K18 §4, 05 §6.2–6.3): открытые интервалы филиала (график + исключения, network) минус объединение
// смен planned|worked|needs_review. «Пусто» = ни одного сотрудника на интервал; норматив численности не считается,
// активный сотрудник без смены интервал не закрывает. Сутки – по зоне филиала, не машины (K8). Только чтение.
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { addDays, fromPgRange, parseLocalDate, type Interval, type LocalDate } from '../../core/time.ts';
import { activeExceptions, getBranch, resolveDay, weeklyDaysRange } from '../network/index.ts';
import { isUuid, notFound } from './rates.ts';

export interface CoverageDto {
  branchId: string;
  date: LocalDate;
  timezone: string;
  open: Interval[];
  covered: Interval[];
  gaps: Interval[];
  state: 'full' | 'partial' | 'empty' | 'closed';
}

export const MAX_COVERAGE_DAYS = 31;

/** Объединение пересекающихся и смежных интервалов, по порядку. */
function union(items: Interval[]): Interval[] {
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start.getTime() <= last.end.getTime()) {
      if (i.end.getTime() > last.end.getTime()) last.end = i.end;
    } else {
      out.push({ start: i.start, end: i.end });
    }
  }
  return out;
}

/** Покрытие одного дня: covered – смены в пределах открытых часов, gaps – открытое минус смены. */
export function coverDay(open: Interval[], shifts: Interval[]): Pick<CoverageDto, 'covered' | 'gaps' | 'state'> {
  if (open.length === 0) return { covered: [], gaps: [], state: 'closed' };
  const merged = union(shifts);
  const covered: Interval[] = [];
  const gaps: Interval[] = [];
  for (const o of union(open)) {
    let cursor = o.start.getTime();
    const end = o.end.getTime();
    for (const s of merged) {
      const from = Math.max(s.start.getTime(), o.start.getTime());
      const to = Math.min(s.end.getTime(), end);
      if (from >= to) continue;
      if (from > cursor) gaps.push({ start: new Date(cursor), end: new Date(from) });
      covered.push({ start: new Date(from), end: new Date(to) });
      cursor = Math.max(cursor, to);
    }
    if (cursor < end) gaps.push({ start: new Date(cursor), end: o.end });
  }
  return { covered, gaps, state: covered.length === 0 ? 'empty' : gaps.length === 0 ? 'full' : 'partial' };
}

const schema = z.object({ branchIds: z.array(z.string()).min(1).max(100), from: z.string(), to: z.string() });

/** Покрытие филиалов зоны по дням; ≤ 31 день; филиал вне зоны – 404 (TC-15, TC-16). */
export async function coverage(db: Db, ctx: AccessContext, raw: { branchIds: string[]; from: string; to: string }): Promise<CoverageDto[]> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Нужны филиалы и даты from, to');
  let from: LocalDate;
  let to: LocalDate;
  try {
    from = parseLocalDate(parsed.data.from);
    to = parseLocalDate(parsed.data.to);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Даты – ГГГГ-ММ-ДД');
  }
  const dates: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_COVERAGE_DAYS) throw new AppError('VALIDATION_FAILED', 400, `Период покрытия – не больше ${MAX_COVERAGE_DAYS} дней`, { maxDays: MAX_COVERAGE_DAYS });
  }
  if (dates.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'from позже to');

  const branchIds = [...new Set(parsed.data.branchIds)];
  for (const id of branchIds) if (!isUuid(id)) throw notFound();
  const shifts = await db.query<{ branch_id: string; local_date: string; period: string }>(
    `SELECT branch_id, to_char(local_date, 'YYYY-MM-DD') AS local_date, period::text AS period FROM app.staff_shifts
      WHERE branch_id = ANY($1::uuid[]) AND local_date BETWEEN $2::date AND $3::date AND status IN ('planned','worked','needs_review')`,
    [branchIds, from, to],
  );
  const byDay = new Map<string, Interval[]>();
  for (const s of shifts.rows) {
    const key = `${s.branch_id}|${s.local_date}`;
    const list = byDay.get(key) ?? [];
    list.push(fromPgRange(s.period));
    byDay.set(key, list);
  }

  const perBranch = await Promise.all(
    branchIds.map(async (branchId) => {
      const branch = await getBranch(db, branchId);
      if (!branch) throw notFound();
      assertCan(ctx, 'shift.view', { branchId });
      const exceptions = await activeExceptions(db, branchId, from, to);
      const weekly = await weeklyDaysRange(db, branchId, from, to);
      return dates.map((date): CoverageDto => {
        const open = weekly ? resolveDay({ date, tz: weekly.tz, weekly: weekly.days.get(date) ?? null, exceptions, target: {} }) : [];
        return { branchId, date, timezone: branch.timezone, open, ...coverDay(open, byDay.get(`${branchId}|${date}`) ?? []) };
      });
    }),
  );
  return perBranch.flat();
}
