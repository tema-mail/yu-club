// Действия аудита модуля staff (K2 §Реестр, группа «Доступ»). Новый код – только правкой K2.
export const auditActions = [
  'auth.staff.login',
  'auth.staff.login_failed',
  'auth.staff.logout',
  'auth.staff.sessions_ended',
  'staff.blocked',
  'staff.unblocked',
  'staff.contacts_changed',
  'staff.role_changed',
  'staff.scope_changed',
  'staff.created',
  // K2 «Э3», делегирование (S3-89)
  'staff.grant.created',
  'staff.grant.revoked',
] as const;
