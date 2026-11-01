// Действия аудита модуля resources (K2 §Реестр, группа «Ресурсы»). Новый код – только правкой K2.
// Своего типа объекта у единицы занятости (occupancy_units) в K2 нет: её создание пишется как room.updated
// (единица живёт в комнате) или внутри resource.created / resource.composition_changed (решение S1-02).
export const auditActions = [
  'space.created',
  'space.updated',
  'space.archived',
  'room.created',
  'room.updated',
  'room.archived',
  'resource.created',
  'resource.updated',
  'resource.archived',
  'resource.composition_changed',
] as const;
