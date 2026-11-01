// Коды ошибок модуля resources (K5 §Коды, K6 §Ошибки, K13 §Ошибки).
// RESOURCE_SLUG_TAKEN, RESOURCE_LINK_INVALID, RESOURCE_ARCHIVED – решение исполнителя S1-01 (в контрактах их нет).
export const errors = {
  RESOURCE_UNAVAILABLE: 409, // ресурс/комната не active, несамостоятельный (PS4), состав пуст (K5, K6 expandToUnits)
  COMPOSITE_CHANGED: 409, // состав сменился между развёрткой и записью занятия (K5, lockCompositions)
  COMPOSITION_HAS_FUTURE_BOOKINGS: 409, // смена состава при будущих бронях/удержаниях (K6 changeComposition)
  RESOURCE_SLUG_TAKEN: 409, // slug комнаты или код единицы уже заняты в филиале
  RESOURCE_LINK_INVALID: 422, // комната / помещение / единица из другого филиала или в архиве
  RESOURCE_ARCHIVED: 409, // архивный объект не редактируется (архив – только просмотр, 02 §12)
} as const;
