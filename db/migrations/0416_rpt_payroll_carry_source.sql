-- 0416_rpt_payroll_carry_source: отчёт «Сотрудники и смены» (K24 §3.9) учитывал перенос минуса ведомости дважды (ревизия S4-76…S4-79).
-- 0415 отсекает только запись-компенсацию carryOffset, а запись переноса (refs.carriedFrom) входит всегда. Раздел «Зарплата» Э3
-- (shifts/report.ts) запись переноса не берёт, если ведомость-источник целиком лежит в периоде отчёта: её минус уже в суммах.
-- Здесь – границы периода ведомости-источника в той же шкале, что payroll_at (полночь даты в зоне филиала записи, без филиала – UTC):
-- carry_from_at – начало первого дня, carry_to_at – конец последнего; у прочих записей – NULL. Сравнение с окном отчёта – в staff.ts.
-- 0415 не правится: раннер сверяет контрольные суммы. Колонки 0415 те же и в том же порядке, новые – в конце; права – как в 0415.

-- migrate:up
CREATE OR REPLACE VIEW app.rpt_payroll_entries AS
SELECT le.id AS entry_id, a.owner_id AS staff_id, le.branch_id,
       (le.occurred_at AT TIME ZONE 'UTC')::date AS payroll_date,
       ((le.occurred_at AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE coalesce(b.timezone, 'UTC')) AS payroll_at,
       coalesce(o.entry_type, le.entry_type) AS kind, (le.reversal_of IS NOT NULL) AS is_reversal,
       le.amount AS amount_kop,
       CASE WHEN coalesce(o.entry_type, le.entry_type) IN ('payroll.penalty', 'payroll.payout') THEN -le.amount ELSE le.amount END AS value_kop,
       coalesce(x.hourly_part_kop, 0)::bigint AS hourly_kop, coalesce(x.fee_part_kop, 0)::bigint AS fee_kop,
       le.ref_type, le.ref_id, le.basis,
       (cp.date_from::timestamp AT TIME ZONE coalesce(b.timezone, 'UTC')) AS carry_from_at,
       ((cp.date_to + 1)::timestamp AT TIME ZONE coalesce(b.timezone, 'UTC')) AS carry_to_at
FROM journal.ledger_entries le
JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll'
LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
LEFT JOIN app.branches b ON b.id = le.branch_id
LEFT JOIN app.payroll_statements cs ON le.refs ? 'carriedFrom' AND cs.id = (le.refs->>'carriedFrom')::uuid
LEFT JOIN app.payroll_periods cp ON cp.id = cs.period_id
LEFT JOIN journal.payroll_accruals x ON x.ledger_entry_id = le.id
  AND NOT EXISTS (SELECT 1 FROM journal.ledger_entries rv WHERE rv.reversal_of = le.id)
WHERE NOT (le.refs ? 'carryOffset');

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_payroll_entries FROM yu_app;
GRANT SELECT ON app.rpt_payroll_entries TO yu_reports;

-- migrate:down
-- CREATE OR REPLACE не убирает колонки: представление 0415 пересоздаётся (от него ничего не зависит).
DROP VIEW app.rpt_payroll_entries;
CREATE VIEW app.rpt_payroll_entries AS
SELECT le.id AS entry_id, a.owner_id AS staff_id, le.branch_id,
       (le.occurred_at AT TIME ZONE 'UTC')::date AS payroll_date,
       ((le.occurred_at AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE coalesce(b.timezone, 'UTC')) AS payroll_at,
       coalesce(o.entry_type, le.entry_type) AS kind, (le.reversal_of IS NOT NULL) AS is_reversal,
       le.amount AS amount_kop,
       CASE WHEN coalesce(o.entry_type, le.entry_type) IN ('payroll.penalty', 'payroll.payout') THEN -le.amount ELSE le.amount END AS value_kop,
       coalesce(x.hourly_part_kop, 0)::bigint AS hourly_kop, coalesce(x.fee_part_kop, 0)::bigint AS fee_kop,
       le.ref_type, le.ref_id, le.basis
FROM journal.ledger_entries le
JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll'
LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
LEFT JOIN app.branches b ON b.id = le.branch_id
LEFT JOIN journal.payroll_accruals x ON x.ledger_entry_id = le.id
  AND NOT EXISTS (SELECT 1 FROM journal.ledger_entries rv WHERE rv.reversal_of = le.id)
WHERE NOT (le.refs ? 'carryOffset');

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_payroll_entries FROM yu_app;
GRANT SELECT ON app.rpt_payroll_entries TO yu_reports;
