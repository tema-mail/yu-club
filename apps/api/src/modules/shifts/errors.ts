// Коды ошибок модуля shifts: смены, табель, ставки, зарплата (K18 §15).
// Общие коды не дублируются (дубль роняет загрузку core/registry.ts): INVALID_DURATION – core, OUTSIDE_SCHEDULE и
// COMMENT_REQUIRED – booking (общие коды K5/K11), INVALID_AMOUNT – ledger (K3), OPERATION_ALREADY_LINKED – finance_links (K17 §14).
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  STAFF_NOT_ACTIVE: 409, // сотрудник заблокирован или в архиве
  STAFF_ON_LEAVE: 409, // «временно не работает» – новые смены запрещены (05 §3.2)
  STAFF_NOT_ASSIGNED: 422, // нет действующего назначения на филиал на дату смены (05 §12.5)
  SHIFT_OVERLAP: 409, // пересечение со своей сменой в любом филиале (TC-15; details.conflictShiftId, details.branchId – если в зоне)
  SHIFT_TOO_SHORT: 422, // короче shift.min_minutes, если ключ задан
  SHIFT_EDIT_DEADLINE: 409, // своя смена ближе срока shift.self_edit_deadline_hours
  SHIFT_NOT_EDITABLE: 409, // прошедшая смена сотрудником; worked без shift.attendance.correct
  CHECKIN_WINDOW: 409, // приход раньше окна или после конца смены
  PAYROLL_PERIOD_CLOSED: 409, // запись или изменение с датой в закрытом периоде
  PAYROLL_PERIOD_OVERLAP: 409, // новый период пересекает существующий
  PAYROLL_PERIOD_HAS_UNRESOLVED: 409, // закрытие при needs_review / rate_missing / без начисления (details.shiftIds, details.rateIds)
  PAYROLL_PERIOD_OPEN: 409, // ready / paid у ведомости незакрытого периода
  BRANCH_REQUIRED: 422, // штраф Директора без филиала
  PAYROLL_STATEMENT_NEEDS_REVIEW: 409, // ready при нерешённых сменах
  PAYOUT_EXPENSE_EXISTS: 409, // второй расход на ту же выплату (TC-19; details.operationIds)
  PAYOUT_AMOUNT_MISMATCH: 422, // привязка расхода с другой суммой
  FEATURE_DISABLED: 409, // премия или штраф при выключенном флаге payroll.bonus_enabled / payroll.penalties_enabled
} as const satisfies Record<string, HttpStatus>;
