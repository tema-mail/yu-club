// Действия аудита модуля network (K2 §Реестр, группа «Структура»). Новый код – только правкой K2.
// Смена зоны филиала пишется как branch.updated с before/after.timezone (решение: отдельного кода в K2 нет).
export const auditActions = [
  'city.created',
  'city.updated',
  'city.archived',
  'branch.created',
  'branch.updated',
  'branch.archived',
  'branch.status_changed',
  'branch.hours_changed',
  'calendar.exception_created',
  'calendar.exception_cancelled',
] as const;
