-- 0304_equipment: реестр оборудования (K19 §3–§5, §13, model-dannyh 0304, шаг S3-30).
--   equipment_categories – справочник Владельца, архив вместо удаления; посев – предложение 10 §3.2 (утверждение – вопрос заказчику).
--   equipment_items – карточка; статус НЕ управляет доступностью ресурса (K19 §1): ресурс закрывает только блокировка K6.
--   equipment_placements – история мест; текущее – removed_at IS NULL, одно на единицу оборудования. Составные FK не дают
--   поставить оборудование в комнату или единицу чужого филиала. У yu_app меняется только removed_at.
--   equipment_accounts – учётки PS/VR: идентификатор и «где взять доступ»; поля для пароля или кода нет (10 §5.3, Q-53).
--   Последовательность repair_number_seq использует 0307: номера ремонта живут рядом с инвентарными (K19 §13).

-- migrate:up
CREATE SEQUENCE app.equipment_inventory_seq;
CREATE SEQUENCE app.repair_number_seq;

CREATE TABLE app.equipment_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  sort_order int NOT NULL DEFAULT 0,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'))
);
INSERT INTO app.equipment_categories (name, sort_order) VALUES
  ('Игровые ПК и комплектующие', 10),
  ('Мониторы', 20),
  ('Игровые консоли PlayStation', 30),
  ('VR-шлемы', 40),
  ('Контроллеры и геймпады', 50),
  ('Телевизоры и проекторы', 60),
  ('Сетевое оборудование', 70),
  ('Периферия', 80),
  ('Мебель и оснащение', 90),
  ('Прочее оборудование', 100);

CREATE TABLE app.equipment_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_number  text NOT NULL UNIQUE CHECK (inventory_number ~ '^INV-[0-9]{6,}$'),
  legacy_number     text,
  name              text NOT NULL CHECK (btrim(name) <> ''),
  category_id       uuid NOT NULL REFERENCES app.equipment_categories(id),
  manufacturer      text,
  model             text,
  serial_number     text,
  parent_id         uuid REFERENCES app.equipment_items(id),
  purchase_date     date,
  purchase_cost_kop bigint CHECK (purchase_cost_kop >= 0),
  commissioned_on   date,
  status            text NOT NULL CHECK (status IN ('in_service','reserve','diagnostics','repair','awaiting_parts','unavailable','written_off','lost')),
  status_reason     text,
  branch_id         uuid NOT NULL REFERENCES app.branches(id), -- текущий, дублирует размещение для отбора по зоне
  comment           text,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  row_version       int NOT NULL DEFAULT 1,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX equipment_items_serial_idx ON app.equipment_items (serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX equipment_items_branch_idx ON app.equipment_items (branch_id, inventory_number);
CREATE INDEX equipment_items_parent_idx ON app.equipment_items (parent_id) WHERE parent_id IS NOT NULL;
-- номер не меняется (10 §3.1, Q-51): у yu_app нет UPDATE этой колонки
REVOKE UPDATE ON app.equipment_items FROM yu_app;
GRANT UPDATE (legacy_number, name, category_id, manufacturer, model, serial_number, parent_id, purchase_date, purchase_cost_kop,
              commissioned_on, status, status_reason, branch_id, comment, row_version) ON app.equipment_items TO yu_app;

CREATE TABLE app.equipment_placements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES app.equipment_items(id),
  branch_id  uuid NOT NULL REFERENCES app.branches(id),
  room_id    uuid,
  unit_id    uuid,
  placed_at  timestamptz NOT NULL,
  removed_at timestamptz,
  moved_by   uuid NOT NULL,
  reason     text NOT NULL CHECK (btrim(reason) <> ''),
  FOREIGN KEY (room_id, branch_id) REFERENCES app.rooms(id, branch_id),
  FOREIGN KEY (unit_id, branch_id) REFERENCES app.occupancy_units(id, branch_id),
  CHECK (removed_at IS NULL OR removed_at >= placed_at)
);
CREATE UNIQUE INDEX equipment_placements_current ON app.equipment_placements (item_id) WHERE removed_at IS NULL;
CREATE INDEX equipment_placements_item_idx ON app.equipment_placements (item_id, placed_at);
CREATE INDEX equipment_placements_unit_idx ON app.equipment_placements (unit_id) WHERE removed_at IS NULL AND unit_id IS NOT NULL;
CREATE INDEX equipment_placements_room_idx ON app.equipment_placements (room_id) WHERE removed_at IS NULL AND room_id IS NOT NULL;
REVOKE UPDATE ON app.equipment_placements FROM yu_app;
GRANT UPDATE (removed_at) ON app.equipment_placements TO yu_app;

CREATE TABLE app.equipment_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform     text NOT NULL CHECK (platform IN ('playstation','meta','other')),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  equipment_id uuid REFERENCES app.equipment_items(id),
  branch_id    uuid NOT NULL REFERENCES app.branches(id),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  bound_from   date NOT NULL,
  bound_to     date,
  end_reason   text,
  access_hint  text,
  comment      text,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (bound_to IS NULL OR bound_to >= bound_from),
  CHECK ((status = 'ended') = (bound_to IS NOT NULL)),
  CHECK ((status = 'ended') = (end_reason IS NOT NULL))
);
CREATE INDEX equipment_accounts_equipment_idx ON app.equipment_accounts (equipment_id);
CREATE INDEX equipment_accounts_branch_idx ON app.equipment_accounts (branch_id);
REVOKE UPDATE ON app.equipment_accounts FROM yu_app;
GRANT UPDATE (status, bound_to, end_reason) ON app.equipment_accounts TO yu_app;

REVOKE DELETE, TRUNCATE ON app.equipment_categories, app.equipment_items, app.equipment_placements, app.equipment_accounts FROM yu_app;

-- migrate:down
DROP TABLE app.equipment_accounts;
DROP TABLE app.equipment_placements;
DROP TABLE app.equipment_items;
DROP TABLE app.equipment_categories;
DROP SEQUENCE app.repair_number_seq;
DROP SEQUENCE app.equipment_inventory_seq;
