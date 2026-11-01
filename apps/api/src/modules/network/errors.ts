// Коды ошибок модуля network (K13 §Ошибки). Последние четыре – решение исполнителя S0-11 (в K13 их нет).
export const errors = {
  AFFECTED_CHANGED: 409, // список затронутых броней обновился – показать заново (K13 applyHoursChange)
  SCHEDULE_CONFLICT: 409, // два исключения на объект и дату (EXCLUDE calendar_exceptions)
  INVALID_HOURS: 422, // close ≤ open
  CITY_HAS_ACTIVE_BRANCHES: 409, // архив города, пока есть неархивные филиалы (02 §5.2)
  OBJECT_IN_USE: 409, // физическое удаление использованного объекта (02 §12)
  NETWORK_SLUG_TAKEN: 409, // код или slug уже заняты (город – в сети, филиал – в городе)
  INVALID_TIMEZONE: 422, // зона не IANA (ADR 0003 п.2, isValidTimeZone)
  CITY_ARCHIVED: 409, // филиал в архивном городе: создать или вернуть нельзя
  BRANCH_ARCHIVED: 409, // архивный филиал не редактируется
} as const;
