-- 0006_staff: сотрудники, их сессии и попытки входа (K12, model-dannyh §0006).
-- Модуль-владелец – staff. Схема app: у yu_app SELECT/INSERT/UPDATE/DELETE (default privileges 0001).
-- Пароль – только argon2id-хеш; токен сессии – только HMAC-SHA256(token, SESSION_PEPPER).

-- migrate:up
CREATE TABLE app.staff (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name           text NOT NULL,
  last_name            text NOT NULL,
  email                text NOT NULL UNIQUE CHECK (email = lower(email)),
  phone_e164           text,
  role                 text NOT NULL CHECK (role IN ('owner','director','admin')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','archived')),
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  totp_secret_enc      text,
  last_login_at        timestamptz,
  rights_changed_at    timestamptz,
  rights_changed_by    uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  row_version          int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX staff_single_owner_idx ON app.staff ((true)) WHERE role = 'owner' AND status = 'active';

CREATE TABLE app.staff_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id       uuid NOT NULL REFERENCES app.staff(id),
  token_hash     text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoke_reason  text CHECK (revoke_reason IN ('logout','idle','blocked','admin','password_changed')),
  ip             inet,
  user_agent     text,
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX staff_sessions_active_idx ON app.staff_sessions (staff_id) WHERE revoked_at IS NULL;

CREATE TABLE app.staff_login_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_norm  text NOT NULL CHECK (email_norm = lower(email_norm)),
  staff_id    uuid,
  ip          inet,
  success     boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_login_attempts_idx ON app.staff_login_attempts (email_norm, at);
CREATE INDEX staff_login_attempts_ip_idx ON app.staff_login_attempts (ip, at) WHERE NOT success;

-- migrate:down
DROP TABLE app.staff_login_attempts;
DROP TABLE app.staff_sessions;
DROP TABLE app.staff;
