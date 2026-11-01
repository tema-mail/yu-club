// Коды ошибок модуля clients (K9 §Ошибки). Общие коды (AUTH_REQUIRED, SESSION_REVOKED, VALIDATION_FAILED) – в core/errors.ts.
export const errors = {
  OTP_RATE_LIMITED: 429, // слишком часто / много кодов на номер или с адреса (details.resendAfterSec)
  OTP_INVALID: 401, // неверный код (details.attemptsLeft)
  OTP_EXPIRED: 410, // срок вышел, попытки кончились, код заменён или такого запроса нет
  CONSENT_REQUIRED: 422, // новый клиент без согласия на обработку ПДн
  SMS_UNAVAILABLE: 503, // провайдер не принял сообщение; запрос кода сохранён, повтор после resendAfterSec
  CLIENT_RESTRICTED: 403, // клиенту нельзя бронировать или входить (blocked, restricted, deletion_requested)
} as const;
