-- 0210_finance_system_categories: системные категории кассы для решения «принять» по смене (K17 §7, «Решения 02.11»).
--   app.finance_categories.code – код системной категории, неизменен; у ручных категорий – NULL.
--   cash_shortage – расход «Недостача кассы», cash_surplus – доход «Излишек кассы»: ими resolveShift (accept)
--   проводит разницу пересчёта, чтобы остаток счёта cash совпал с пересчитанным.
--   Код, вид и родитель системной категории не меняются (триггер finance_categories_system); имя и порядок – можно.
--   sort_order 1000 – в конце уровня; новая ручная категория встаёт после ручных (categories.ts не учитывает системные).

-- migrate:up
ALTER TABLE app.finance_categories ADD COLUMN code text UNIQUE CHECK (code IS NULL OR code ~ '^[a-z_]+$');

CREATE FUNCTION app.finance_categories_guard_system() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.code IS DISTINCT FROM NEW.code
     OR (OLD.code IS NOT NULL AND (OLD.kind <> NEW.kind OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)) THEN
    RAISE EXCEPTION 'Системная категория: код, вид и родитель неизменны' USING ERRCODE = '23514', CONSTRAINT = 'finance_categories_system';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_categories_system BEFORE UPDATE ON app.finance_categories
  FOR EACH ROW EXECUTE FUNCTION app.finance_categories_guard_system();

INSERT INTO app.finance_categories (kind, name, sort_order, code) VALUES
  ('expense', 'Недостача кассы', 1000, 'cash_shortage'),
  ('income', 'Излишек кассы', 1000, 'cash_surplus');

-- migrate:down
DROP TRIGGER finance_categories_system ON app.finance_categories;
DROP FUNCTION app.finance_categories_guard_system();
DELETE FROM app.finance_categories WHERE code IN ('cash_shortage', 'cash_surplus');
ALTER TABLE app.finance_categories DROP COLUMN code;
