-- 0004_ledger: журнал операций со сторно (ADR 0004 §1, K3, model-dannyh 0004).
--   app.ledger_accounts   – счёт с кэшем баланса; yu_app может менять только status.
--   journal.ledger_entries – записи, только вставка (default privileges 0001).
-- Баланс пишет ТОЛЬКО триггер ledger_entries_20_apply_balance (SECURITY DEFINER владельца миграций).
-- Ошибки триггеров – SQLSTATE 23514 с именем ограничения, по нему core/ledger.ts переводит их в коды K3:
--   ledger_balance_below_limit → BALANCE_BELOW_LIMIT, ledger_account_closed → ACCOUNT_CLOSED,
--   ledger_reversal_of_reversal → CANNOT_REVERSE_REVERSAL, ledger_reversal_mismatch – нарушение формы сторно.
-- FK branch_id → branches добавит 0008.

-- migrate:up
CREATE TABLE app.ledger_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('cash_branch','loyalty_client','certificate','staff_payroll')),
  unit         text NOT NULL CHECK (unit IN ('RUB_KOP','POINT_CENTI')),
  branch_id    uuid,
  owner_type   text NOT NULL CHECK (owner_type IN ('branch','client','certificate','staff')),
  owner_id     uuid NOT NULL,
  balance      bigint NOT NULL DEFAULT 0,
  min_balance  bigint,                 -- NULL = без нижней границы
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'loyalty_client') = (unit = 'POINT_CENTI')),
  UNIQUE (kind, owner_type, owner_id)
);

CREATE TABLE journal.ledger_entries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  posting_id       uuid NOT NULL,
  account_id       uuid NOT NULL REFERENCES app.ledger_accounts(id),
  amount           bigint NOT NULL CHECK (amount <> 0),
  balance_after    bigint NOT NULL,               -- ставит триггер, значение из INSERT игнорируется
  entry_type       text NOT NULL,
  basis            text,
  branch_id        uuid,
  ref_type         text,
  ref_id           uuid,
  refs             jsonb NOT NULL DEFAULT '{}',
  reversal_of      bigint UNIQUE REFERENCES journal.ledger_entries(id),  -- второе сторно невозможно
  idempotency_key  text UNIQUE,                   -- навсегда, ADR 0004
  occurred_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  author_type      text NOT NULL CHECK (author_type IN ('staff','client','system')),
  author_id        uuid,
  limit_override   boolean NOT NULL DEFAULT false,
  CHECK (reversal_of IS NULL OR basis IS NOT NULL),
  CHECK ((reversal_of IS NULL) = (entry_type <> 'reversal')),
  CHECK (NOT limit_override OR (basis IS NOT NULL AND author_type = 'staff'))
);
CREATE INDEX ledger_entries_account_idx ON journal.ledger_entries (account_id, occurred_at, id);
CREATE INDEX ledger_entries_ref_idx ON journal.ledger_entries (ref_type, ref_id);
CREATE INDEX ledger_entries_posting_idx ON journal.ledger_entries (posting_id);

-- Баланс меняет только триггер: у yu_app нет UPDATE на ledger_accounts, кроме столбца status.
-- INSERT тоже без столбца balance: новый счёт всегда начинается с 0 (DEFAULT), иначе журнал обходится вставкой.
REVOKE INSERT, UPDATE ON app.ledger_accounts FROM yu_app;
GRANT INSERT (id, kind, unit, branch_id, owner_type, owner_id, min_balance, status) ON app.ledger_accounts TO yu_app;
GRANT UPDATE (status) ON app.ledger_accounts TO yu_app;

CREATE FUNCTION journal.ledger_check_reversal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  orig record;
BEGIN
  IF NEW.reversal_of IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT account_id, amount, reversal_of INTO orig FROM journal.ledger_entries WHERE id = NEW.reversal_of;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Сторно: исходной записи % нет', NEW.reversal_of USING ERRCODE = '23503';
  END IF;
  IF orig.reversal_of IS NOT NULL THEN
    RAISE EXCEPTION 'Сторно сторно запрещено (запись %)', NEW.reversal_of
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_reversal_of_reversal';
  END IF;
  IF orig.account_id <> NEW.account_id OR NEW.amount <> -orig.amount THEN
    RAISE EXCEPTION 'Сторно записи % должно быть на том же счёте с суммой %', NEW.reversal_of, -orig.amount
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_reversal_mismatch';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION journal.ledger_apply_balance() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  acc record;
  next_balance bigint;
BEGIN
  SELECT kind, balance, min_balance, status INTO acc
  FROM app.ledger_accounts WHERE id = NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Счёт % не найден', NEW.account_id USING ERRCODE = '23503';
  END IF;
  IF acc.status = 'closed' THEN
    RAISE EXCEPTION 'Счёт % закрыт', NEW.account_id USING ERRCODE = '23514', CONSTRAINT = 'ledger_account_closed';
  END IF;
  next_balance := acc.balance + NEW.amount;
  IF acc.min_balance IS NOT NULL AND next_balance < acc.min_balance AND NOT NEW.limit_override THEN
    RAISE EXCEPTION 'Баланс счёта % ушёл бы ниже границы', NEW.account_id
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_balance_below_limit',
            DETAIL = json_build_object('accountKind', acc.kind, 'balance', acc.balance,
                                       'minBalance', acc.min_balance, 'attempted', NEW.amount)::text;
  END IF;
  NEW.balance_after := next_balance;
  UPDATE app.ledger_accounts SET balance = next_balance WHERE id = NEW.account_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION journal.ledger_apply_balance() FROM PUBLIC;

-- Порядок BEFORE-триггеров – по имени: сначала проверка сторно, потом баланс.
CREATE TRIGGER ledger_entries_10_check_reversal BEFORE INSERT ON journal.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION journal.ledger_check_reversal();
CREATE TRIGGER ledger_entries_20_apply_balance BEFORE INSERT ON journal.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION journal.ledger_apply_balance();

-- migrate:down
DROP TABLE journal.ledger_entries;
DROP FUNCTION journal.ledger_apply_balance();
DROP FUNCTION journal.ledger_check_reversal();
DROP TABLE app.ledger_accounts;
