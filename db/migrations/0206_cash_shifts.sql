-- 0206_cash_shifts: кассовая смена за флагом finance.cash_shift_enabled (K17 §7, model-dannyh 0206, шаг S2-16).
--   app.cash_shifts – одна открытая смена на филиал (cash_shifts_one_open); пересчёт наличных при открытии и закрытии,
--   ожидаемые суммы Администратору не показываются; расхождение решает Директор или Владелец, само не проводится.
-- Отложенный FK finance_operations.shift_id → cash_shifts – здесь (раздел 1).

-- migrate:up
CREATE TABLE app.cash_shifts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id               uuid NOT NULL REFERENCES app.branches(id),
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','needs_resolution','resolved')),
  opened_by               uuid NOT NULL REFERENCES app.staff(id),
  opened_at               timestamptz NOT NULL,
  opening_counted_kop     bigint NOT NULL CHECK (opening_counted_kop >= 0),
  opening_expected_kop    bigint NOT NULL,
  closed_by               uuid REFERENCES app.staff(id),
  closed_at               timestamptz,
  closing_counted_kop     bigint CHECK (closing_counted_kop >= 0),
  closing_expected_kop    bigint,
  resolution              text CHECK (resolution IN ('correct','accept')),
  resolution_reason       text,
  resolution_operation_id uuid REFERENCES journal.finance_operations(id),
  resolved_by             uuid REFERENCES app.staff(id),
  resolved_at             timestamptz,
  row_version             int NOT NULL DEFAULT 1,
  CHECK (status = 'open' OR (closed_at IS NOT NULL AND closing_counted_kop IS NOT NULL)),
  CHECK (resolution IS NULL OR resolution_reason IS NOT NULL),
  CHECK ((status = 'resolved') = (resolution IS NOT NULL)),
  CHECK (resolution IS DISTINCT FROM 'correct' OR resolution_operation_id IS NOT NULL)
);
CREATE UNIQUE INDEX cash_shifts_one_open ON app.cash_shifts (branch_id) WHERE status = 'open';
CREATE INDEX cash_shifts_branch_idx ON app.cash_shifts (branch_id, opened_at);
REVOKE DELETE ON app.cash_shifts FROM yu_app;

ALTER TABLE journal.finance_operations ADD CONSTRAINT finance_operations_shift_fk FOREIGN KEY (shift_id) REFERENCES app.cash_shifts(id);

-- migrate:down
ALTER TABLE journal.finance_operations DROP CONSTRAINT finance_operations_shift_fk;
DROP TABLE app.cash_shifts;
