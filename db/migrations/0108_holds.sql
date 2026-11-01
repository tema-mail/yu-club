-- 0108_holds: предварительные удержания и время клиента (model-dannyh §0108, K5 №6–11, K6, 01 §7, §9).
-- Модуль-владелец – booking. Удержание – общий таймер на все позиции (01 §7.2); строки occupancy позиций несут копию
-- holds.expires_at (hold_expires_at), продление обновляет всё в одной транзакции.
-- client_time – одна строка на позицию удержания / бронь: запрет пересечений клиента по сети (client_time_no_overlap).
-- Сверх нормативного DDL (решение): CHECK интервала '[)' у hold_items и client_time; release_reason у client_time
-- (как у occupancy – видно, почему погашено); закрытое удержание обязано иметь closed_at.
-- Удаления нет: позиции и удержания закрываются статусом – у yu_app отозван DELETE.

-- migrate:up
CREATE TABLE app.holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid REFERENCES app.clients(id),
  visitor_id uuid,
  created_by_type text NOT NULL CHECK (created_by_type IN ('client','visitor','staff')),
  created_by_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','expired','released')),
  ttl_minutes smallint NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (client_id IS NOT NULL OR visitor_id IS NOT NULL),
  CHECK ((status = 'active') = (closed_at IS NULL))
);
CREATE INDEX holds_active_expiry_idx ON app.holds (expires_at) WHERE status = 'active';
CREATE INDEX holds_owner_idx ON app.holds (branch_id, client_id, visitor_id) WHERE status = 'active';

CREATE TABLE app.hold_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id uuid NOT NULL REFERENCES app.holds(id),
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  period tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                   AND NOT lower_inf(period) AND NOT upper_inf(period)),
  unit_ids uuid[] NOT NULL CHECK (cardinality(unit_ids) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','converted','expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hold_items_hold_idx ON app.hold_items (hold_id);

CREATE TABLE app.client_time (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  period tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                   AND NOT lower_inf(period) AND NOT upper_inf(period)),
  source_type text NOT NULL CHECK (source_type IN ('hold_item','booking')),
  source_id uuid NOT NULL,
  hold_expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  released_at timestamptz,
  release_reason text CHECK (release_reason IN ('expired','released','converted','cancelled','rescheduled')),
  CHECK ((source_type = 'hold_item') = (hold_expires_at IS NOT NULL)),
  CHECK (active OR released_at IS NOT NULL),
  CONSTRAINT client_time_no_overlap
    EXCLUDE USING gist (client_id WITH =, period WITH &&) WHERE (active)
);
CREATE INDEX client_time_source_idx ON app.client_time (source_type, source_id) WHERE active;

REVOKE DELETE, TRUNCATE ON app.holds, app.hold_items, app.client_time FROM yu_app;

-- migrate:down
DROP TABLE app.client_time;
DROP TABLE app.hold_items;
DROP TABLE app.holds;
