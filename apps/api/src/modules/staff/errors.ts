// Коды ошибок модуля staff (K12 §Ошибки). Общие коды (SESSION_REVOKED и др.) – в core/errors.ts.
export const errors = {
  INVALID_CREDENTIALS: 401, // неверный email/пароль/TOTP – один ответ на всё
  LOGIN_LOCKED: 429, // перебор
  PASSWORD_TOO_WEAK: 422, // новый пароль не по правилу
} as const;
