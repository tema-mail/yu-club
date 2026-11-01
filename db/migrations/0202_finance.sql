-- 0202_finance: касса филиала – категории, операции, начальные остатки, закрытые месяцы (K17, model-dannyh 0202, шаг S2-10).
--   app.ledger_accounts.kind + 'cash_branch_noncash' – второе место денег филиала (K17 §2, решение D2-05):
--     наличные – счёт cash_branch, безнал (карта и перевод) – cash_branch_noncash. Третье место того же вида
--     невозможно – UNIQUE (kind, owner_type, owner_id) из 0004.
--   app.finance_categories       – справочник сети, два уровня (третий запрещает триггер finance_categories_depth).
--   journal.finance_operations   – операция кассы = заголовок одной проводки K3; только вставка (default privileges 0001).
--   app.finance_opening_balances – один действующий начальный остаток на место денег (06 §3.1).
--   app.finance_periods          – закрытые месяцы; у yu_app нет UPDATE/DELETE – открыть месяц нельзя (K17 §6).
-- Отрицательный остаток проверяет код под lockAccounts по finance.negative_balance_allowed, не min_balance (K17 §6).
-- FK finance_operations.shift_id → cash_shifts добавит 0206.

-- migrate:up
ALTER TABLE app.ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE app.ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check
  CHECK (kind IN ('cash_branch','cash_branch_noncash','loyalty_client','certificate','staff_payroll'));

CREATE TABLE app.finance_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('income','expense')),
  parent_id   uuid REFERENCES app.finance_categories(id),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  sort_order  int NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id),
  UNIQUE NULLS NOT DISTINCT (kind, parent_id, name)
);
CREATE INDEX finance_categories_parent_idx ON app.finance_categories (parent_id);

-- Два уровня (06 §7.1): родитель – только категория верхнего уровня того же вида; у категории с подкатегориями
-- родителя быть не может. Ошибка – 23514 с именем ограничения, его модуль переводит в VALIDATION_FAILED.
CREATE FUNCTION app.finance_categories_check_depth() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parent record;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind, parent_id INTO parent FROM app.finance_categories WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RETURN NEW; -- нет родителя – ответит FK
  END IF;
  IF parent.parent_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM app.finance_categories WHERE parent_id = NEW.id) THEN
    RAISE EXCEPTION 'Категория: третьего уровня нет' USING ERRCODE = '23514', CONSTRAINT = 'finance_categories_depth';
  END IF;
  IF parent.kind <> NEW.kind THEN
    RAISE EXCEPTION 'Подкатегория другого вида, чем категория' USING ERRCODE = '23514', CONSTRAINT = 'finance_categories_kind';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_categories_depth BEFORE INSERT OR UPDATE OF parent_id, kind ON app.finance_categories
  FOR EACH ROW EXECUTE FUNCTION app.finance_categories_check_depth();

