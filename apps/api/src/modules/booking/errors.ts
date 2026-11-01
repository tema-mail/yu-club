// Коды ошибок модуля booking (K5 §Коды, K6 §Ошибки, K11). Коды подтверждения и отмены – шаги S1-07…S1-10.
export const errors = {
  SLOT_TAKEN: 409, // подтверждённая бронь или мероприятие на этой единице
  SLOT_HELD: 409, // чужое активное удержание; или повтор после 40P01/40001 снова не прошёл (ADR 0004 §3)
  RESOURCE_BLOCKED: 409, // блокировка / ремонт (K6 assertNotBlocked)
  RANGE_TOO_LONG: 422, // период расписания > 7 дней (K11)
  CLIENT_OVERLAP: 409, // у клиента бронь/удержание на пересекающееся время по сети (01 §9, client_time_no_overlap)
  VISITOR_REQUIRED: 400, // POST /holds без куки yu_visitor и без входа (K5)
  BRANCH_NOT_ACTIVE: 409, // филиал не принимает записи (status, временное закрытие)
  OUTSIDE_BOOKING_WINDOW: 422, // дата вне окна или start ≤ now
  OUTSIDE_SCHEDULE: 409, // вне рабочих часов / день закрыт
  HOLD_EXPIRED: 410, // удержание истекло (01 §7.3)
  HOLD_ALREADY_ACTIVE: 409, // у владельца уже есть активное удержание в филиале (details.holdId)
  HOLD_LIMIT_REACHED: 422, // позиций больше booking.max_hold_items
  BOOKING_NOT_CANCELLABLE: 409, // отмена клиентом не из confirmed, после начала или выключена (K5 №13, R-12)
  INVALID_STATUS_TRANSITION: 409, // переход не разрешён dict_status_transitions (K11)
  ARRIVAL_TOO_EARLY: 409, // приход раньше окна visit.arrive_early_min до начала (Q-101, details.arriveFrom)
  COMMENT_REQUIRED: 422, // отмена без комментария, исправление/перенос без причины (K11, 01 §12)
} as const;
