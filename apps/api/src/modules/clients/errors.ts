// Коды ошибок модуля clients (K9 §Ошибки). Общие коды (AUTH_REQUIRED, SESSION_REVOKED, VALIDATION_FAILED) – в core/errors.ts.
export const errors = {
  OTP_RATE_LIMITED: 429, // слишком часто / много кодов на номер или с адреса (details.resendAfterSec)
  OTP_INVALID: 401, // неверный код (details.attemptsLeft)
  OTP_EXPIRED: 410, // срок вышел, попытки кончились, код заменён или такого запроса нет
  CONSENT_REQUIRED: 422, // новый клиент без согласия на обработку ПДн
  SMS_UNAVAILABLE: 503, // провайдер не принял сообщение; запрос кода сохранён, повтор после resendAfterSec
  CLIENT_RESTRICTED: 403, // клиенту нельзя бронировать или входить (blocked, restricted, deletion_requested)
  CLIENT_HAS_ACTIVE_RECORDS: 409, // обезличивание: у клиента бронь впереди или мероприятие в работе (details.blockers)
  CLIENT_MERGED: 409, // слияние: карточка уже объединена (details.clientId, mergedIntoId) – ещё раз нельзя
  CLIENT_NOT_MERGEABLE: 409, // слияние: обезличенная, с запросом на удаление, гость как основная при зарегистрированной второй (details.reason)
  CLIENT_MERGE_CONFLICT: 409, // слияние: записи карточек несовместимы – пересечение времени броней, подарок в тот же год (details.module, constraint)
} as const;
