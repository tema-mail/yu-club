// K11 №2 + K20: мероприятия в календаре филиала одним запросом. Таблицы мероприятий ведёт модуль events, booking их не
// читает (ADR 0002) – поэтому отдельный маршрут рядом с /branches/:id/calendar с тем же периодом (≤ 7 дней, дни филиала),
// той же зоной (schedule.view и event.view на филиал, вне зоны – 404) и тем же сопоставлением дорожек: ресурс, чей состав
// на момент начала (или начала периода, если мероприятие началось раньше) содержит единицы строки event_resources.
// Пересечение интервалов: мероприятие, начатое до периода и идущее в нём, попадает.
import { CalendarQuery } from '../../../../../packages/contracts/src/crm/booking.ts';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { addDays, branchDay, parseLocalDate, toPgRange, type LocalDate } from '../../core/time.ts';
import { getBranch } from '../network/index.ts';
import { compositionsDuring, listBookableResources } from '../resources/index.ts';
import { notFound, parseBody, UUID_RE, type EventStatus } from './events.ts';

const MAX_DAYS = 7;

/** Строка календаря: одна занятая строка ресурса мероприятия → дорожки календаря, которые она занимает. */
export interface CalendarEventItem { id: string; number: string; title: string; status: EventStatus; start: string; end: string; resourceIds: string[] }
export interface CalendarEventsDto { branchId: string; from: LocalDate; to: LocalDate; items: CalendarEventItem[] }

export async function calendarEvents(db: Db, ctx: AccessContext, branchId: string, raw: unknown): Promise<CalendarEventsDto> {
  const q = parseBody(CalendarQuery, raw);
  const branch = UUID_RE.test(branchId) ? await getBranch(db, branchId) : null;
  if (!branch || !can(ctx, 'schedule.view', { branchId: branch.id }) || !can(ctx, 'event.view', { branchId: branch.id })) throw notFound();
  let from: LocalDate;
  let to: LocalDate;
  try {
    from = parseLocalDate(q.from);
    to = parseLocalDate(q.to);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверная дата', { field: 'from' });
  }
  if (to < from) throw new AppError('VALIDATION_FAILED', 400, 'Конец периода раньше начала', { field: 'to' });
  if (addDays(from, MAX_DAYS - 1) < to) throw new AppError('RANGE_TOO_LONG', 422, `Период не длиннее ${MAX_DAYS} дней`, { maxDays: MAX_DAYS });
  const filter = q.resourceIds ? new Set(q.resourceIds.split(',').filter((x) => x !== '').map((x) => x.toLowerCase())) : null;
  if (filter && ![...filter].every((x) => UUID_RE.test(x))) throw new AppError('VALIDATION_FAILED', 400, 'Неверный ресурс', { field: 'resourceIds' });
  const range = { start: branchDay(from, branch.timezone).start, end: branchDay(to, branch.timezone).end };
  const lanes = (await listBookableResources(db, branch.id)).filter((r) => !filter || filter.has(r.id));
  const comps = await compositionsDuring(db, lanes.map((r) => r.id), range.start, range.end);
  const rows = await db.query<{ event_id: string; number: string; title: string; status: EventStatus; resource_id: string; unit_ids: string[]; s: Date; e: Date }>(
    `SELECT e.id AS event_id, e.number, e.title, e.status, er.resource_id, er.unit_ids, lower(er.period) AS s, upper(er.period) AS e
       FROM app.event_resources er JOIN app.events e ON e.id = er.event_id
      WHERE e.branch_id = $1 AND er.status = 'active' AND e.status NOT IN ('cancelled', 'not_held') AND er.period && $2::tstzrange
      ORDER BY lower(er.period), e.number, er.id`,
    [branch.id, toPgRange(range)],
  );
  const items: CalendarEventItem[] = [];
  for (const r of rows.rows) {
    const at = r.s.getTime() > range.start.getTime() ? r.s : range.start;
    const resourceIds = lanes
      .filter((l) => l.id === r.resource_id || (comps.get(l.id) ?? []).some((c) => r.unit_ids.includes(c.unitId) && c.validFrom.getTime() <= at.getTime() && (c.validTo === null || c.validTo.getTime() > at.getTime())))
      .map((l) => l.id);
    if (resourceIds.length > 0) items.push({ id: r.event_id, number: r.number, title: r.title, status: r.status, start: r.s.toISOString(), end: r.e.toISOString(), resourceIds });
  }
  return { branchId: branch.id, from, to, items };
}
