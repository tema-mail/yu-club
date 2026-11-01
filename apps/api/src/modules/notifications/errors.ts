// Коды ошибок модуля notifications. Общие (AUTH_REQUIRED, SESSION_REVOKED, VALIDATION_FAILED) – в core/errors.ts.
export const errors = {
  PUSH_NOT_CONFIGURED: 503, // на сервере нет ключей VAPID – подписка недоступна, сервисные остаются в ЛК
  PUSH_ENDPOINT_NOT_ALLOWED: 422, // endpoint не известного push-сервиса (защита от отправки на произвольный адрес)
} as const;
