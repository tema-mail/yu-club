// Действия аудита модуля loyalty (K2 §Реестр, группа «Баллы» Э2). Новый код – только правкой K2.
// Начисления, штрафы, списания и истечения – проводки K3: их аудит – ledger.posted / ledger.reversed (K3 правило 6).
export const auditActions = [
  'loyalty.adjusted', // ручная корректировка ± с причиной (K15 §9)
  'loyalty.booked_below_limit', // бронь в CRM при −50 по праву loyalty.book_below_limit с причиной (K15 §8, R-13)
  'loyalty.issue.created', // «требует решения»: сторно ниже −50 (K15 §4)
  'loyalty.issue.resolved',
  'loyalty.reserve.created', // резерв на удержание (K15 §3)
  'loyalty.reserve.released',
  'loyalty.goods.created', // каталог товаров (K15 №26)
  'loyalty.goods.updated',
  'loyalty.goods.archived',
  'loyalty.goods.issued', // выдача за баллы (K15 №27)
  'loyalty.goods.returned', // возврат невыданного (K15 №28)
] as const;
