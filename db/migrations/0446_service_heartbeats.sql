-- 0446_service_heartbeats: пульс фоновых процессов для GET /health/deep (17 §13.1 «задержки фоновых задач», 18 §9.4
-- «мониторинг и уведомления об авариях работают»). Одна строка на службу: worker обновляет её раз в 30 с
-- (core/heartbeat.ts) – это текущее состояние, а не журнал, поэтому схема app и UPDATE (права по умолчанию 0001:
-- полный DML у yu_app). details – только цифры очереди pg-boss (API под yu_app схему pgboss не видит, ADR 0001),
-- без ПДн и секретов: строку читает /health/deep без авторизации.

-- migrate:up
CREATE TABLE app.service_heartbeats (
  service    text PRIMARY KEY CHECK (service ~ '^[a-z_]{1,32}$'),   -- 'worker'
  instance   text NOT NULL CHECK (length(instance) <= 120),         -- хост:pid – для разбора, наружу не отдаётся
  version    text NOT NULL CHECK (length(version) <= 64),           -- GIT_SHA процесса
  started_at timestamptz NOT NULL,                                  -- первый пульс этого процесса
  beat_at    timestamptz NOT NULL,                                  -- последний пульс; старше 90 с – worker стоит
  details    jsonb NOT NULL DEFAULT '{}'::jsonb                     -- { queue: { queued, active, failedLastHour, oldestReadySec } }
);

-- migrate:down
DROP TABLE app.service_heartbeats;
