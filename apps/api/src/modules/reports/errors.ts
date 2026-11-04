// Коды ошибок модуля reports (K24 §10). Общие (NOT_FOUND – филиал вне зоны, FORBIDDEN) – в core/errors.ts.
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  REPORT_UNKNOWN: 404, // нет такого отчёта
  REPORT_PERIOD_INVALID: 422, // from > to, будущее больше года
  REPORT_PERIOD_TOO_LONG: 422, // интерактивно больше reports.interactive_max_days, details.useExport
  REPORT_FILTER_INVALID: 422, // фильтр не по схеме
  REPORT_TIMEOUT: 504, // statement_timeout пула отчётов: «сузьте период или сформируйте файл»
  EXPORT_TOO_LARGE: 422, // больше 200 000 строк
  EXPORT_NOT_READY: 409, // файл ещё не готов
  EXPORT_EXPIRED: 410, // прошло reports.export_ttl_hours
  EXPORT_FORBIDDEN: 403, // право потеряно до скачивания
  SEARCH_QUERY_TOO_SHORT: 422, // меньше 2 символов (телефон – 4 цифр), K24 §5
} as const satisfies Record<string, HttpStatus>;
