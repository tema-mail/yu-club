// Коды ошибок модуля notifications. Общие (AUTH_REQUIRED, SESSION_REVOKED, VALIDATION_FAILED, VERSION_CONFLICT) – в core/errors.ts.
// MARKETING_DOCUMENT_MISSING (K22 §7) регистрирует content – бросает notifications по живой версии документа (D4-06).
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  PUSH_NOT_CONFIGURED: 503, // на сервере нет ключей VAPID – подписка недоступна, сервисные остаются в ЛК
  PUSH_ENDPOINT_NOT_ALLOWED: 422, // endpoint не известного push-сервиса (защита от отправки на произвольный адрес)
  // ---- Э4 (K21 §12, §13)
  CATEGORY_REQUIRED: 422, // нет category или purpose у личного (09 §3.5, §7.3)
  SERVICE_NEEDS_SUBJECT: 422, // service без брони или мероприятия клиента (K21 §4)
  SEGMENT_SERVICE_FORBIDDEN: 422, // service на аудиторию segment
  SEGMENT_INVALID: 422, // сегмент не проходит segment.v1 или пустая область, details.issues
  AUDIENCE_EMPTY: 422, // total = 0 при подтверждении
  AUDIENCE_CHANGED: 409, // expectedTotal не совпал, details.total (двойное подтверждение 09 §7.5)
  CAMPAIGN_NOT_EDITABLE: 409, // правка не-draft
  CAMPAIGN_ALREADY_FINISHED: 409, // отмена done / cancelled
  PLANNED_AT_OUT_OF_RANGE: 422, // plannedAt в прошлом или позже notifications.campaign_max_plan_days
  TEMPLATE_PLACEHOLDER_UNKNOWN: 422, // плейсхолдер вне белого списка K21 §8
  RETRY_NOT_ALLOWED: 409, // повтор не-service или статуса не error / no_channel
  UNSUBSCRIBE_TOKEN_INVALID: 400, // подпись не сошлась (K21 §4)
  UNSUBSCRIBE_TOKEN_EXPIRED: 410, // старше 90 дней – страница предлагает войти
  MARKETING_ERID_REQUIRED: 422, // подтверждение рекламы без erid при notifications.marketing_require_erid = true
  MARKETING_NOT_CONFIGURED: 503, // нет UNSUBSCRIBE_SECRET – рекламу нельзя подтвердить (K21 §13; в таблице §12 не было, D4-06)
} as const satisfies Record<string, HttpStatus>;
