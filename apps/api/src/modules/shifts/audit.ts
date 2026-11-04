// Действия аудита модуля shifts (K2 §Реестр, группы «Смены» и «Зарплата» Э3; K18 §17). Новый код – только правкой K2.
// Суммы и ставки в before/after отдаются только при payroll.view в зоне записи (K18 §10).
export const auditActions = [
  'shift.created',
  'shift.updated',
  'shift.cancelled',
  'shift.attendance_set',
  'shift.review_flagged', // задача shifts.review, автор system (K18 §5)
  'shift.change_acknowledged', // «ознакомлен» с чужой правкой (K18 §4)
  'staff.rate_set', // K18 §3
  'staff.planning_changed', // «временно не работает» (K18 §2)
  'staff.employment_changed', // даты работы, комментарий руководителя (K18 §2)
  'payroll.period.created',
  'payroll.period.closed',
  'payroll.statement.calculated',
  'payroll.statement.status_changed',
  'payroll.paid',
  'payroll.penalty.created',
  'payroll.penalty.cancelled',
  'payroll.penalty.amended',
  'payroll.bonus.created',
  'payroll.bonus.cancelled',
  'payroll.bonus.amended',
  'payroll.correction.posted',
  'payroll.payout_expense.created',
  'payroll.payout_expense.linked',
] as const;
