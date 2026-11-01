-- 0104_blocks: блокировки ресурсов – ремонт, ТО, закрытие (model-dannyh §0104, K6 createBlock, 01 §13).
-- Модуль-владелец – booking. Блокировка НЕ пишется в occupancy и не конфликтует с бронями: ложится поверх и
-- возвращает список затронутых. Новые занятия на заблокированную единицу отвергает assertNotBlocked в транзакции occupy.
-- resource_block_units – единицы, развёрнутые на момент создания (состав ресурса может смениться позже).
-- Сверх нормативного DDL (решение): CHECK интервала '[)' с конечными границами; снятие – lifted_at обязателен.
-- Удаления нет: снятие = status 'lifted' и active=false у единиц – у yu_app отозван DELETE.

-- migrate:up
CREATE TABLE app.resource_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  target_type text NOT NULL CHECK (target_type IN ('unit','resource','room','resources')),
  target_ids uuid[] NOT NULL CHECK (cardinality(target_ids) > 0),
  period tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                   AND NOT lower_inf(period) AND NOT upper_inf(period)),
  reason_id uuid NOT NULL REFERENCES app.dict_reasons(id),
  comment text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz, lifted_by uuid, lift_comment text,
  row_version int NOT NULL DEFAULT 1,
  CHECK ((status = 'lifted') = (lifted_at IS NOT NULL))
);
CREATE INDEX resource_blocks_branch_period_idx ON app.resource_blocks USING gist (branch_id, period) WHERE status = 'active';

CREATE TABLE app.resource_block_units (
  block_id uuid NOT NULL REFERENCES app.resource_blocks(id),
  unit_id uuid NOT NULL REFERENCES app.occupancy_units(id),
  period tstzrange NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (block_id, unit_id)
);
CREATE INDEX resource_block_units_gist ON app.resource_block_units USING gist (unit_id, period) WHERE active;

REVOKE DELETE, TRUNCATE ON app.resource_blocks, app.resource_block_units FROM yu_app;

-- migrate:down
DROP TABLE app.resource_block_units;
DROP TABLE app.resource_blocks;
