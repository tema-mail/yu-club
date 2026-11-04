// Действия аудита модуля notifications (K2 §Реестр, группа «Уведомления»; Э4 – K21 §14).
// sent/failed/skipped – системные результаты отправки (K14). push_subscribed/push_unsubscribed – подписка браузера
// клиента (K9 POST/DELETE /me/push-subscriptions), строка реестра K2 «Уведомления».
// В before/after endpoint – только маска (хост), ключи p256dh/auth не пишутся вовсе.
export const auditActions = [
  'notification.sent',
  'notification.failed',
  'notification.skipped',
  'notification.push_subscribed',
  'notification.push_unsubscribed',
  // ---- Э4 (K2 «Уведомления Э4»). Текст кампании пишется один раз – при подтверждении, шаблоном без подстановки (09 §14, K21 §15).
  'notification.campaign_created',
  'notification.campaign_updated',
  'notification.campaign_confirmed', // after: категория, текст, описание аудитории, total
  'notification.campaign_cancelled', // причина обязательна
  'notification.retried', // ручной повтор критичного сервисного (K21 §9)
  'notification.template_created',
  'notification.template_updated',
  'notification.template_archived',
  'notification.unsubscribed', // отписка по ссылке: актор client, source 'site', after.via = 'unsubscribe_link' (D4-04)
] as const;
