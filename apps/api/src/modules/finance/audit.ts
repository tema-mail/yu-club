// Действия аудита модуля finance (K2 §Реестр, группа «Деньги» Э2). Новый код – только правкой K2.
export const auditActions = [
  'payment.recorded', // K10 §4
  'payment.refunded', // K10 §4
  'finance.operation.created', // K17 §4 postMoneyOperation – в том числе чужих модулей (оплата, продажа сертификата)
  'finance.operation.reversed', // K17 §4 сторно
  'finance.operation.corrected', // K17 §4 сторно + новая операция
  'finance.category.created',
  'finance.category.updated',
  'finance.category.archived',
  'finance.period.closed', // K17 §6
  'cash_shift.opened', // K17 §7
  'cash_shift.closed',
  'cash_shift.resolved',
] as const;
