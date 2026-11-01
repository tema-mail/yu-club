// Действия аудита модуля certificates (K2 §Реестр, группа «Сертификаты» Э2). Новый код – только правкой K2.
// Код сертификата (pin) и его хэш в аудит не пишутся (K16 §3, 04 §11.2).
export const auditActions = [
  'certificate.sold', // K16 §2
  'certificate.redeemed', // погашение строкой оплаты K10 (K16 §5)
  'certificate.redemption_returned', // возврат погашения (K16 §6)
  'certificate.expired', // задача сгорания, автор system (K16 §4)
  'certificate.cancelled', // отмена продажи (K16 §6)
  'certificate.corrected', // корректировка остатка (K16 §6)
  'certificate.review_changed', // «требует проверки» включён / снят (K16 §6)
  'certificate.recipient_changed', // получатель (K16 §7)
  'certificate.pin_reissued', // перевыпуск кода, право certificate.correct (K16 §3)
  'certificate.pin_locked', // 5 неверных кодов (K16 §3)
] as const;
