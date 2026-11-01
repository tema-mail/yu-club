-- 0109_bookings: брони и их версии (model-dannyh §0109, K5 №12, K6, 01 §10–12, Q-07).
-- Модуль-владелец – booking. bookings – текущее состояние (денормализация текущей версии для списков и календаря);
-- journal.booking_versions – только вставка: снимок зоны, состава (unit_ids), ресурса и цены на момент версии –
-- перенос и смена состава/тарифа не меняют созданные брони (01 §11, 02 §8.4, 15 §9.4).
-- Сверх нормативного DDL (решение): CHECK интервала '[)'; current_version ≥ 1; price_kop ≥ 0 в bookings.
-- Удаления нет: отмена – статус (у yu_app отозван DELETE).

-- migrate:up
CREATE SEQUENCE app.booking_number_seq;
CREATE TABLE app.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint NOT NULL UNIQUE DEFAULT nextval('app.booking_number_seq'),
  checkout_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  hold_id uuid REFERENCES app.holds(id),
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','arrived','completed','no_show','cancelled_by_client','cancelled_by_club')),
  current_version int NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  period tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                   AND NOT lower_inf(period) AND NOT upper_inf(period)),
  price_kop bigint NOT NULL CHECK (price_kop >= 0),
  source text NOT NULL CHECK (source IN ('site','crm')),
  internal_comment text,
  created_by_type text NOT NULL, created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz, cancelled_by_type text, cancelled_by_id uuid,
  cancel_reason_id uuid REFERENCES app.dict_reasons(id), cancel_comment text,
  row_version int NOT NULL DEFAULT 1,
  CHECK (status NOT IN ('cancelled_by_club') OR cancel_comment IS NOT NULL),
  CHECK (status NOT LIKE 'cancelled%' OR cancelled_at IS NOT NULL)
);
CREATE INDEX bookings_branch_period_idx ON app.bookings USING gist (branch_id, period);
CREATE INDEX bookings_client_idx ON app.bookings (client_id, created_at);
CREATE INDEX bookings_checkout_idx ON app.bookings (checkout_id);
CREATE INDEX bookings_hold_idx ON app.bookings (hold_id) WHERE hold_id IS NOT NULL;
CREATE INDEX bookings_resource_idx ON app.bookings (resource_id, upper(period)) WHERE status IN ('confirmed','arrived');

CREATE TABLE journal.booking_versions (
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  version int NOT NULL,
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  period tstzrange NOT NULL,
  branch_timezone text NOT NULL,
  unit_ids uuid[] NOT NULL CHECK (cardinality(unit_ids) > 0),
  resource_snapshot jsonb NOT NULL,
  tariff_id uuid REFERENCES app.tariffs(id),
  price_kop bigint NOT NULL CHECK (price_kop >= 0),
  price_snapshot jsonb NOT NULL,
  reason text,
  created_by_type text NOT NULL, created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, version)
);
SELECT journal.make_append_only('journal.booking_versions');

REVOKE DELETE, TRUNCATE ON app.bookings FROM yu_app;

-- migrate:down
DROP TABLE journal.booking_versions;
DROP TABLE app.bookings;
DROP SEQUENCE app.booking_number_seq;
