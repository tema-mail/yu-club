-- 0305_events: мероприятия и платный праздник (K20 §14, model-dannyh 0305, шаг S3-50).
--   app.event_types / app.event_packages – справочники (посев типов 11 §3.1; пакеты могут быть пусты, 11 §17 п.2).
--   app.events          – мероприятие: создаётся без брони и без профиля; телефон заказчика – контакт, не клиент ЛК (K20 §2).
--   app.event_lines     – состав: удаление статусом с причиной, скидка – с причиной (11 §5.2).
--   app.event_checklist – 10 пунктов 11 §6; пункт не удаляется, только «не нужно».
--   app.event_resources – занятие ресурса: источник строк occupancy (K6 source_type='event', source_id = event_resources.id).
--   app.event_bookings  – ссылки на обычные брони; мероприятие ими не управляет (K20 §1 п.3).
-- reserved_at и request_hold_reminded_at – срок удержания комнаты под new_request (K20 §4, ревью 04.11).
-- Удаления нет: архив и статусы. FK finance_operation_links.line_id → event_lines – здесь (D3-03: 0301 смотрит только назад).

-- migrate:up
CREATE SEQUENCE app.event_number_seq;
CREATE SEQUENCE app.gift_number_seq;

CREATE TABLE app.event_types (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code   text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name   text NOT NULL CHECK (btrim(name) <> ''),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version int NOT NULL DEFAULT 1
);
INSERT INTO app.event_types (code, name) VALUES
  ('birthday_party', 'Платный праздник'),
  ('birthday', 'День рождения без аренды комнаты'),
  ('group_visit', 'Групповое посещение'),
  ('program', 'Программа'),
  ('other', 'Другое');

CREATE TABLE app.event_packages (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id uuid NOT NULL REFERENCES app.event_types(id),
  name    text NOT NULL CHECK (btrim(name) <> ''),
  lines   jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  approx_price_kop bigint CHECK (approx_price_kop >= 0),
  status  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version int NOT NULL DEFAULT 1
);

CREATE TABLE app.events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  type_id       uuid NOT NULL REFERENCES app.event_types(id),
  branch_id     uuid NOT NULL REFERENCES app.branches(id),
  title         text NOT NULL CHECK (btrim(title) <> ''),
  planned_start timestamptz,
  planned_end   timestamptz,
  status        text NOT NULL DEFAULT 'new_request' CHECK (status IN ('new_request','negotiation','awaiting_confirmation','confirmed','preparing','in_progress','completed','cancelled','not_held')),
  customer_client_id  uuid REFERENCES app.clients(id),
  customer_name       text NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_phone_e164 text NOT NULL CHECK (customer_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  birthday_client_id  uuid REFERENCES app.clients(id),
  birthday_person_name text,
  participants_count int CHECK (participants_count > 0),
  responsible_staff_id uuid REFERENCES app.staff(id),
  wishes        text,
  package_id    uuid REFERENCES app.event_packages(id),
  party_format  text CHECK (party_format IN ('h2','h3plus','full_day')),
  party_guests  int CHECK (party_guests > 0),
  party_catering boolean,
  agreed_snapshot jsonb,
  source        text NOT NULL CHECK (source IN ('crm','site')),
  cancel_reason text,
  cancelled_by  uuid,
  cancelled_at  timestamptz,
  created_by_type text NOT NULL,
  created_by_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  row_version   int NOT NULL DEFAULT 1,
  CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end > planned_start),
  CHECK (status NOT IN ('confirmed','preparing','in_progress','completed') OR (planned_start IS NOT NULL AND planned_end IS NOT NULL)),
  CHECK (status NOT IN ('cancelled','not_held') OR cancel_reason IS NOT NULL)
);
CREATE INDEX events_branch_start_idx ON app.events (branch_id, planned_start);
CREATE INDEX events_status_idx ON app.events (status, created_at);
CREATE INDEX events_customer_idx ON app.events (customer_client_id) WHERE customer_client_id IS NOT NULL;
CREATE INDEX events_birthday_idx ON app.events (birthday_client_id) WHERE birthday_client_id IS NOT NULL;
-- лимит заявок с телефона за сутки (K20 §10) – счёт по телефону и времени
CREATE INDEX events_site_phone_idx ON app.events (customer_phone_e164, created_at) WHERE source = 'site';

