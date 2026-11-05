-- 0310_staff_grants: делегирование прав с датами (K1 «Делегирование», 04 §9, шаг S3-88). Модуль-владелец – core/permissions.
-- Право выдаётся конкретному сотруднику, не роли (по умолчанию, Q-156), в зоне city или branch. Строка не удаляется:
-- отзыв – revoked_at. Список action повторяет DELEGABLE из core/permissions.ts – расхождение ловит тест S3-88.

-- migrate:up
CREATE TABLE app.staff_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES app.staff(id),
  action      text NOT NULL CHECK (action IN ('block.manage','network.hours.manage','finance.income.create','finance.expense.create',
                'equipment.view.accounts','client.merge','shift.manage','payroll.view','network.branch.create')),
  scope_type  text NOT NULL CHECK (scope_type IN ('city','branch')),
  city_id     uuid REFERENCES app.cities(id),
  branch_id   uuid REFERENCES app.branches(id),
  valid_from  date NOT NULL,
  valid_to    date,
  granted_by  uuid NOT NULL REFERENCES app.staff(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES app.staff(id),
  CHECK ((scope_type = 'city' AND city_id IS NOT NULL AND branch_id IS NULL) OR
         (scope_type = 'branch' AND branch_id IS NOT NULL AND city_id IS NULL)),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (staff_id <> granted_by),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  -- второе действующее право на то же действие и зону скрыло бы отзыв первого
  CONSTRAINT staff_grants_no_overlap EXCLUDE USING gist (
    staff_id WITH =, action WITH =,
    (coalesce(city_id, branch_id)) WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&) WHERE (revoked_at IS NULL)
);
CREATE INDEX staff_grants_staff_idx ON app.staff_grants (staff_id) WHERE revoked_at IS NULL;
REVOKE DELETE, TRUNCATE ON app.staff_grants FROM yu_app;

-- migrate:down
DROP TABLE app.staff_grants;
