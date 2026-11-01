# K12. Вход сотрудника и сессии

Модуль: `staff` (`apps/api/src/modules/staff/auth.ts`, S0-09). Таблицы: `staff`, `staff_sessions`, `staff_login_attempts` (model-dannyh 0006). Потребители: CRM (S0-14), хук Fastify `requireStaff` для всех маршрутов K11.
Основа: 04 §3.1, §6.3, §11.3, §12; 17 §7.4–7.5; N-05 (почта + пароль, TOTP по желанию); K7 ключи `staff.*`.

## Маршруты (`/api/crm/v1/auth`)

| # | Метод и путь | Тело | Успех | Правила |
|---|---|---|---|---|
| 1 | `POST /login` | `{ email, password, totp?: string }` | `200 { staff: { id, firstName, lastName, role }, totpRequired: false }` + `Set-Cookie: yu_staff` | email → `lower()`; ответ на неверный email и неверный пароль одинаковый (`401 INVALID_CREDENTIALS`), время ответа выравнивается проверкой фиктивного хеша; у сотрудника с TOTP без кода → `200 { totpRequired: true }` без сессии |
| 2 | `POST /logout` | – | `204` | `revoke_reason='logout'`, кука стирается |
| 3 | `GET /session` | – | `200 { staff, expiresAt, idleExpiresAt }` | продлевает `last_seen_at` |
| 4 | `POST /password` | `{ currentPassword, newPassword }` | `204` | новый ≥ 12 символов (решение); все **другие** сессии → `password_changed` |
| 5 | `POST /staff/{staffId}/end-sessions` | `{ reason }` | `204` | право `staff.block` + `assertCanManageStaff(op:'end_sessions')` (K1) |
| 6 | `POST /staff/{staffId}/block` / `unblock` | `{ rowVersion, reason }` | `200` | блокировка завершает все сессии в той же транзакции (04 §6.3) |
| 7 | `POST /totp/setup`, `POST /totp/confirm`, `POST /totp/disable` | `{ code }` | `200` | по желанию сотрудника (N-05), секрет шифруется ключом `TOTP_ENC_KEY` из окружения (ADR 0001) |

Сброс забытого пароля (17 §7.5): Владелец/Директор (по K1) выставляет временный пароль через №6-подобный маршрут `POST /staff/{id}/reset-password` → ответ показывает пароль один раз, сотрудник обязан сменить при входе (`staff.must_change_password`, model-dannyh 0006; решение). Пароль в аудит и логи не попадает.

## Функции

```ts
export function hashPassword(plain: string): Promise<string>;             // @node-rs/argon2, argon2id, m=19456 KiB, t=2, p=1 (OWASP)
export function verifyPassword(hash: string, plain: string): Promise<boolean>;

/** Хук: кука yu_staff → HMAC → staff_sessions. Отклоняет, если revoked, now ≥ expires_at,
 *  now − last_seen_at ≥ staff.session_idle_minutes (K7) – тогда revoke_reason='idle'; staff.status ≠ 'active'.
 *  Обновляет last_seen_at не чаще раза в минуту. Результат – Actor для loadAccess (K1). */
export function resolveStaffSession(db: Db, rawToken: string, clock: Clock): Promise<{ staffId: string; sessionId: string } | null>;
```

Кука `yu_staff`: 32 случайных байта base64url, HttpOnly, Secure, SameSite=Strict, `Path=/`, домен CRM; в базе – только `HMAC-SHA256(token, SESSION_PEPPER)`. Абсолютный срок – `staff.session_absolute_hours`.

## Защита от перебора

- Каждая попытка – строка `staff_login_attempts` (email, ip, успех).
- `≥ staff.login_max_failures` неудач по email за `staff.login_lock_minutes` → вход по этому email закрыт на тот же срок: `429 LOGIN_LOCKED` с `details.retryAfterSec` (ответ одинаков для существующего и несуществующего email).
- По IP: > 50 неудач за 15 мин → `429` для этого IP (решение).
- Успешный вход не обнуляет историю, но окно считается от последней успешной попытки.

## Аудит (K2)

`auth.staff.login`, `auth.staff.login_failed` (без пароля, с email в маске), `auth.staff.logout`, `auth.staff.sessions_ended`, `staff.blocked`/`unblocked` (04 §11.3).

## Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | неверный email/пароль/TOTP |
| `LOGIN_LOCKED` | 429 | перебор |
| `SESSION_REVOKED` | 401 | сессия отозвана, истекла, сотрудник заблокирован |
| `PASSWORD_TOO_WEAK` | 422 | новый пароль не по правилу |

## Проверка (S0-09)

Вход/выход; 10 неверных паролей → `LOGIN_LOCKED`; заблокированный теряет сессию на следующем же запросе; простой дольше `session_idle_minutes` (через `fixedClock`) → `SESSION_REVOKED`; в аудите вход и отказ, пароля нет нигде (поиск строки пароля в логах теста).
