// Коды ошибок модуля staff (K12 §Ошибки). Общие коды (SESSION_REVOKED и др.) – в core/errors.ts.
export const errors = {
  INVALID_CREDENTIALS: 401, // неверный email/пароль/TOTP – один ответ на всё
  LOGIN_LOCKED: 429, // перебор
  PASSWORD_TOO_WEAK: 422, // новый пароль не по правилу
  PASSWORD_CHANGE_REQUIRED: 403, // must_change_password: до смены – только session, password, logout
  GRANT_ALREADY_ACTIVE: 409, // K1 «Делегирование»: то же действие и зона на пересекающиеся даты
} as const;
