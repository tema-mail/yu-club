-- 0418_finance_place_days: дневные суммы движения мест денег для остатка кассы (S4-131; K24 §9 «не уложились – дневные агрегаты»).
-- Владелец – finance (K17). Остаток по-прежнему «Σ движений до t» (K24 §3.4), но история до суток t берётся суммами по суткам,
-- а не перебором всех операций: на синтетике Q-93 (1 млн операций) остаток читал весь журнал на каждый отчёт (≈ 1 с и растёт с журналом).
--   journal.finance_place_days – сутки UTC (date occurred_at в UTC) × филиал × место × вид: Σ движения своего места (in +, out −)
--     и число операций. Вид – как original_kind в rpt_finance_operations (сторно – вид исходной); перевод между местами двигает
--     и второе место: вид 'transfer_in', обратный знак (как counter_place у rpt_finance_operations). Сутки UTC, а не филиала:
--     смена часового пояса филиала не переписывает уже посчитанное, а граница t в середине суток UTC добирается из журнала по индексу.
--   Пишет ТОЛЬКО триггер на вставку операции (SECURITY DEFINER владельца миграций, как баланс счёта в 0004); журнал операций –
--     только вставка (у yu_app нет UPDATE/DELETE), поэтому сумма не расходится с журналом. Существующие операции – одной вставкой.
--   app.rpt_finance_place_days – чтение для отчётов (yu_reports), права – как 0407.

-- migrate:up
CREATE TABLE journal.finance_place_days (
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  day date NOT NULL,
  place text NOT NULL CHECK (place IN ('cash','noncash')),
  kind text NOT NULL,
  delta_kop bigint NOT NULL,
  ops integer NOT NULL,
  PRIMARY KEY (branch_id, day, place, kind)
);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON journal.finance_place_days FROM yu_app;

CREATE FUNCTION journal.finance_place_days_apply() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  k text := NEW.kind;
  d bigint := CASE NEW.direction WHEN 'in' THEN NEW.amount_kop ELSE -NEW.amount_kop END;
  dy date := (NEW.occurred_at AT TIME ZONE 'UTC')::date;
BEGIN
  IF NEW.reversal_of IS NOT NULL THEN
    SELECT o.kind INTO k FROM journal.finance_operations o WHERE o.id = NEW.reversal_of;
  END IF;
  INSERT INTO journal.finance_place_days AS a (branch_id, day, place, kind, delta_kop, ops) VALUES (NEW.branch_id, dy, NEW.place, k, d, 1)
    ON CONFLICT (branch_id, day, place, kind) DO UPDATE SET delta_kop = a.delta_kop + EXCLUDED.delta_kop, ops = a.ops + 1;
  IF k = 'place_transfer' THEN
    INSERT INTO journal.finance_place_days AS a (branch_id, day, place, kind, delta_kop, ops)
    VALUES (NEW.branch_id, dy, CASE NEW.place WHEN 'cash' THEN 'noncash' ELSE 'cash' END, 'transfer_in', -d, 1)
      ON CONFLICT (branch_id, day, place, kind) DO UPDATE SET delta_kop = a.delta_kop + EXCLUDED.delta_kop, ops = a.ops + 1;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION journal.finance_place_days_apply() FROM PUBLIC;

CREATE TRIGGER finance_operations_place_days AFTER INSERT ON journal.finance_operations
  FOR EACH ROW EXECUTE FUNCTION journal.finance_place_days_apply();

INSERT INTO journal.finance_place_days (branch_id, day, place, kind, delta_kop, ops)
SELECT branch_id, day, place, kind, sum(d), count(*)
FROM (
  SELECT t.branch_id, (t.occurred_at AT TIME ZONE 'UTC')::date AS day, t.place, t.original_kind AS kind, t.delta_kop AS d
  FROM app.rpt_finance_operations t
  UNION ALL
  SELECT t.branch_id, (t.occurred_at AT TIME ZONE 'UTC')::date, t.counter_place, 'transfer_in', -t.delta_kop
  FROM app.rpt_finance_operations t WHERE t.original_kind = 'place_transfer'
) m
GROUP BY branch_id, day, place, kind;

CREATE VIEW app.rpt_finance_place_days AS
SELECT a.branch_id, a.day, a.place, a.kind, a.delta_kop, a.ops FROM journal.finance_place_days a;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_finance_place_days FROM yu_app;
GRANT SELECT ON app.rpt_finance_place_days TO yu_reports;

-- migrate:down
DROP VIEW app.rpt_finance_place_days;
DROP TRIGGER finance_operations_place_days ON journal.finance_operations;
DROP FUNCTION journal.finance_place_days_apply();
DROP TABLE journal.finance_place_days;
