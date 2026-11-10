-- 0436_payroll_closed_snapshots: снимок условий смены закрытого периода без денег (отчёт для программистов, 7 «Качество»).
-- Было (0414): ставку и порог доплаты сверка берёт у самой свежей записи смены – начисления или системной корректировки.
-- Смена закрытого периода, правка часов при сменившемся пороге дала разницу ровно 0: корректировка не пишется (деньги на 0
-- не проводим), снимок остаётся старым – и сверка ждёт сумму по старому порогу (ложная тревога payroll_accrual).
-- Теперь accrual.ts в этом случае пишет строку journal.payroll_closed_snapshots (версия факта, ставка, порог) – только вставка,
-- как весь journal (права по умолчанию 0001: SELECT, INSERT у yu_app). Представление берёт её третьим источником «последней
-- записи» по fact_version; колонки те же (CREATE OR REPLACE), права 0311 сохраняются. Начисленные суммы миграция не меняет.

-- migrate:up
CREATE TABLE journal.payroll_closed_snapshots (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id        uuid NOT NULL REFERENCES app.staff_shifts(id),
  fact_version    int NOT NULL,
  rate_id         uuid REFERENCES journal.staff_rates(id),
  fee_min_minutes int NOT NULL CHECK (fee_min_minutes >= 0),
  closed_period_id uuid NOT NULL REFERENCES app.payroll_periods(id),
  created_at      timestamptz NOT NULL,
  UNIQUE (shift_id, fact_version)
);

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
    UNION ALL
    SELECT z.fact_version, z.rate_id, z.fee_min_minutes FROM journal.payroll_closed_snapshots z WHERE z.shift_id = s.id
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
DROP TABLE journal.payroll_closed_snapshots;
