-- 0101_resources: помещения, комнаты, ресурсы бронирования (model-dannyh §0101, K13, 02 §3.3, §7–8, 15 §7–8).
-- Модуль-владелец – resources. Другие модули читают эти таблицы только через modules/resources/index.ts.
-- Число ПК/VR – данные, не код (01 §5.1): строки resources, а не перечисления в приложении.
-- Удаления нет: архив (02 §12) – у yu_app отозван DELETE.
-- Сверх нормативного DDL (решение): составные FK (room_id, branch_id) и (space_id, branch_id) – комната и ресурс
-- не могут сослаться на объект другого филиала даже ошибкой кода.

-- migrate:up
CREATE TABLE app.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  space_type text NOT NULL REFERENCES app.dict_space_types(code),
  name text NOT NULL, description text, internal_comment text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable','repair','closed','archived')),
  sort_order int NOT NULL DEFAULT 0, archived_at timestamptz, row_version int NOT NULL DEFAULT 1,
  UNIQUE (id, branch_id),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE app.rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  space_id uuid,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  name text NOT NULL, capacity smallint CHECK (capacity > 0),
  public_description text, internal_description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable','repair','closed','archived')),
  is_published boolean NOT NULL DEFAULT false,
  whole_rent_allowed boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0, archived_at timestamptz, row_version int NOT NULL DEFAULT 1,
  UNIQUE (branch_id, slug),
  UNIQUE (id, branch_id),
  FOREIGN KEY (space_id, branch_id) REFERENCES app.spaces(id, branch_id),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE app.resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  room_id uuid,
  resource_type text NOT NULL REFERENCES app.dict_resource_types(code),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable','archived')),
  self_bookable boolean NOT NULL DEFAULT true,
  step_minutes_override smallint CHECK (step_minutes_override IS NULL OR (step_minutes_override > 0 AND 1440 % step_minutes_override = 0)),
  sort_order int NOT NULL DEFAULT 0, internal_comment text,
  archived_at timestamptz, row_version int NOT NULL DEFAULT 1,
  UNIQUE (id, branch_id),
  FOREIGN KEY (room_id, branch_id) REFERENCES app.rooms(id, branch_id),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX resources_branch_idx ON app.resources (branch_id, sort_order, name);
CREATE INDEX rooms_branch_idx ON app.rooms (branch_id, sort_order, name);
CREATE INDEX spaces_branch_idx ON app.spaces (branch_id, sort_order, name);

REVOKE DELETE, TRUNCATE ON app.spaces, app.rooms, app.resources FROM yu_app;

-- migrate:down
DROP TABLE app.resources;
DROP TABLE app.rooms;
DROP TABLE app.spaces;
