-- 0008_network: города, филиалы, регулярный график (K13, model-dannyh §0008, 02 §5–6, 15 §5–6).
-- Модуль-владелец – network. Другие модули читают эти таблицы только через modules/network/index.ts.
-- Удаления нет: город и филиал уходят в архив (02 §12) – у yu_app отозван DELETE.
-- Смена графика – закрыть строку (valid_to) и вставить новую: прошлое не переписывается.
-- Зона (IANA) проверяется в приложении (ADR 0003 п.2, isValidTimeZone); моменты – timestamptz,
-- поэтому смена зоны филиала не сдвигает прошлые события (ADR 0003 п.8).
-- FK staff_assignments/ledger → cities/branches из model-dannyh §0008 – отдельным шагом (тесты ядра
-- вставляют назначения на несуществующие филиалы, их правка – вне лимита этого шага).

-- migrate:up
CREATE TABLE app.cities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  region      text,
  timezone    text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE app.branches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id            uuid NOT NULL REFERENCES app.cities(id),
  code               text NOT NULL UNIQUE,
  slug               text NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  name               text NOT NULL CHECK (btrim(name) <> ''),
  address            text NOT NULL,
  timezone           text NOT NULL,
  status             text NOT NULL DEFAULT 'preparing'
                     CHECK (status IN ('preparing','active','temporarily_closed','archived')),
  temp_closed_from   timestamptz,
  temp_closed_to     timestamptz,
  temp_close_reason  text,
  phone_public       text,
  public_contacts    jsonb NOT NULL DEFAULT '{}',
  description        text,
  directions         text,
  internal_comment   text,
  opened_on          date,
  closed_on          date,
  sort_order         int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  row_version        int NOT NULL DEFAULT 1,
  UNIQUE (city_id, slug),
  CHECK (status <> 'temporarily_closed' OR (temp_closed_from IS NOT NULL AND temp_close_reason IS NOT NULL)),
  CHECK (temp_closed_to IS NULL OR temp_closed_from IS NULL OR temp_closed_to > temp_closed_from),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX branches_city_idx ON app.branches (city_id);

CREATE TABLE app.branch_weekly_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES app.branches(id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = Пн
  open_time   time,                                                -- NULL + is_closed = выходной
  close_time  time,
  is_closed   boolean NOT NULL DEFAULT false,
  valid_from  date NOT NULL,                                       -- локальная дата филиала
  valid_to    date,                                                -- включительно; NULL = бессрочно
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (is_closed OR (open_time IS NOT NULL AND close_time IS NOT NULL AND close_time > open_time)),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT branch_weekly_hours_no_overlap
    EXCLUDE USING gist (branch_id WITH =, weekday WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);

REVOKE DELETE ON app.cities, app.branches, app.branch_weekly_hours FROM yu_app;

-- migrate:down
DROP TABLE app.branch_weekly_hours;
DROP TABLE app.branches;
DROP TABLE app.cities;
