// Коды ошибок модуля events: мероприятия, платный праздник, подарок имениннику (K20 §16).
// Общие коды не дублируются: CONSENT_REQUIRED – clients (K9), RATE_LIMITED – core, SLOT_TAKEN / RESOURCE_BLOCKED /
// OUTSIDE_SCHEDULE / COMMENT_REQUIRED – booking (K5, K6, K11), RESOURCE_UNAVAILABLE – resources;
// коды связей кассы (OPERATION_*, EVENT_REFUND_EXCEEDS_INCOME, INCOME_HAS_REFUNDS) – finance_links в core/registry.ts (D3-04).
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  EVENT_NOT_READY: 422, // подтверждение без даты, филиала, состава (details.fields)
  EVENT_TRANSITION_INVALID: 409, // переход не по таблице K20 §2
  EVENT_CLOSED: 409, // правка состава/ресурсов в конечном статусе
  EVENT_MOVE_RESOURCES_INVALID: 422, // перенос: не все активные строки, повтор строки, период вне новых дат (details.reason, eventResourceIds)
  PARTY_RESOURCE_INVALID: 422, // праздник не на комнате целиком (K20 §4, TC-13)
  PARTY_TOO_SHORT: 422, // короче event.party.min_minutes
  PARTY_GUESTS_LIMIT: 422, // гостей больше event.party.max_guests
  PARTY_FORMAT_MISMATCH: 422, // длительность не соответствует формату (2 ч / 3+ ч / весь день)
  GIFT_NOT_ACTIVE: 409, // подарок не issued (использован, отменён, уже записан)
  GIFT_EXPIRED: 409, // запись после validUntil
  GIFT_WEEKDAY_ONLY: 422, // суббота или воскресенье (11 §9.3)
  GIFT_HOLIDAY: 422, // праздничный день сети или города филиала
  GIFT_COMPOSITION_INVALID: 422, // не подарочный ресурс или лишняя позиция (PS4) в удержании подарка
  GIFT_ALREADY_RESERVED: 409, // у подарка уже есть живая запись (gift_uses_one_live)
  GIFT_CLIENT_MISMATCH: 422, // клиент брони/удержания ≠ владелец подарка
  GIFT_ALREADY_ISSUED: 409, // второй подарок клиенту в gift.per_client_days (birthday_gifts_one_per_year)
  GIFT_BASIS_INVALID: 422, // основание – не день рождения этого клиента или не в нужном статусе
} as const satisfies Record<string, HttpStatus>;
