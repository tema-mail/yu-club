// K22 §8, K11 №227а: очистка фото по требованию субъекта. Коды причин и их подписи – одни для API (media-purge.ts: проверка кода,
// причина в аудите и в новой версии сущности) и CRM (MediaLibrary.tsx: список в окне очистки). Без зависимостей.
export const PURGE_REASON_CODES = ['subject_request', 'consent_withdrawn', 'rights_claim', 'legal_order'] as const;
export type PurgeReasonCode = (typeof PURGE_REASON_CODES)[number];

export const PURGE_REASON_LABEL: Record<PurgeReasonCode, string> = {
  subject_request: 'Требование человека на фото',
  consent_withdrawn: 'Отзыв согласия на использование изображения',
  rights_claim: 'Претензия правообладателя',
  legal_order: 'Предписание или решение суда',
};

/** Основание словами (номер и дата документа, без ФИО) – не длиннее. */
export const PURGE_BASIS_MAX = 200;
