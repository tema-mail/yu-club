-- 0303_staff_shifts: смены, ставки, расчётные периоды (K18 §13, model-dannyh 0303, шаг S3-10).
--   staff: даты работы, «временно не работает» (не статус входа, K18 §2), комментарий руководителя.
--   journal.staff_rates – история ставок, только вставка: исправление – новая запись с той же valid_from и ссылкой corrects.
--   app.payroll_periods – на сеть, не пересекаются; закрытие – строкой FOR UPDATE, запись – FOR SHARE (K18 §6).
--   app.staff_shifts – EXCLUDE: нет пересечения смен сотрудника в любом филиале, стык [) – не конфликт (TC-15).
--   journal.staff_shift_changes + app.staff_shift_change_acks – чужая правка и «ознакомлен» (K18 §4).
--   DELETE у yu_app отозван везде: удалений нет, отмена = статус.

-- migrate:up
ALTER TABLE app.staff
  ADD COLUMN employment_start date,
  ADD COLUMN employment_end   date,
  ADD COLUMN planning_status  text NOT NULL DEFAULT 'available' CHECK (planning_status IN ('available','on_leave')),
  ADD COLUMN manager_comment  text;

CREATE TABLE journal.staff_rates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id           uuid NOT NULL REFERENCES app.staff(id),
  valid_from         date NOT NULL,
  hourly_kop         bigint NOT NULL CHECK (hourly_kop >= 0),
  attendance_fee_kop bigint NOT NULL CHECK (attendance_fee_kop >= 0),
  corrects           uuid REFERENCES journal.staff_rates(id),
  reason             text NOT NULL CHECK (btrim(reason) <> ''),
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_rates_lookup_idx ON journal.staff_rates (staff_id, valid_from DESC, created_at DESC);

CREATE TABLE app.payroll_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date_from  date NOT NULL,
  date_to    date NOT NULL CHECK (date_to >= date_from),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at  timestamptz,
  closed_by  uuid,
  CONSTRAINT payroll_periods_no_overlap EXCLUDE USING gist (daterange(date_from, date_to, '[]') WITH &&),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE app.staff_shifts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id            uuid NOT NULL REFERENCES app.staff(id),
  branch_id           uuid NOT NULL REFERENCES app.branches(id),
  local_date          date NOT NULL,
  period              tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  status              text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','worked','no_show','cancelled','needs_review')),
  fact_start          timestamptz,
  fact_end            timestamptz,
  paid_minutes        int CHECK (paid_minutes >= 0),
  paid_minutes_source text CHECK (paid_minutes_source IN ('fact_time','manual')),
  fact_version        int NOT NULL DEFAULT 0,
  outside_hours       boolean NOT NULL DEFAULT false,
  unpaid_confirmed    boolean NOT NULL DEFAULT false,
  review_reason       text,
  comment             text,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  row_version         int NOT NULL DEFAULT 1,
  CONSTRAINT staff_shifts_no_overlap EXCLUDE USING gist (staff_id WITH =, period WITH &&) WHERE (status IN ('planned','worked','needs_review')),
  CHECK (status <> 'worked' OR paid_minutes IS NOT NULL)
);
CREATE INDEX staff_shifts_branch_date_idx ON app.staff_shifts (branch_id, local_date);
CREATE INDEX staff_shifts_staff_date_idx ON app.staff_shifts (staff_id, local_date);
CREATE INDEX staff_shifts_review_idx ON app.staff_shifts (local_date) WHERE status = 'planned';
REVOKE DELETE, TRUNCATE ON app.staff_shifts, app.payroll_periods FROM yu_app;

CREATE TABLE journal.staff_shift_changes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id   uuid NOT NULL REFERENCES app.staff_shifts(id),
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('created','updated','cancelled')),
  before     jsonb,
  after      jsonb,
  reason     text
);
CREATE INDEX staff_shift_changes_shift_idx ON journal.staff_shift_changes (shift_id);

CREATE TABLE app.staff_shift_change_acks (
  change_id       bigint PRIMARY KEY REFERENCES journal.staff_shift_changes(id),
  acknowledged_at timestamptz NOT NULL
);
REVOKE DELETE, TRUNCATE ON app.staff_shift_change_acks FROM yu_app;

-- migrate:down
DROP TABLE app.staff_shift_change_acks;
DROP TABLE journal.staff_shift_changes;
DROP TABLE app.staff_shifts;
DROP TABLE app.payroll_periods;
DROP TABLE journal.staff_rates;
ALTER TABLE app.staff DROP COLUMN employment_start, DROP COLUMN employment_end, DROP COLUMN planning_status, DROP COLUMN manager_comment;
