// Действия аудита модуля clients (K2 §Реестр, группы «Доступ» и «Клиенты»). Новый код – только правкой K2.
export const auditActions = [
  'auth.client.login',
  'auth.client.login_failed',
  'auth.client.logout',
  'client.created',
  'client.updated',
  'client.status_changed',
  'client.consent_changed',
  'client.notification_prefs_changed',
] as const;
