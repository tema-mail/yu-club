-- 0312_finance_salary_code: подкатегории «Персонал» – «Зарплата» (посев 0202) – неизменный код salary (K18 §9).
--   По нему расход выплаты и привязка ручного расхода находят категорию: имя можно править, код, вид и родителя защищает триггер 0210.
--   Триггер запрещает менять код и посеву, поэтому на время этого UPDATE он выключен. Посев не найден – миграция падает, а не оставляет кассу без кода.

-- migrate:up
ALTER TABLE app.finance_categories DISABLE TRIGGER finance_categories_system;
UPDATE app.finance_categories sub SET code = 'salary'
  FROM app.finance_categories top
 WHERE top.id = sub.parent_id AND top.kind = 'expense' AND top.parent_id IS NULL AND top.name = 'Персонал' AND sub.name = 'Зарплата';
ALTER TABLE app.finance_categories ENABLE TRIGGER finance_categories_system;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.finance_categories WHERE code = 'salary') THEN
    RAISE EXCEPTION 'Нет подкатегории «Персонал» – «Зарплата» для кода salary: проверьте справочник и запустите миграцию снова';
  END IF;
END
$$;

-- migrate:down
ALTER TABLE app.finance_categories DISABLE TRIGGER finance_categories_system;
UPDATE app.finance_categories SET code = NULL WHERE code = 'salary';
ALTER TABLE app.finance_categories ENABLE TRIGGER finance_categories_system;