CREATE SEQUENCE app.finance_operation_number_seq;
CREATE TABLE journal.finance_operations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         bigint NOT NULL UNIQUE DEFAULT nextval('app.finance_operation_number_seq'),
  branch_id      uuid NOT NULL REFERENCES app.branches(id),
  kind           text NOT NULL CHECK (kind IN ('opening_balance','income','expense','withdrawal','place_transfer','refund','correction','reversal')),
  place          text NOT NULL CHECK (place IN ('cash','noncash')),   -- для place_transfer – место-источник
  method         text CHECK (method IN ('cash','card','transfer')),
  direction      text NOT NULL CHECK (direction IN ('in','out')),
  amount_kop     bigint NOT NULL CHECK (amount_kop > 0),
  source         text CHECK (source IN ('session','certificate_sale','event','extra_service','other')),
  category_id    uuid REFERENCES app.finance_categories(id),
  subcategory_id uuid REFERENCES app.finance_categories(id),
  comment        text,
  ref_type       text CHECK (ref_type IN ('booking','payment','certificate','event','repair','staff','operation','shift')),
  ref_id         uuid,
  receipt_issued boolean,                            -- Q-23 «чек пробит»
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  author_type    text NOT NULL CHECK (author_type IN ('staff','system')),
  author_id      uuid,
  posting_id     uuid NOT NULL UNIQUE,               -- 1 операция = 1 проводка K3
  reversal_of    uuid UNIQUE REFERENCES journal.finance_operations(id),   -- второе сторно невозможно
  shift_id       uuid,                               -- FK → cash_shifts добавит 0206
  CHECK ((kind = 'income') = (source IS NOT NULL)),
  CHECK (kind <> 'expense' OR category_id IS NOT NULL),
  CHECK (subcategory_id IS NULL OR category_id IS NOT NULL),
  CHECK (kind NOT IN ('expense','withdrawal','correction','reversal','refund') OR (comment IS NOT NULL AND btrim(comment) <> '')),
  CHECK ((kind = 'reversal') = (reversal_of IS NOT NULL)),
  CHECK (kind <> 'withdrawal' OR place = 'cash'),
  CHECK (method IS NULL OR (method = 'cash') = (place = 'cash')),
  CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  CHECK ((author_type = 'staff') = (author_id IS NOT NULL))
);
CREATE INDEX finance_operations_branch_idx ON journal.finance_operations (branch_id, occurred_at, number);
CREATE INDEX finance_operations_ref_idx ON journal.finance_operations (ref_type, ref_id);

CREATE TABLE app.finance_opening_balances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES app.branches(id),
  place        text NOT NULL CHECK (place IN ('cash','noncash')),
  operation_id uuid NOT NULL UNIQUE REFERENCES journal.finance_operations(id),
  balance_date date NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX finance_opening_balances_one_active ON app.finance_opening_balances (branch_id, place) WHERE status = 'active';

CREATE TABLE app.finance_periods (
  branch_id  uuid NOT NULL REFERENCES app.branches(id),
  month      date NOT NULL CHECK (extract(day FROM month) = 1),   -- первое число месяца по зоне филиала
  closed_at  timestamptz NOT NULL,
  closed_by  uuid NOT NULL,
  PRIMARY KEY (branch_id, month)
);
REVOKE UPDATE, DELETE ON app.finance_periods FROM yu_app;

-- Посев: стартовый справочник расходов 06 §7.3 – предложение, не закрытый перечень (план 6.4.3 п.13).
WITH cats(ord, name, subs) AS (VALUES
  (1, 'Коммунальные', ARRAY['Электричество','Отопление','Вода','Вывоз мусора','Откачка ямы','Интернет']),
  (2, 'Аренда и содержание', ARRAY['Аренда','Эксплуатационные платежи','Уборка']),
  (3, 'Закупки и материалы', ARRAY['Продукты','Напитки','Канцелярия','Хозяйственные товары']),
  (4, 'Персонал', ARRAY['Зарплата','Выплаты за смены','Прочие согласованные выплаты']),
  (5, 'Ремонт и обслуживание', ARRAY['Оборудование','Помещение','Мебель','Техника']),
  (6, 'Маркетинг', ARRAY['Реклама','Печать','Оформление']),
  (7, 'Подрядчики и услуги', ARRAY['Аниматор','Кейтеринг','Доставка']),
  (8, 'Прочее', ARRAY[]::text[])
), top AS (
  INSERT INTO app.finance_categories (kind, name, sort_order)
  SELECT 'expense', name, ord * 10 FROM cats
  RETURNING id, name
)
INSERT INTO app.finance_categories (kind, parent_id, name, sort_order)
SELECT 'expense', top.id, s.name, s.ord * 10
FROM cats JOIN top ON top.name = cats.name
CROSS JOIN LATERAL unnest(cats.subs) WITH ORDINALITY AS s(name, ord);

-- migrate:down
DROP TABLE app.finance_periods;
DROP TABLE app.finance_opening_balances;
DROP TABLE journal.finance_operations;
DROP SEQUENCE app.finance_operation_number_seq;
DROP TABLE app.finance_categories;
DROP FUNCTION app.finance_categories_check_depth();
ALTER TABLE app.ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE app.ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check
  CHECK (kind IN ('cash_branch','loyalty_client','certificate','staff_payroll'));
