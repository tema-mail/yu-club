-- 0005_outbox: события outbox и учёт обработанных (ADR 0004 §4, K4, model-dannyh 0005).
-- Событие пишется той же транзакцией, что и факт; NOTIFY outbox уходит только при фиксации.
-- Схема app: yu_app – обычный DML (диспетчер ставит dispatched_at, обработчик пишет processed_events).

-- migrate:up
CREATE TABLE app.outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- = eventId в K4
  event_type     text NOT NULL,
  event_version  smallint NOT NULL CHECK (event_version >= 1),
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  branch_id      uuid,
  payload        jsonb NOT NULL,
  dedupe_key     text NOT NULL UNIQUE,    -- '<event_type>:<aggregate_id>:<aggregate_version>'
  occurred_at    timestamptz NOT NULL,    -- $now из Clock
  dispatched_at  timestamptz              -- поставлено в pg-boss
);
CREATE INDEX outbox_undispatched_idx ON app.outbox_events (occurred_at) WHERE dispatched_at IS NULL;

CREATE TABLE app.processed_events (
  handler      text NOT NULL,
  event_id     uuid NOT NULL REFERENCES app.outbox_events(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handler, event_id)
);

-- Будит диспетчер; pg_notify доставляется слушателям только после COMMIT.
CREATE FUNCTION app.outbox_notify() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_notify('outbox', NEW.id::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER outbox_events_notify AFTER INSERT ON app.outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.outbox_notify();

-- migrate:down
DROP TABLE app.processed_events;
DROP TABLE app.outbox_events;
DROP FUNCTION app.outbox_notify();
