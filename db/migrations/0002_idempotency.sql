-- 0002_idempotency: ключи идемпотентности команд (ADR 0004 §2, model-dannyh 0002).
-- Ключ захватывается в той же транзакции, что и команда; откат команды снимает и ключ.
-- created_at / expires_at передаёт команда из Clock ($now), DEFAULT now() намеренно нет (ADR 0003 п.10).
-- Схема app: yu_app получает SELECT/INSERT/UPDATE/DELETE по default privileges из 0001
-- (DELETE нужен задаче очистки просроченных ключей).

-- migrate:up
CREATE TABLE app.idempotency_keys (
  scope           text        NOT NULL,          -- '<actorType>:<actorId>:<operation>'
  key             uuid        NOT NULL,
  request_hash    text        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),  -- sha256 hex
  response_status smallint,                      -- пишется в той же транзакции до фиксации
  response_body   jsonb,
  created_at      timestamptz NOT NULL,          -- $now из Clock
  expires_at      timestamptz NOT NULL,          -- $now + 72 ч
  PRIMARY KEY (scope, key),
  CHECK (expires_at > created_at)
);
CREATE INDEX idempotency_keys_expires_idx ON app.idempotency_keys (expires_at);

-- migrate:down
DROP TABLE app.idempotency_keys;
