-- 0103_calendar: исключения календаря (K13, model-dannyh §0103, 15 §6.2–6.3, 01 §4.1 п.3).
-- Модуль-владелец – network. Другие модули читают исключения только через modules/network/index.ts.
-- Приоритет на дату: ресурс → комната → филиал → branch_weekly_hours (15 §6.3).
-- Одно активное исключение на объект и дату – EXCLUDE: противоречие ловится до сохранения (SCHEDULE_CONFLICT).
-- Удаления нет: исключение отменяется (status = 'cancelled'), история остаётся.
--
-- FK room_id → app.rooms, resource_id → app.resources (model-dannyh §0103) здесь НЕ объявлены: таблицы
-- 0101 делаются параллельным потоком (S1-01). Принадлежность комнаты/ресурса филиалу проверяет код
-- (modules/network/calendar.ts, CalendarTargets). После слияния с 0101 – дописать в этот файл, пока он
-- нигде не применён:
--   room_id     uuid REFERENCES app.rooms(id),
--   resource_id uuid REFERENCES app.resources(id),

-- migrate:up
CREATE TABLE app.calendar_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES app.branches(id),
  scope_type  text NOT NULL CHECK (scope_type IN ('branch','room','resource')),
  room_id     uuid,
  resource_id uuid,
  local_date  date NOT NULL,                                       -- дата филиала
  kind        text NOT NULL CHECK (kind IN ('closed','short_day','special_hours','holiday','technical')),
  open_time   time,                                                -- для short_day / special_hours
  close_time  time,
  reason      text NOT NULL CHECK (btrim(reason) <> ''),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  cancelled_by uuid,
  cancelled_at timestamptz,
  CHECK ((scope_type = 'branch' AND room_id IS NULL AND resource_id IS NULL) OR
         (scope_type = 'room' AND room_id IS NOT NULL AND resource_id IS NULL) OR
         (scope_type = 'resource' AND resource_id IS NOT NULL AND room_id IS NULL)),
  CHECK (CASE WHEN kind IN ('closed','holiday','technical') THEN open_time IS NULL AND close_time IS NULL
              ELSE open_time IS NOT NULL AND close_time IS NOT NULL AND close_time > open_time END),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT calendar_exceptions_one_per_day EXCLUDE USING gist (
    branch_id WITH =, scope_type WITH =,
    (coalesce(room_id, resource_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    local_date WITH =) WHERE (status = 'active')
);
CREATE INDEX calendar_exceptions_branch_date_idx ON app.calendar_exceptions (branch_id, local_date) WHERE status = 'active';

REVOKE DELETE ON app.calendar_exceptions FROM yu_app;

-- migrate:down
DROP TABLE app.calendar_exceptions;
