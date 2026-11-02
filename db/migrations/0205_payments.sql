-- 0205_payments: сеанс оплаты брони, платежи, строки, возвраты (K10 §3, model-dannyh 0205, шаг S2-20).
--   app.payment_sessions – сеанс = бронь (1:1), создаётся лениво первой командой оплаты.
--   app.payments         – попытки оплаты; живой платёж один: payments_one_live_per_session (TC-07, 18 §6.3).
--   app.payment_lines    – 1 строка; 2 – только «сертификат + деньги» при флаге R-03 (триггер payment_lines_pair).
--   app.payment_refunds  – возвраты строк; seq – n в ключе K3 refund:<paymentId>:<lineNo>:<n>.
-- Способ none (сумма 0) – платёж без строк и без проводки. Отложенные FK из 0203/0204 на payments – здесь (раздел 1).

-- migrate:up
CREATE TABLE app.payment_sessions (
  booking_id      uuid PRIMARY KEY REFERENCES app.bookings(id),
  branch_id       uuid NOT NULL REFERENCES app.branches(id),
  client_id       uuid NOT NULL REFERENCES app.clients(id),
  amount_due_kop  bigint NOT NULL CHECK (amount_due_kop >= 0),
  booking_version int NOT NULL,
  status          text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','partially_refunded','refunded')),
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_sessions_branch_idx ON app.payment_sessions (branch_id, status);

CREATE TABLE app.payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES app.payment_sessions(booking_id),
  attempt             int NOT NULL CHECK (attempt >= 1),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','partially_refunded','refunded')),
  total_kop           bigint NOT NULL CHECK (total_kop >= 0),
  topup_rule_snapshot boolean NOT NULL,
  recorded_by         uuid NOT NULL,
  recorded_at         timestamptz NOT NULL,
  comment             text,
  UNIQUE (session_id, attempt)
);
CREATE UNIQUE INDEX payments_one_live_per_session ON app.payments (session_id) WHERE status IN ('active','partially_refunded');

CREATE TABLE app.payment_lines (
  payment_id           uuid NOT NULL REFERENCES app.payments(id),
  line_no              smallint NOT NULL CHECK (line_no IN (1, 2)),
  method               text NOT NULL CHECK (method IN ('cash','card','transfer','points','certificate')),
  amount_kop           bigint NOT NULL CHECK (amount_kop > 0),
  points_centi         bigint CHECK (points_centi > 0),
  certificate_id       uuid REFERENCES app.certificates(id),
  ledger_posting_id    uuid NOT NULL,
  finance_operation_id uuid REFERENCES journal.finance_operations(id),
  PRIMARY KEY (payment_id, line_no),
  CHECK ((method = 'points') = (points_centi IS NOT NULL)),
  CHECK ((method = 'certificate') = (certificate_id IS NOT NULL)),
  CHECK ((method IN ('cash','card','transfer')) = (finance_operation_id IS NOT NULL))
);

-- Строка 2 – только деньги после строки 1 «сертификат» (K10 §2–3). Ошибка – 23514 payment_lines_pair.
CREATE FUNCTION app.payment_lines_check_pair() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.line_no = 1 THEN
    RETURN NEW;
  END IF;
  IF NEW.method NOT IN ('cash','card','transfer')
     OR NOT EXISTS (SELECT 1 FROM app.payment_lines WHERE payment_id = NEW.payment_id AND line_no = 1 AND method = 'certificate') THEN
    RAISE EXCEPTION 'Вторая строка платежа – только деньги после сертификата' USING ERRCODE = '23514', CONSTRAINT = 'payment_lines_pair';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_lines_pair BEFORE INSERT ON app.payment_lines FOR EACH ROW EXECUTE FUNCTION app.payment_lines_check_pair();

CREATE TABLE app.payment_refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        uuid NOT NULL REFERENCES app.payments(id),
  line_no           smallint NOT NULL,
  seq               int NOT NULL CHECK (seq >= 1),
  amount_kop        bigint NOT NULL CHECK (amount_kop >= 0),
  points_centi      bigint,
  reason            text NOT NULL CHECK (btrim(reason) <> ''),
  outcome           text NOT NULL CHECK (outcome IN ('returned','not_restored')),
  ledger_posting_id uuid,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL,
  FOREIGN KEY (payment_id, line_no) REFERENCES app.payment_lines(payment_id, line_no),
  UNIQUE (payment_id, line_no, seq),
  CHECK ((outcome = 'returned') = (ledger_posting_id IS NOT NULL))
);

-- Платёж, строки и возвраты не удаляются; строки и возвраты не меняются (06 §17 п.14).
REVOKE DELETE ON app.payments, app.payment_lines, app.payment_refunds, app.payment_sessions FROM yu_app;
REVOKE UPDATE ON app.payment_lines, app.payment_refunds FROM yu_app;

ALTER TABLE app.certificate_redemptions ADD CONSTRAINT certificate_redemptions_payment_fk FOREIGN KEY (payment_id) REFERENCES app.payments(id);
ALTER TABLE app.loyalty_accruals ADD CONSTRAINT loyalty_accruals_payment_fk FOREIGN KEY (payment_id) REFERENCES app.payments(id);

-- migrate:down
ALTER TABLE app.loyalty_accruals DROP CONSTRAINT loyalty_accruals_payment_fk;
ALTER TABLE app.certificate_redemptions DROP CONSTRAINT certificate_redemptions_payment_fk;
DROP TABLE app.payment_refunds;
DROP TABLE app.payment_lines;
DROP FUNCTION app.payment_lines_check_pair();
DROP TABLE app.payments;
DROP TABLE app.payment_sessions;
