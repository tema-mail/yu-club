-- 0414_payroll_fee_min_snapshot: снимок порога доплаты за выход в начислении (дефект отчёта для программистов, 7 «Деньги»).
-- Было (0311, 0413): истории настройки payroll.attendance_fee_min_minutes нет, и сверка принимала и hourly, и hourly + fee –
-- пропавшую (или лишнюю) доплату не ловила. Теперь accrual.ts пишет порог, по которому считал: journal.payroll_accruals.fee_min_minutes,
-- у системной корректировки закрытого периода – refs.feeMinMinutes. Порог берётся у той же самой свежей записи смены, что и ставка (0413).
-- Снимок есть – ожидаемая сумма одна: hourly + (fee, если paid_minutes >= порога). Снимка нет (строки до этой миграции) – как раньше:
-- expected_fee_kop = доплата ставки, сверка принимает оба варианта. Новая колонка представления fee_min_minutes – последней
-- (CREATE OR REPLACE VIEW дописывает только в конец), права 0311 (REVOKE записи у yu_app, SELECT yu_reports) сохраняются.
-- Начисленные суммы миграция не меняет. 0311 и 0413 не правятся: раннер сверяет контрольные суммы применённых миграций.

-- migrate:up
ALTER TABLE journal.payroll_accruals ADD COLUMN fee_min_minutes int CHECK (fee_min_minutes >= 0);

CREATE OR REPLACE VIEW app.rpt_payroll_accruals AS
WITH pending AS (
  SELECT e.event_type, e.payload
  FROM app.outbox_events e
  WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set')
    AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id)
), ledger AS (
  SELECT le.ref_id AS shift_id, sum(le.amount) AS accrued_kop
  FROM journal.ledger_entries le
  JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll'
  LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
  WHERE le.ref_type = 'shift'
    AND (COALESCE(o.entry_type, le.entry_type) = 'payroll.accrual' OR le.refs ? 'closedPeriodId' OR COALESCE(o.refs ? 'closedPeriodId', false))
  GROUP BY 1
)
SELECT s.id AS shift_id, s.staff_id, s.branch_id, s.local_date, s.status, s.paid_minutes, s.unpaid_confirmed, s.fact_version,
       r.id AS rate_id, r.hourly_kop, r.attendance_fee_kop,
       CASE WHEN payable.yes THEN ((s.paid_minutes * r.hourly_kop + 30) / 60)::bigint ELSE 0::bigint END AS expected_hourly_kop,
       CASE WHEN payable.yes AND (last.fee_min IS NULL OR s.paid_minutes >= last.fee_min) THEN r.attendance_fee_kop ELSE 0::bigint END AS expected_fee_kop,
       COALESCE(l.accrued_kop, 0)::bigint AS accrued_kop,
       (EXISTS (SELECT 1 FROM pending p WHERE p.event_type = 'shift.attendance_changed' AND p.payload->>'shiftId' = s.id::text)
        OR EXISTS (SELECT 1 FROM pending p WHERE p.event_type = 'staff.rate_set' AND p.payload->>'staffId' = s.staff_id::text)) AS pending,
       last.fee_min AS fee_min_minutes
FROM app.staff_shifts s
LEFT JOIN LATERAL (
  SELECT q.rate_id, q.fee_min FROM (
    SELECT a.fact_version, a.rate_id, a.fee_min_minutes AS fee_min FROM journal.payroll_accruals a WHERE a.shift_id = s.id
    UNION ALL
    SELECT (c.refs->>'factVersion')::int, (c.refs->>'rateId')::uuid, (c.refs->>'feeMinMinutes')::int FROM journal.ledger_entries c
    WHERE c.ref_type = 'shift' AND c.ref_id = s.id AND c.refs ? 'closedPeriodId' AND c.refs ? 'rateId'
  ) q ORDER BY q.fact_version DESC LIMIT 1
) last ON true
LEFT JOIN LATERAL (
  SELECT x.id, x.hourly_kop, x.attendance_fee_kop FROM journal.staff_rates x
  WHERE x.staff_id = s.staff_id AND (x.id = last.rate_id OR (last.rate_id IS NULL AND x.valid_from <= s.local_date))
  ORDER BY x.valid_from DESC, x.created_at DESC, x.id DESC LIMIT 1
) r ON true
CROSS JOIN LATERAL (
  SELECT s.status = 'worked' AND NOT s.unpaid_confirmed AND s.paid_minutes IS NOT NULL AND r.id IS NOT NULL AS yes
) payable
LEFT JOIN ledger l ON l.shift_id = s.id;

