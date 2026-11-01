-- 0003_audit: журнал аудита (K2, model-dannyh §0003, 04 §11.2).
-- Схема journal: yu_app только SELECT/INSERT (default privileges из 0001).
-- make_append_only вызываем явно – на случай, если таблицу создал не владелец default privileges.
-- FK нет намеренно (решение): журнал живёт дольше актора и объекта.

-- migrate:up
CREATE TABLE journal.audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL,
  actor_type    text NOT NULL CHECK (actor_type IN ('staff','client','system','anonymous')),
  actor_id      uuid,
  actor_role    text CHECK (actor_role IN ('owner','director','admin')),
  actor_scope   jsonb,
  action        text NOT NULL,
  object_type   text NOT NULL,
  object_id     text,
  branch_id     uuid,
  city_id       uuid,
  before        jsonb,
  after         jsonb,
  result        text NOT NULL CHECK (result IN ('success','denied','error')),
  reason        text,
  source        text NOT NULL CHECK (source IN ('crm','site','account','system','cli')),
  request_id    text,
  ip            inet,
  CHECK ((actor_type IN ('staff','client')) = (actor_id IS NOT NULL))
);
CREATE INDEX audit_object_idx ON journal.audit_events (object_type, object_id, occurred_at);
CREATE INDEX audit_branch_time_idx ON journal.audit_events (branch_id, occurred_at);
CREATE INDEX audit_actor_idx ON journal.audit_events (actor_type, actor_id, occurred_at);

SELECT journal.make_append_only('journal.audit_events');

-- migrate:down
DROP TABLE journal.audit_events;
