-- 0204_certificates: сертификаты (K16 §10, model-dannyh 0204, шаг S2-50).
--   app.certificates                     – сертификат на предъявителя: номер, HMAC кода, номинал, срок, филиал продажи.
--                                          Остаток – только счёт K3 kind='certificate', min_balance = 0 (столбца остатка нет).
--                                          У yu_app нет UPDATE номинала, номера, срока и полей продажи (08 §15) – как tariffs (0107).
--   app.certificate_redemptions          – погашение = строка оплаты K10; payment_id без FK (FK → payments добавит 0205).
--   journal.certificate_holder_history   – смена получателя (08 §7), только вставка.
-- FK наружу не ссылаются на таблицы 0203 (баллы): порядок слияния 0203 → 0204 – только из-за правила раннера.

-- migrate:up
CREATE TABLE app.certificates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              text NOT NULL UNIQUE CHECK (number ~ '^YC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  pin_hash            text NOT NULL,                     -- HMAC-SHA256(pin, CERT_PEPPER), hex
  pin_failed_count    smallint NOT NULL DEFAULT 0 CHECK (pin_failed_count >= 0),
  pin_locked_until    timestamptz,
  nominal_kop         bigint NOT NULL CHECK (nominal_kop > 0),
  sale_branch_id      uuid NOT NULL REFERENCES app.branches(id),
  sale_method         text NOT NULL CHECK (sale_method IN ('cash','card','transfer')),
  sale_operation_id   uuid NOT NULL UNIQUE REFERENCES journal.finance_operations(id),
  ledger_account_id   uuid NOT NULL UNIQUE REFERENCES app.ledger_accounts(id),
  sold_at             timestamptz NOT NULL,
  sold_by             uuid NOT NULL REFERENCES app.staff(id),
  expires_on          date NOT NULL,                     -- последний день по зоне филиала продажи
  expires_at          timestamptz NOT NULL,              -- начало следующих суток там же
  expired_entry_id    bigint REFERENCES journal.ledger_entries(id),
  cancelled_at        timestamptz,
  cancel_reason       text,
  review_reason       text,                              -- не NULL – «требует проверки»
  buyer_client_id     uuid REFERENCES app.clients(id),
  recipient_client_id uuid REFERENCES app.clients(id),
  comment             text,
  row_version         int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (review_reason IS NULL OR btrim(review_reason) <> ''),
  CHECK (expires_at > sold_at)
);
CREATE INDEX certificates_expiry_idx ON app.certificates (expires_at) WHERE expired_entry_id IS NULL AND cancelled_at IS NULL;
CREATE INDEX certificates_branch_idx ON app.certificates (sale_branch_id, sold_at);
CREATE INDEX certificates_recipient_idx ON app.certificates (recipient_client_id) WHERE recipient_client_id IS NOT NULL;
CREATE INDEX certificates_buyer_idx ON app.certificates (buyer_client_id) WHERE buyer_client_id IS NOT NULL;
-- неизменяемые поля (08 §15): номинал, номер, срок, продажа; сертификат не удаляется (08 §5.3)
REVOKE UPDATE, DELETE, TRUNCATE ON app.certificates FROM yu_app;
GRANT UPDATE (pin_hash, pin_failed_count, pin_locked_until, expired_entry_id, cancelled_at, cancel_reason, review_reason,
              recipient_client_id, comment, row_version) ON app.certificates TO yu_app;

CREATE TABLE app.certificate_redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id  uuid NOT NULL REFERENCES app.certificates(id),
  booking_id      uuid NOT NULL REFERENCES app.bookings(id),
  payment_id      uuid NOT NULL,                         -- FK → payments добавит 0205
  branch_id       uuid NOT NULL REFERENCES app.branches(id),   -- филиал сеанса
  client_id       uuid REFERENCES app.clients(id),
  amount_kop      bigint NOT NULL CHECK (amount_kop > 0),
  ledger_entry_id bigint NOT NULL UNIQUE REFERENCES journal.ledger_entries(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','returned','not_restored')),
  return_entry_id bigint REFERENCES journal.ledger_entries(id),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'returned' OR return_entry_id IS NOT NULL)
);
CREATE INDEX certificate_redemptions_cert_idx ON app.certificate_redemptions (certificate_id);
CREATE INDEX certificate_redemptions_payment_idx ON app.certificate_redemptions (payment_id);
-- меняется только исход возврата (K16 §6); строки не удаляются
REVOKE UPDATE, DELETE, TRUNCATE ON app.certificate_redemptions FROM yu_app;
GRANT UPDATE (status, return_entry_id) ON app.certificate_redemptions TO yu_app;

CREATE TABLE journal.certificate_holder_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  certificate_id uuid NOT NULL REFERENCES app.certificates(id),
  old_client_id  uuid,
  new_client_id  uuid,
  changed_by     uuid NOT NULL,
  changed_at     timestamptz NOT NULL
);
CREATE INDEX certificate_holder_history_cert_idx ON journal.certificate_holder_history (certificate_id, id);
SELECT journal.make_append_only('journal.certificate_holder_history');

-- migrate:down
DROP TABLE journal.certificate_holder_history;
DROP TABLE app.certificate_redemptions;
DROP TABLE app.certificates;
