// Действия аудита модуля content (K2 «Контент Э4», «Медиа Э4»; K22 §16). Новый код – только правкой K2.
// content.draft_saved пишет только список изменённых полей, без текста (иначе аудит раздувается).
export const auditActions = [
  'content.draft_saved', // publication / game / room_page / branch_page / content_page / home_block
  'content.published', // after: номер версии
  'content.unpublished', // причина обязательна (12 §9.5)
  'content.archived',
  'content.rolled_back', // из какой версии
  'content.availability_changed', // доступность игры в филиале (объект game)
  'media.uploaded',
  'media.updated', // alt, title
  'media.archived',
  'media.purged', // принудительная очистка по требованию субъекта: основание, затронутые сущности (S4-45)
  'media.deleted', // физическое удаление неиспользованного, K11 №227 (D4-05)
] as const;
