// Коды ошибок модуля loyalty (K15 §12; K10 §7 – POINTS_* отдаёт обработчик способа points).
// Общие коды не дублируются: COMMENT_REQUIRED – booking (общий код K11), LIMIT_OVERRIDE_NOT_ALLOWED – ledger (K3).
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  POINTS_INSUFFICIENT: 409, // доступных меньше нужного (details { availableCenti, requiredCenti }, 07 §6.2)
  POINTS_NOT_ALLOWED: 422, // тип ресурса вне loyalty.points_resource_types (Q-42)
  LOYALTY_LIMIT_REACHED: 403, // баланс −50, новая предварительная запись (07 §9.2, решение D2-06)
  RESERVE_HOLD_INVALID: 409, // удержание истекло, не своё, уже подтверждено
  LOYALTY_ISSUE_RESOLVED: 409, // корректировка ссылается на уже закрытое «требует решения» (K15 §9)
  GOODS_UNAVAILABLE: 409, // товар в архиве, не продаётся за баллы, нет в филиале, остаток 0
} as const satisfies Record<string, HttpStatus>;
