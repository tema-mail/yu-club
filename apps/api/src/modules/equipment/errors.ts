// Коды ошибок модуля equipment: оборудование, ремонт (K19 §15).
// Общие коды не дублируются: COMMENT_REQUIRED – booking (K11), OPERATION_ALREADY_LINKED – finance_links (K17 §14),
// ATTACHMENT_TOO_LARGE / ATTACHMENT_TYPE_NOT_ALLOWED – ядро core/files.ts (решение D3-07).
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  EQUIPMENT_NOT_PLACEABLE: 409, // списанное, утерянное или резервное ставится в единицу/комнату
  EQUIPMENT_MOVE_HAS_BOOKINGS: 409, // уход из единицы с будущими бронями или мероприятиями без подтверждения (details.bookingIds, details.eventIds)
  EQUIPMENT_WRITTEN_OFF: 409, // любое изменение списанного, кроме документов
  REPAIR_TRANSITION_INVALID: 409, // переход не по таблице K19 §6
  REPAIR_APPROVAL_REQUIRED: 409, // план выше repair.approval_threshold_kop без согласования
  REPAIR_CLOSE_INCOMPLETE: 422, // не хватает полей закрытия (details.fields)
  REPAIR_DATES_INVALID: 422, // brokenAt > detectedAt, нет даты и нет «неизвестна»
} as const satisfies Record<string, HttpStatus>;
