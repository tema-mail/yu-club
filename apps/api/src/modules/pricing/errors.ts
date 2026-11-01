// Коды ошибок модуля pricing (K5 §Ошибки, K6 §Цена). Последние два – решение исполнителя S1-14 (в контрактах их нет).
export const errors = {
  TARIFF_NOT_CONFIGURED: 422, // нет действующего тарифа – запись недоступна, не 0 ₽ (15 §9.3)
  TARIFF_AMBIGUOUS: 422, // два применимых тарифа с одинаковым наибольшим приоритетом (15 §9.3)
  TARIFF_PRIORITY_CONFLICT: 409, // сохранение: пересечение с тарифом того же приоритета (15 §20, EXCLUDE tariffs_same_priority_overlap)
  TARIFF_ARCHIVED: 409, // архивный тариф не меняется
} as const;
