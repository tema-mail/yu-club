// Условие сегмента детализации (K24 §2, §10, §14; 14 §15; D4-21): нажатие на сегмент графика или строку разбивки открывает исходные
// записи «с теми же фильтрами и дополнительным условием сегмента». Формат – `<измерение>:<значение>`. Сегмент только сужает фильтры отчёта:
// дальше работает тот же построитель where(spec), поэтому строки и итог считаются с сегментом одинаково (TC-20). Сегмент, не совместимый
// с фильтром (другой филиал, день вне периода), – ошибка фильтра, а не пустой ответ: так не спутать «нет данных» с опечаткой.
import { AppError } from '../../core/errors.ts';
import { parseLocalDate, type LocalDate } from '../../core/time.ts';
import type { Period } from './framework.ts';

export type SegmentDimension = 'branch' | 'day' | 'hour' | 'resourceType' | 'status' | 'method' | 'source' | 'category' | 'place';

/** Измерения, по которым отчёт разбивает показатели (K24 §3). */
export const REPORT_SEGMENTS: Readonly<Record<string, readonly SegmentDimension[]>> = {
  bookings: ['branch', 'day', 'resourceType', 'status'],
  utilization: ['branch', 'day', 'hour', 'resourceType'],
  finance: ['branch', 'day', 'method', 'source', 'category', 'place'],
  clients: ['branch', 'day'],
  loyalty: ['branch', 'day'],
  certificates: ['branch', 'day'],
};

/** Фильтры, которые сегмент может сузить. */
export interface SegmentTarget {
  period: Period;
  branchIds?: string[] | undefined;
  resourceType?: string[] | undefined;
  status?: string[] | undefined;
  method?: string[] | undefined;
  source?: string | undefined;
  categoryId?: string | undefined;
  place?: 'cash' | 'noncash' | undefined;
  hour?: string | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_RE = /^([01]\d|2[0-3])$/;
const TOKEN_RE = /^[a-z_]{1,40}$/;
const METHODS = ['cash', 'card', 'transfer'];

const invalid = (segment: string) => new AppError('REPORT_FILTER_INVALID', 422, 'Неверный сегмент', { field: 'segment', segment });

function asDay(value: string, segment: string): LocalDate {
  try {
    return parseLocalDate(value);
  } catch {
    throw invalid(segment);
  }
}

/** Сужение списочного фильтра: заданный фильтр обязан содержать значение сегмента. */
function narrow(current: string[] | undefined, value: string, segment: string): string[] {
  if (current?.length && !current.includes(value)) throw invalid(segment);
  return [value];
}

export function applySegment(report: string, segment: string | undefined, target: SegmentTarget): SegmentTarget {
  if (segment === undefined) return target;
  const at = segment.indexOf(':');
  const dimension = segment.slice(0, at) as SegmentDimension;
  const value = segment.slice(at + 1);
  if (at <= 0 || value === '' || !(REPORT_SEGMENTS[report] ?? []).includes(dimension)) throw invalid(segment);
  switch (dimension) {
    case 'branch':
      if (!UUID_RE.test(value)) throw invalid(segment);
      return { ...target, branchIds: narrow(target.branchIds, value, segment) };
    case 'day': {
      const day = asDay(value, segment);
      if (day < target.period.from || day > target.period.to) throw invalid(segment);
      return { ...target, period: { from: day, to: day } };
    }
    case 'hour':
      if (!HOUR_RE.test(value)) throw invalid(segment);
      return { ...target, hour: value };
    case 'resourceType':
      if (!TOKEN_RE.test(value)) throw invalid(segment);
      return { ...target, resourceType: narrow(target.resourceType, value, segment) };
    case 'status':
      if (!TOKEN_RE.test(value)) throw invalid(segment);
      return { ...target, status: narrow(target.status, value, segment) };
    case 'method':
      if (!METHODS.includes(value)) throw invalid(segment);
      return { ...target, method: narrow(target.method, value, segment) };
    case 'source':
      if (!TOKEN_RE.test(value)) throw invalid(segment);
      return { ...target, source: value };
    case 'category':
      if (!UUID_RE.test(value) || (target.categoryId !== undefined && target.categoryId !== value)) throw invalid(segment);
      return { ...target, categoryId: value };
    case 'place':
      if (value !== 'cash' && value !== 'noncash') throw invalid(segment);
      return { ...target, place: value };
  }
}
