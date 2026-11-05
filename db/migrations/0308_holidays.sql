-- 0308_holidays: праздничный календарь сети и городов (K20 §9, 15 §6.4, R-10, Q-73, шаг S3-56). Модуль-владелец – network.
-- Влияет только на подарок имениннику: график филиала в праздник меняют исключения календаря Э1 (calendar_exceptions).
-- Одна активная строка на дату в своей области – частичный уникальный индекс; отмена – статус, строки не удаляются.

-- migrate:up
CREATE TABLE app.holiday_dates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      text NOT NULL CHECK (scope IN ('network','city')),
  city_id    uuid REFERENCES app.cities(id),
  local_date date NOT NULL,
  name       text NOT NULL CHECK (btrim(name) <> ''),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'city') = (city_id IS NOT NULL)),
  CHECK (status = 'active' OR cancel_reason IS NOT NULL)
);
CREATE UNIQUE INDEX holiday_dates_one ON app.holiday_dates (scope, coalesce(city_id, '00000000-0000-0000-0000-000000000000'), local_date) WHERE status = 'active';
CREATE INDEX holiday_dates_date_idx ON app.holiday_dates (local_date) WHERE status = 'active';
REVOKE DELETE, TRUNCATE ON app.holiday_dates FROM yu_app;

-- migrate:down
DROP TABLE app.holiday_dates;
