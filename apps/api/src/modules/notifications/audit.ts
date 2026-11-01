// Действия аудита модуля notifications (K2 §Реестр, группа «Уведомления»).
// sent/failed/skipped – системные результаты отправки (K14). push_subscribed/push_unsubscribed – подписка браузера
// клиента (K9 POST/DELETE подписки); в K2 их пока нет – строка реестра добавляется правкой K2 при слиянии.
// В before/after endpoint – только маска (хост), ключи p256dh/auth не пишутся вовсе.
export const auditActions = [
  'notification.sent',
  'notification.failed',
  'notification.skipped',
  'notification.push_subscribed',
  'notification.push_unsubscribed',
] as const;
