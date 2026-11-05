-- 0307_repairs: ремонт (K19 §6–§9, §13, model-dannyh 0307, шаг S3-34).
--   repair_executors – справочник исполнителей, архив вместо удаления; в ремонт кладётся снимок реквизитов (10 §8.3).
--   repairs – ремонтное событие: три даты (поломка, обнаружение, регистрация), план отдельно от факта, снимок места.
--   У yu_app нет UPDATE первоначального описания, места и дат регистрации: описание не перезаписывается (10 §7.2).
--   journal.repair_status_history – только вставка: каждый переход с автором и комментарием.
--   repair_blocks – связь с блокировками K6; block_id UNIQUE: блокировка принадлежит одному ремонту.
--   equipment_warranties – гарантии производителя и на работы; ошибочная помечается invalid, не удаляется.

-- migrate:up
CREATE TABLE app.repair_executors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('staff','contractor','service_center','manufacturer')),
  name           text NOT NULL CHECK (btrim(name) <> ''),
  staff_id       uuid REFERENCES app.staff(id),
  contact_person text,
  phone          text,
  email          text,
  address        text,
  inn            text,
  comment        text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version    int NOT NULL DEFAULT 1
);

CREATE TABLE app.repairs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                    text NOT NULL UNIQUE CHECK (number ~ '^R-[0-9]{6,}$'),
  equipment_id              uuid NOT NULL REFERENCES app.equipment_items(id),
  branch_id                 uuid NOT NULL REFERENCES app.branches(id),
  room_id                   uuid,
  unit_id                   uuid,
  broken_at                 timestamptz,
  broken_at_unknown         boolean NOT NULL DEFAULT false,
  detected_at               timestamptz NOT NULL,
  registered_at             timestamptz NOT NULL,
  reported_by_staff_id      uuid,
  reported_by_name          text,
  symptoms                  text NOT NULL CHECK (btrim(symptoms) <> ''),
  priority                  text NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  impact                    text NOT NULL CHECK (impact IN ('none','partial','full')),
  status                    text NOT NULL DEFAULT 'new' CHECK (status IN ('new','diagnostics','awaiting_approval','planned','in_repair','awaiting_parts','done_pending_check','closed','cancelled')),
  diagnostics               text,
  cause                     text,
  works_done                text,
  parts_used                text,
  conclusion                text,
  plan_works                text,
  plan_start                date,
  plan_end                  date,
  plan_cost_kop             bigint CHECK (plan_cost_kop >= 0),
  plan_responsible_staff_id uuid,
  plan_parts_needed         boolean NOT NULL DEFAULT false,
  plan_comment              text,
  executor_id               uuid REFERENCES app.repair_executors(id),
  executor_snapshot         jsonb,
  approval_required         boolean NOT NULL DEFAULT false,
  approved_by               uuid,
  approved_at               timestamptz,
  actual_cost_kop           bigint CHECK (actual_cost_kop >= 0),
  no_cost                   boolean NOT NULL DEFAULT false,
  cost_comment              text,
  completed_at              timestamptz,
  final_equipment_status    text CHECK (final_equipment_status IN ('in_service','reserve','diagnostics','repair','awaiting_parts','unavailable','written_off','lost')),
  accepted_by               uuid,
  previous_repair_id        uuid REFERENCES app.repairs(id),
  created_by                uuid NOT NULL,
  row_version               int NOT NULL DEFAULT 1,
  FOREIGN KEY (room_id, branch_id) REFERENCES app.rooms(id, branch_id),
  FOREIGN KEY (unit_id, branch_id) REFERENCES app.occupancy_units(id, branch_id),
  CHECK (broken_at IS NOT NULL OR broken_at_unknown),
  CHECK (NOT (broken_at IS NOT NULL AND broken_at_unknown)),
  CHECK (broken_at IS NULL OR broken_at <= detected_at),
  CHECK (detected_at <= registered_at),
  CHECK (NOT (no_cost AND actual_cost_kop IS NOT NULL)),
  CHECK (plan_end IS NULL OR plan_start IS NULL OR plan_end >= plan_start),
  CHECK (status <> 'closed' OR (completed_at IS NOT NULL AND final_equipment_status IS NOT NULL AND (no_cost OR actual_cost_kop IS NOT NULL)))
);
CREATE INDEX repairs_branch_idx ON app.repairs (branch_id, number);
CREATE INDEX repairs_equipment_idx ON app.repairs (equipment_id, detected_at);
CREATE INDEX repairs_open_idx ON app.repairs (branch_id, status) WHERE status NOT IN ('closed','cancelled');
REVOKE UPDATE ON app.repairs FROM yu_app;
GRANT UPDATE (priority, status, diagnostics, cause, works_done, parts_used, conclusion, plan_works, plan_start, plan_end, plan_cost_kop,
              plan_responsible_staff_id, plan_parts_needed, plan_comment, executor_id, executor_snapshot, approval_required, approved_by, approved_at,
              actual_cost_kop, no_cost, cost_comment, completed_at, final_equipment_status, accepted_by, previous_repair_id, row_version) ON app.repairs TO yu_app;

CREATE TABLE journal.repair_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repair_id   uuid NOT NULL REFERENCES app.repairs(id),
  from_status text,
  to_status   text NOT NULL,
  at          timestamptz NOT NULL,
  by_staff_id uuid NOT NULL,
  comment     text NOT NULL CHECK (btrim(comment) <> '')
);
CREATE INDEX repair_status_history_repair_idx ON journal.repair_status_history (repair_id, id);
SELECT journal.make_append_only('journal.repair_status_history');

CREATE TABLE app.repair_blocks (
  repair_id uuid NOT NULL REFERENCES app.repairs(id),
  block_id  uuid NOT NULL UNIQUE REFERENCES app.resource_blocks(id),
  linked_at timestamptz NOT NULL,
  linked_by uuid NOT NULL,
  PRIMARY KEY (repair_id, block_id)
);
REVOKE UPDATE ON app.repair_blocks FROM yu_app;

CREATE TABLE app.equipment_warranties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('manufacturer','repair')),
  equipment_id  uuid NOT NULL REFERENCES app.equipment_items(id),
  repair_id     uuid REFERENCES app.repairs(id),
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  terms         text,
  issuer        text,
  attachment_id uuid REFERENCES app.attachments(id),
  comment       text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
  CHECK (ends_on >= starts_on),
  CHECK ((kind = 'repair') = (repair_id IS NOT NULL))
);
CREATE INDEX equipment_warranties_equipment_idx ON app.equipment_warranties (equipment_id, ends_on) WHERE status = 'active';
REVOKE UPDATE ON app.equipment_warranties FROM yu_app;
GRANT UPDATE (status) ON app.equipment_warranties TO yu_app;

REVOKE DELETE, TRUNCATE ON app.repair_executors, app.repairs, app.repair_blocks, app.equipment_warranties FROM yu_app;

-- migrate:down
DROP TABLE app.equipment_warranties;
DROP TABLE app.repair_blocks;
DROP TABLE journal.repair_status_history;
DROP TABLE app.repairs;
DROP TABLE app.repair_executors;
