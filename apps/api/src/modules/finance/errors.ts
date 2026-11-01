// Коды ошибок модуля finance: оплата сеанса (K10 §7) и касса (K17 §11).
// Общие коды не дублируются (дубль роняет загрузку core/registry.ts): VERSION_CONFLICT – core, COMMENT_REQUIRED – booking
// (общий код K11), INVALID_AMOUNT и ALREADY_REVERSED – ledger (K3). Коды способов оплаты объявляют их владельцы:
// POINTS_* – loyalty (K15 §12), CERTIFICATE_* – certificates (K16 §12).
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  // K10 §7 – оплата
  ALREADY_PAID: 409, // у сеанса есть живой платёж (details.paymentId)
  AMOUNT_MISMATCH: 422, // сумма строк ≠ amountDueKop
  PAYMENT_METHODS_COMBINED: 422, // больше одной строки при выключенном R-03 или пара не «сертификат + деньги» (TC-07)
  BOOKING_NOT_PAYABLE: 409, // бронь не arrived/completed
  NOTHING_TO_PAY: 422, // none при сумме > 0 или деньги при сумме 0
  REFUND_EXCEEDS_PAID: 422, // возврат больше непогашенной части строки
  REFUND_PARTIAL_NOT_ALLOWED: 422, // частичный возврат строки баллов или сертификата
  PERIOD_CLOSED: 409, // дата операции в закрытом месяце (K10 §7, K17 §6)
  // K17 §11 – касса
  CASH_INSUFFICIENT: 409, // минус места денег при запрете (details { currentKop, afterKop })
  OPENING_BALANCE_EXISTS: 409, // второй начальный остаток места (details.operationId)
  SUBCATEGORY_REQUIRED: 422, // у категории есть подкатегории, не выбрана
  CATEGORY_ARCHIVED: 422, // выбрана архивная категория
  SESSION_INCOME_VIA_PAYMENT: 422, // ручной доход с источником «сеанс»
  USE_PAYMENT_REFUND: 409, // сторно/исправление прихода по сеансу – только возвратом платежа (K10)
  USE_CERTIFICATE_CANCEL: 409, // сторно/исправление прихода от продажи сертификата – только отменой продажи (K16 §6)
  CASH_SHIFT_REQUIRED: 409, // смена включена и не открыта
  CASH_SHIFT_ALREADY_OPEN: 409, // вторая открытая смена филиала
} as const satisfies Record<string, HttpStatus>;
