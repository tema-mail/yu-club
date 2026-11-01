-- 0102_occupancy: единицы занятости, состав ресурсов, строки занятости (model-dannyh §0102, K6, 01 §5.2, §8, 17 §10).
-- Владельцы: resources – occupancy_units и resource_units (состав); booking – occupancy (строки занятости).
-- Ключевое правило: две активные строки одной единицы на пересекающееся время отвергает база (occupancy_no_overlap) –
-- комната целиком {VR1, VR2, PS4} против места VR {VRi} конфликтует без кода приложения.
-- Сверх нормативного DDL (решение): CHECK интервала '[)' с конечными границами (model-dannyh §0 «Время»);
-- составной FK (unit_id, branch_id) – строка занятости не может оказаться в чужом филиале единицы.
-- Удаления нет: состав закрывается valid_to, строки занятости гасятся active=false – у yu_app отозван DELETE.

-- migrate:up
CREATE TABLE app.occupancy_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  room_id uuid,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  UNIQUE (branch_id, code),
  UNIQUE (id, branch_id),
  FOREIGN KEY (room_id, branch_id) REFERENCES app.rooms(id, branch_id)
);

CREATE TABLE app.resource_units (
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  unit_id uuid NOT NULL REFERENCES app.occupancy_units(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  PRIMARY KEY (resource_id, unit_id, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (resource_id WITH =, unit_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&)
);

CREATE TABLE app.occupancy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES app.occupancy_units(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  period tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                   AND NOT lower_inf(period) AND NOT upper_inf(period)),
  source_type text NOT NULL CHECK (source_type IN ('hold_item','booking','event')),
  source_id uuid NOT NULL,
  booking_version int,
  hold_expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  released_at timestamptz,
  release_reason text CHECK (release_reason IN ('expired','released','converted','cancelled','rescheduled')),
  CHECK ((source_type = 'hold_item') = (hold_expires_at IS NOT NULL)),
  CHECK (active OR released_at IS NOT NULL),
  FOREIGN KEY (unit_id, branch_id) REFERENCES app.occupancy_units(id, branch_id),
  CONSTRAINT occupancy_no_overlap
    EXCLUDE USING gist (unit_id WITH =, period WITH &&) WHERE (active)
);
CREATE INDEX occupancy_source_idx ON app.occupancy (source_type, source_id) WHERE active;
CREATE INDEX occupancy_branch_period_idx ON app.occupancy USING gist (branch_id, period) WHERE active;
CREATE INDEX occupancy_hold_expiry_idx ON app.occupancy (hold_expires_at) WHERE active AND source_type = 'hold_item';
CREATE INDEX resource_units_unit_idx ON app.resource_units (unit_id);

REVOKE DELETE, TRUNCATE ON app.occupancy_units, app.resource_units, app.occupancy FROM yu_app;

-- migrate:down
DROP TABLE app.occupancy;
DROP TABLE app.resource_units;
DROP TABLE app.occupancy_units;
