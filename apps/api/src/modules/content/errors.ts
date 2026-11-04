// Коды ошибок модуля content (K22 §14, K23 §3). Общие (VERSION_CONFLICT, NOT_FOUND, VALIDATION_FAILED) – в core/errors.ts.
// SLUG_IN_HISTORY – предупреждение K23 §3 (ответ slug-check), не ошибка: в реестр не входит.
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  CONTENT_INCOMPLETE: 422, // не хватает полей для публикации (K22 §9), details.fields: [{ field, code }]
  CONTENT_INVALID: 400, // черновик не проходит схему типа, details.issues
  CONTENT_STATUS_CONFLICT: 409, // действие не из этого статуса (архив опубликованного, публикация архивного)
  PAGE_KEY_UNKNOWN: 404, // ключ страницы вне списка карты сайта (K22 §5)
  RICH_TEXT_HTML_FORBIDDEN: 422, // сырой HTML в тексте (K22 §6)
  RICH_TEXT_TOO_LONG: 422, // больше 50 000 знаков
  MEDIA_TYPE_NOT_ALLOWED: 415, // сигнатура или формат sharp не JPEG/PNG/WebP (PDF – только document); SVG запрещён
  MEDIA_TOO_LARGE: 413, // часть больше 10 МБ (Q-96)
  MEDIA_DIMENSIONS_TOO_LARGE: 422, // больше 40 Мп (limitInputPixels)
  MEDIA_QUOTA_EXCEEDED: 507, // MEDIA_QUOTA_GB исчерпана (K22 §8)
  MEDIA_ALT_REQUIRED: 422, // публикация с недекоративной картинкой без alt
  MEDIA_IN_USE: 409, // архив или удаление используемого, details.usages
  MARKETING_DOCUMENT_MISSING: 409, // согласие на рекламу без опубликованного advertising-consent (K22 §7); бросают notifications и clients (D4-06)
  PREVIEW_TOKEN_INVALID: 404, // подделка, истечение, новая правка черновика (K22 §11) – как несуществующая страница
  SLUG_INVALID: 422, // маска или длина (K23 §3), details.rule
  SLUG_RESERVED: 422, // зарезервированное слово карты сайта п.2.8
  SLUG_TAKEN: 409, // занят у родителя, details.suggestion
} as const satisfies Record<string, HttpStatus>;
