-- 0201_ledger_limit: предел счёта K3 – только для списаний (K3 правило 7, K15 §1, model-dannyh 0201, шаг S2-07).
-- Было (0004): любая запись, после которой баланс ниже min_balance, отклонялась – даже приход. Баланс ниже предела
-- бывает только после записи с limit_override (Владелец, loyalty.adjust_below_limit); при нём не проходили начисление,
-- возврат и сторно штрафа. Стало: предел проверяется только при NEW.amount < 0. Остальное тело функции – как в 0004.

-- migrate:up
CREATE OR REPLACE FUNCTION journal.ledger_apply_balance() RETURNS trigger
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
  IF acc.min_balance IS NOT NULL AND NEW.amount < 0 AND next_balance < acc.min_balance AND NOT NEW.limit_override THEN
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

-- migrate:down
CREATE OR REPLACE FUNCTION journal.ledger_apply_balance() RETURNS trigger
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
