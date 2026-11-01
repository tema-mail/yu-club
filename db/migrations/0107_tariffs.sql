-- 0107_tariffs: базовый тариф Э1 – филиал × тип ресурса × длительность (K6 §Цена, model-dannyh §0107, 15 §9.1–9.4).
-- Модуль-владелец – pricing. Другие модули считают цену только через modules/pricing/tariff.ts (quote).
-- Цена = ceil(длительность / unit_minutes) × price_per_unit_kop. Нет тарифа → TARIFF_NOT_CONFIGURED, не 0 ₽.
-- Два активных тарифа одного приоритета с пересечением длительностей и периодов – EXCLUDE (15 §20).
-- Цена тарифа неизменна: у yu_app нет UPDATE на цену, единицу и диапазоны – смена цены = новый тариф,
-- а созданная бронь хранит снимок цены (booking_versions.price_snapshot, 15 §9.4). Удаления нет – архив.

-- migrate:up
CREATE TABLE app.tariffs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid NOT NULL REFERENCES app.branches(id),
  resource_type      text NOT NULL REFERENCES app.dict_resource_types(code),
  name               text NOT NULL CHECK (btrim(name) <> ''),
  unit_minutes       smallint NOT NULL CHECK (unit_minutes > 0),
  price_per_unit_kop bigint NOT NULL CHECK (price_per_unit_kop >= 0),
  duration_from_min  smallint NOT NULL DEFAULT 0 CHECK (duration_from_min >= 0),
  duration_to_min    smallint,                                    -- NULL = без верха; диапазон [from, to)
  valid_from         timestamptz NOT NULL,
  valid_to           timestamptz,                                 -- NULL = бессрочно; [from, to)
  priority           smallint NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  CHECK (duration_to_min IS NULL OR duration_to_min > duration_from_min),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT tariffs_same_priority_overlap EXCLUDE USING gist (
    branch_id WITH =, resource_type WITH =, priority WITH =,
    int4range(duration_from_min, duration_to_min, '[)') WITH &&,
    tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (status = 'active')
);
CREATE INDEX tariffs_lookup_idx ON app.tariffs (branch_id, resource_type, valid_from) WHERE status = 'active';

REVOKE UPDATE, DELETE, TRUNCATE ON app.tariffs FROM yu_app;
GRANT UPDATE (name, status, valid_to, archived_at) ON app.tariffs TO yu_app;

-- migrate:down
DROP TABLE app.tariffs;
