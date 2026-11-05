-- 0306_payroll: ведомости, штрафы и премии, связка начисления со сменой (K18 §13, model-dannyh 0306, шаг S3-15).
--   CHECK ledger_entry_type_known (0004) пересоздаётся с полным списком типов + payroll.bonus (K3, K18 §6).
--   app.payroll_statements – ведомость сотрудника за период; totals – снимок при закрытии (K18 §7).
--     Решение против K18 §13: paid – это actual_payout_date, а не обязательная проводка: при toPayKop ≤ 0 ведомость paid
--     без payroll.payout (K18 §9, Q-154), поэтому payout_posting_id может быть пустым и у paid.
--   app.payroll_penalties – штрафы и премии: отмена = статус + сторно K3, удалений нет.
--   journal.payroll_accruals – начисление смены на fact_version, ровно одно на версию; закрытие периода ищет смены worked
--     без строки на текущую версию (K18 §7). Решение против K18 §13: ledger_entry_id пуст при нулевой сумме (ставка 0 разрешена,
--     K18 §3), записи K3 с суммой 0 не бывает (K3), а строка «начислено 0» нужна, чтобы период закрылся.

-- migrate:up
ALTER TABLE journal.ledger_entries DROP CONSTRAINT ledger_entry_type_known;
ALTER TABLE journal.ledger_entries ADD CONSTRAINT ledger_entry_type_known CHECK (entry_type IN (
  'cash.opening_balance','cash.income','cash.expense','cash.transfer_out','cash.transfer_in',
  'cash.withdrawal','cash.correction','cash.refund',
  'loyalty.accrual','loyalty.penalty','loyalty.spend_time','loyalty.spend_goods',
  'loyalty.return','loyalty.expire','loyalty.manual',
  'certificate.issue','certificate.redeem','certificate.expire','certificate.correction',
  'payroll.accrual','payroll.penalty','payroll.bonus','payroll.payout','payroll.correction',
  'reversal'));

CREATE TABLE app.payroll_statements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id           uuid NOT NULL REFERENCES app.payroll_periods(id),
  staff_id            uuid NOT NULL REFERENCES app.staff(id),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculated','checked','ready','paid','disputed')),
  totals              jsonb NOT NULL DEFAULT '{}',
  planned_payout_date date,
  actual_payout_date  date,
  payout_comment      text,
  payout_posting_id   uuid,
  row_version         int NOT NULL DEFAULT 1,
  UNIQUE (period_id, staff_id),
  CHECK ((status = 'paid') = (actual_payout_date IS NOT NULL)),
  CHECK (payout_posting_id IS NULL OR status = 'paid')
);
CREATE INDEX payroll_statements_staff_idx ON app.payroll_statements (staff_id);

CREATE TABLE app.payroll_penalties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('penalty','bonus')),
  staff_id          uuid NOT NULL REFERENCES app.staff(id),
  branch_id         uuid REFERENCES app.branches(id),
  local_date        date NOT NULL,
  amount_kop        bigint NOT NULL CHECK (amount_kop > 0),
  reason            text NOT NULL CHECK (btrim(reason) <> ''),
  comment           text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  posting_id        uuid NOT NULL,
  cancel_posting_id uuid,
  cancel_reason     text,
  replaced_by       uuid REFERENCES app.payroll_penalties(id),
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancel_posting_id IS NOT NULL))
);
CREATE INDEX payroll_penalties_staff_idx ON app.payroll_penalties (staff_id, local_date);
REVOKE DELETE, TRUNCATE ON app.payroll_statements, app.payroll_penalties FROM yu_app;

CREATE TABLE journal.payroll_accruals (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id        uuid NOT NULL REFERENCES app.staff_shifts(id),
  fact_version    int NOT NULL,
  ledger_entry_id bigint REFERENCES journal.ledger_entries(id),
  rate_id         uuid REFERENCES journal.staff_rates(id),
  hourly_part_kop bigint NOT NULL CHECK (hourly_part_kop >= 0),
  fee_part_kop    bigint NOT NULL CHECK (fee_part_kop >= 0),
  UNIQUE (shift_id, fact_version),
  CHECK ((ledger_entry_id IS NULL) = (hourly_part_kop + fee_part_kop = 0))
);

-- migrate:down
DROP TABLE journal.payroll_accruals;
DROP TABLE app.payroll_penalties;
DROP TABLE app.payroll_statements;
ALTER TABLE journal.ledger_entries DROP CONSTRAINT ledger_entry_type_known;
ALTER TABLE journal.ledger_entries ADD CONSTRAINT ledger_entry_type_known CHECK (entry_type IN (
  'cash.opening_balance','cash.income','cash.expense','cash.transfer_out','cash.transfer_in',
  'cash.withdrawal','cash.correction','cash.refund',
  'loyalty.accrual','loyalty.penalty','loyalty.spend_time','loyalty.spend_goods',
  'loyalty.return','loyalty.expire','loyalty.manual',
  'certificate.issue','certificate.redeem','certificate.expire','certificate.correction',
  'payroll.accrual','payroll.penalty','payroll.payout','payroll.correction',
  'reversal'));
