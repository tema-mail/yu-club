-- 0106_client_auth: одноразовые коды входа клиента и его сессии (K9, model-dannyh §0106, 03 §5.2, §6).
-- Модуль-владелец – clients. Код в базе – только HMAC-SHA256 с секретом SESSION_PEPPER; токен сессии – тоже.
-- Живой код у номера один (частичный UNIQUE): новый запрос сначала гасит прежний (superseded_at).
-- Время пишет приложение из Clock ($now); DEFAULT now() – страховка для ручных вставок.

-- migrate:up
CREATE TABLE app.client_otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164    text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash     text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at    timestamptz NOT NULL,
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  smallint NOT NULL CHECK (max_attempts > 0),
  consumed_at   timestamptz,
  superseded_at timestamptz,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX client_otp_one_live_idx ON app.client_otp_challenges (phone_e164)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE INDEX client_otp_rate_idx ON app.client_otp_challenges (phone_e164, created_at);
CREATE INDEX client_otp_ip_rate_idx ON app.client_otp_challenges (ip, created_at) WHERE ip IS NOT NULL;

CREATE TABLE app.client_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES app.clients(id),
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('logout','expired','blocked','compromised')),
  user_agent    text,
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX client_sessions_active_idx ON app.client_sessions (client_id) WHERE revoked_at IS NULL;

-- migrate:down
DROP TABLE app.client_sessions;
DROP TABLE app.client_otp_challenges;
