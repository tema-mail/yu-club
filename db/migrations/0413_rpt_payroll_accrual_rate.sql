-- 0413_rpt_payroll_accrual_rate: сверка начисления берёт ставку самой записи смены, а не ставку на дату (дефект отчёта для программистов, 7).
-- Было (0311): ставка последнего journal.payroll_accruals, а без него – ставка на дату смены. Смена закрытого периода без начисления
-- получает только системную корректировку (accrual.ts); после новой ставки задним числом ставка на дату менялась, и сверка
-- поднимала ложную тревогу. Теперь корректировка пишет refs.rateId, и ставка берётся у самой свежей по fact_version записи:
-- начисления или системной корректировки. Корректировки без rateId (до этой миграции) – как раньше.
-- 0311 не правится: раннер сверяет контрольные суммы применённых миграций. Колонки те же, GRANT yu_reports сохраняется.

-- migrate:up
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

-- migrate:down
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
       CASE WHEN payable.yes THEN r.attendance_fee_kop ELSE 0::bigint END AS expected_fee_kop,
       COALESCE(l.accrued_kop, 0)::bigint AS accrued_kop,
       (EXISTS (SELECT 1 FROM pending p WHERE p.event_type = 'shift.attendance_changed' AND p.payload->>'shiftId' = s.id::text)
        OR EXISTS (SELECT 1 FROM pending p WHERE p.event_type = 'staff.rate_set' AND p.payload->>'staffId' = s.staff_id::text)) AS pending
FROM app.staff_shifts s
LEFT JOIN LATERAL (
  SELECT a.rate_id FROM journal.payroll_accruals a WHERE a.shift_id = s.id ORDER BY a.fact_version DESC LIMIT 1
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