-- migrate:down
-- Колонку представления не убрать через CREATE OR REPLACE: представление пересоздаётся (тело 0413) с правами 0311.
DROP VIEW app.rpt_payroll_accruals;
CREATE VIEW app.rpt_payroll_accruals AS
WITH pending AS (
  SELECT e.event_type, e.payload
  FROM app.outbox_events e
  WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set')
    AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id)
), ledger AS (
  SELECT le.ref_id AS shift_id, sum(le.amount) AS accrued_kop
  FROM journal.ledger_entries le
  JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll'
  LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
  WHERE le.ref_type = 'shift'
    AND (COALESCE(o.entry_type, le.entry_type) = 'payroll.accrual' OR le.refs ? 'closedPeriodId' OR COALESCE(o.refs ? 'closedPeriodId', false))
  GROUP BY 1
)
SELECT s.id AS shift_id, s.staff_id, s.branch_id, s.local_date, s.status, s.paid_minutes, s.unpaid_confirmed, s.fact_version,
       r.id AS rate_id, r.hourly_kop, r.attendance_fee_kop,
       CASE WHEN payable.yes THEN ((s.paid_minutes * r.hourly_kop + 30) / 60)::bigint ELSE 0::bigint END AS expected_hourly_kop,
       CASE WHEN payable.yes THEN r.attendance_fee_kop ELSE 0::bigint END AS expected_fee_kop,
       COALESCE(l.accrued_kop, 0)::bigint AS accrued_kop,
       (EXISTS (SELECT 1 FROM pending p WHERE p.event_type = 'shift.attendance_changed' AND p.payload->>'shiftId' = s.id::text)
        OR EXISTS (SELECT 1 FROM pending p WHERE p.event_type = 'staff.rate_set' AND p.payload->>'staffId' = s.staff_id::text)) AS pending
FROM app.staff_shifts s
LEFT JOIN LATERAL (
  SELECT q.rate_id FROM (
    SELECT a.fact_version, a.rate_id FROM journal.payroll_accruals a WHERE a.shift_id = s.id
    UNION ALL
    SELECT (c.refs->>'factVersion')::int, (c.refs->>'rateId')::uuid FROM journal.ledger_entries c
    WHERE c.ref_type = 'shift' AND c.ref_id = s.id AND c.refs ? 'closedPeriodId' AND c.refs ? 'rateId'
  ) q ORDER BY q.fact_version DESC LIMIT 1
) last ON true
LEFT JOIN LATERAL (
  SELECT x.id, x.hourly_kop, x.attendance_fee_kop FROM journal.staff_rates x
  WHERE x.staff_id = s.staff_id AND (x.id = last.rate_id OR (last.rate_id IS NULL AND x.valid_from <= s.local_date))
  ORDER BY x.valid_from DESC, x.created_at DESC, x.id DESC LIMIT 1
) r ON true
CROSS JOIN LATERAL (
  SELECT s.status = 'worked' AND NOT s.unpaid_confirmed AND s.paid_minutes IS NOT NULL AND r.id IS NOT NULL AS yes
) payable
LEFT JOIN ledger l ON l.shift_id = s.id;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_payroll_accruals FROM yu_app;
GRANT SELECT ON app.rpt_payroll_accruals TO yu_reports;
ALTER TABLE journal.payroll_accruals DROP COLUMN fee_min_minutes;
