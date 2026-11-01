-- 0009_settings: значения настроек с наследованием и датами (K7, model-dannyh §0009, 15 §3, §20).
-- Модуль-владелец – core/settings.ts. Уровень system – значение по умолчанию в коде, не в базе.
-- Строки не удаляются и не переписываются: изменение = закрыть текущую (valid_to) + вставить новую;
-- возврат к наследованию = закрыть локальную, она остаётся в истории. У yu_app: DELETE нет,
-- UPDATE – только столбца valid_to. Пересечение дат на одном уровне одной области – EXCLUDE.

-- migrate:up
CREATE TABLE app.settings_values (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  level       text NOT NULL CHECK (level IN ('network','city','branch')),
  city_id     uuid REFERENCES app.cities(id),
  branch_id   uuid REFERENCES app.branches(id),
  value       jsonb NOT NULL,
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz,
  reason      text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((level = 'network' AND city_id IS NULL AND branch_id IS NULL) OR
         (level = 'city' AND city_id IS NOT NULL AND branch_id IS NULL) OR
         (level = 'branch' AND branch_id IS NOT NULL AND city_id IS NULL)),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT settings_values_no_overlap EXCLUDE USING gist (key WITH =, level WITH =,
    (coalesce(city_id, branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX settings_values_lookup_idx ON app.settings_values (key, level, valid_from);

REVOKE DELETE, UPDATE ON app.settings_values FROM yu_app;
GRANT UPDATE (valid_to) ON app.settings_values TO yu_app;

-- migrate:down
DROP TABLE app.settings_values;
