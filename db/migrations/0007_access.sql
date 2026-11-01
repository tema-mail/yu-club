-- 0007_access: назначения сотрудников на зону (K1, ADR 0005 п.2, model-dannyh §0007).
-- network / city / branch с датами; city открывает все филиалы города, branch – только свой.
-- FK на cities/branches добавит 0008_network (таблиц ещё нет).
-- Изменение срока = отзыв (revoked_at) + новая строка; пересечение действующих назначений – EXCLUDE.

-- migrate:up
CREATE TABLE app.staff_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES app.staff(id),
  scope_type   text NOT NULL CHECK (scope_type IN ('network','city','branch')),
  city_id      uuid,
  branch_id    uuid,
  valid_from   date NOT NULL,
  valid_to     date,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid,
  CHECK (
    (scope_type = 'network' AND city_id IS NULL AND branch_id IS NULL) OR
    (scope_type = 'city'    AND city_id IS NOT NULL AND branch_id IS NULL) OR
    (scope_type = 'branch'  AND branch_id IS NOT NULL AND city_id IS NULL)),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT staff_assignments_no_overlap EXCLUDE USING gist (
    staff_id WITH =, scope_type WITH =,
    (coalesce(city_id, branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&) WHERE (revoked_at IS NULL)
);
CREATE INDEX staff_assignments_staff_idx ON app.staff_assignments (staff_id) WHERE revoked_at IS NULL;

-- migrate:down
DROP TABLE app.staff_assignments;