CREATE TABLE app.event_lines (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES app.events(id),
  kind      text NOT NULL CHECK (kind IN ('service','goods','room_rent','game_time','animator','catering','decor','activity','other')),
  name      text NOT NULL CHECK (btrim(name) <> ''),
  quantity  numeric(10,2) NOT NULL CHECK (quantity > 0),
  unit      text NOT NULL,
  price_kop bigint NOT NULL CHECK (price_kop >= 0),
  discount_kop bigint NOT NULL DEFAULT 0 CHECK (discount_kop >= 0),
  discount_reason text,
  plan_cost_kop bigint CHECK (plan_cost_kop >= 0),
  supplier  text,
  comment   text,
  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  removed_reason text,
  sort_order int NOT NULL DEFAULT 0,
  row_version int NOT NULL DEFAULT 1,
  CHECK (discount_kop = 0 OR discount_reason IS NOT NULL),
  CHECK (status = 'active' OR removed_reason IS NOT NULL)
);
CREATE INDEX event_lines_event_idx ON app.event_lines (event_id, sort_order);
ALTER TABLE app.finance_operation_links ADD CONSTRAINT finance_operation_links_line_fk FOREIGN KEY (line_id) REFERENCES app.event_lines(id);

CREATE TABLE app.event_checklist (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES app.events(id),
  code     text,
  title    text NOT NULL CHECK (btrim(title) <> ''),
  status   text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done','not_needed')),
  responsible_staff_id uuid REFERENCES app.staff(id),
  comment  text,
  sort_order int NOT NULL DEFAULT 0,
  updated_by uuid,
  updated_at timestamptz
);
CREATE INDEX event_checklist_event_idx ON app.event_checklist (event_id, sort_order);

CREATE TABLE app.event_resources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES app.events(id),
  branch_id   uuid NOT NULL REFERENCES app.branches(id),
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  period      tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  unit_ids    uuid[] NOT NULL CHECK (cardinality(unit_ids) > 0),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  reserved_at timestamptz NOT NULL,
  request_hold_reminded_at timestamptz,
  released_at timestamptz,
  release_reason text,
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);
CREATE INDEX event_resources_event_idx ON app.event_resources (event_id);
CREATE INDEX event_resources_active_idx ON app.event_resources (reserved_at) WHERE status = 'active';

CREATE TABLE app.event_bookings (
  event_id   uuid NOT NULL REFERENCES app.events(id),
  booking_id uuid NOT NULL UNIQUE REFERENCES app.bookings(id),
  linked_by  uuid NOT NULL,
  linked_at  timestamptz NOT NULL,
  PRIMARY KEY (event_id, booking_id)
);

REVOKE DELETE, TRUNCATE ON app.event_types, app.event_packages, app.events, app.event_lines, app.event_checklist, app.event_resources FROM yu_app;
-- снятие связи брони (K20 №366) – единственное удаление строки: это ссылка, а не факт; след – аудит event.booking_unlinked
REVOKE UPDATE, TRUNCATE ON app.event_bookings FROM yu_app;

-- migrate:down
DROP TABLE app.event_bookings;
DROP TABLE app.event_resources;
DROP TABLE app.event_checklist;
ALTER TABLE app.finance_operation_links DROP CONSTRAINT finance_operation_links_line_fk;
DROP TABLE app.event_lines;
DROP TABLE app.events;
DROP TABLE app.event_packages;
DROP TABLE app.event_types;
DROP SEQUENCE app.gift_number_seq;
DROP SEQUENCE app.event_number_seq;
