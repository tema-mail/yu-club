-- 0408_report_exports: задачи экспорта отчётов и расширение проверок журнала сверки (K24 §7, §12, §13; шаг S4-71, план 6.6).
-- app.report_exports – своя таблица модуля reports: строка не удаляется (срок вышел – status 'expired', файл стёрт уборкой).
-- Строка и есть очередь: API кладёт queued в своей транзакции вместе с аудитом, worker забирает (S4-72).
-- Повтор того же запроса, пока прежняя задача queued/running/ready, – та же задача: частичный UNIQUE (staff_id, params_hash).
-- journal.reconcile_discrepancies: check_name и object_type – DROP + ADD с полным списком на момент применения.
-- Список берётся из действующего CHECK, а не перечисляется: 0311 (Э3) пишется параллельно и своих значений здесь не знает,
-- на чистой базе 0311 применяется раньше, и её значения остаются (K24 §12, С4.1). Добавляются:
-- utilization_over_capacity и occupancy_unit – расхождение загрузки ссылается на единицу занятости (S4-136, решение S4-00).

-- migrate:up
CREATE TABLE app.report_exports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES app.staff(id),
  report        text NOT NULL CHECK (report IN ('dashboard','bookings','utilization','finance','events','clients','loyalty','certificates','staff','equipment','comms')),
  format        text NOT NULL CHECK (format IN ('xlsx','csv')),
  params        jsonb NOT NULL,
  params_hash   text NOT NULL,                  -- SHA-256 нормализованных параметров + staff_id + format
  detail        boolean NOT NULL,
  masked        boolean NOT NULL,               -- телефоны в файле маской (нет export.pd у постановщика)
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','expired','failed','cancelled')),
  error_code    text,
  rows          int,
  bytes         bigint,
  file_key      text,                           -- случайный UUID внутри EXPORT_DIR
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz,
  downloaded_at timestamptz,
  CHECK (status <> 'ready' OR (file_key IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE UNIQUE INDEX report_exports_same_request ON app.report_exports (staff_id, params_hash) WHERE status IN ('queued','running','ready');
CREATE INDEX report_exports_staff_idx ON app.report_exports (staff_id, created_at DESC, id DESC);
CREATE INDEX report_exports_queue_idx ON app.report_exports (created_at) WHERE status IN ('queued','running');
CREATE INDEX report_exports_expiry_idx ON app.report_exports (expires_at) WHERE status = 'ready';
REVOKE DELETE, TRUNCATE ON app.report_exports FROM yu_app;

DO $$
DECLARE
  item record;
  con text;
  cur text[];
BEGIN
  FOR item IN SELECT * FROM (VALUES ('check_name', 'utilization_over_capacity'), ('object_type', 'occupancy_unit')) AS v(col, val) LOOP
    con := 'reconcile_discrepancies_' || item.col || '_check';
    SELECT array_agg(m[1]) INTO cur
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') AS m
    WHERE c.conrelid = 'journal.reconcile_discrepancies'::regclass AND c.conname = con;
    IF cur IS NULL THEN
      RAISE EXCEPTION '0408: нет проверки %', con;
    END IF;
    EXECUTE format('ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK (%I IN (%s))', con, con, item.col,
      (SELECT string_agg(DISTINCT quote_literal(x), ',') FROM unnest(cur || item.val) AS x));
  END LOOP;
END $$;

-- migrate:down
DO $$
DECLARE
  item record;
  con text;
  cur text[];
BEGIN
  FOR item IN SELECT * FROM (VALUES ('check_name', 'utilization_over_capacity'), ('object_type', 'occupancy_unit')) AS v(col, val) LOOP
    con := 'reconcile_discrepancies_' || item.col || '_check';
    SELECT array_agg(m[1]) INTO cur
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') AS m
    WHERE c.conrelid = 'journal.reconcile_discrepancies'::regclass AND c.conname = con;
    EXECUTE format('ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK (%I IN (%s))', con, con, item.col,
      (SELECT string_agg(DISTINCT quote_literal(x), ',') FROM unnest(array_remove(cur, item.val)) AS x));
  END LOOP;
END $$;
DROP TABLE app.report_exports;
