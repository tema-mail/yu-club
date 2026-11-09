-- 0415_rpt_e3_report_rows: недостающее для отчётов Э4 по сверке 0311 с K24 §3.5, §3.9, §3.10 (шаг S4-76; в плане – «0410, если нужна»,
-- номер 0410 занят порядком, 0414 – другим потоком). Представления 0311 не меняются (решение техлида 04.11): новые читают их или те же таблицы.
-- Владельцы – модули Э3 и finance, как 0311; reports читает только rpt_* (ADR 0002 п.1). GRANT yu_reports – здесь же (D4-23).
-- Что нашла сверка (K24 §2: период – по дате события, итог = Σ детализации построителем where(spec) по timestamptz и ключу строки):
--   rpt_event_results (events) – в rpt_events нет момента проведения (только held_on), а деньги в rpt_event_money – строками операций:
--     строка мероприятия с суммами по формулам summarize (events/money.ts, K20 §6) – детализация показателя = строки мероприятий.
--     Деньги – все живые связи мероприятия независимо от их даты (K24 §3.5), сторнированные – нет (как linksOf).
--   rpt_shift_facts (shifts) – у rpt_shifts только периоды: начало, конец и минуты плана; ставка на дату смены – для прогноза (как shiftDtos).
--   rpt_shift_gap_rows (shifts) – у rpt_shift_gaps нет ключа строки и момента начала.
--   rpt_payroll_entries (shifts) – rpt_payroll свёрнут по period_id без дат периода: отчёт с произвольным периодом и зоной Директора
--     должен совпасть с разделом «Зарплата» Э3 (report.ts): записи K3 по payrollDateSql (дата UTC), сторно – вид исходной, carryOffset – нет.
--     payroll_at – полночь этой даты в зоне филиала записи (у записи без филиала – UTC): окно суток филиала отбирает ровно её дату.
--   rpt_payout_expenses (finance) – расход кассы на выплату по ведомости (K18 §9, role payout_expense) с филиалом: TC-19 в отчёте 3.9.
-- Оборудование и ремонты (3.10) – хватает rpt_equipment, rpt_repairs, rpt_repair_money и rpt_unit_blocks (0406): новых нет.

-- migrate:up
CREATE VIEW app.rpt_event_results AS
SELECT r.event_id, r.number, r.branch_id, r.type_code, r.status, r.held_on, e.planned_start AS held_at, r.has_booking,
       r.agreed_price_kop, r.planned_cost_kop,
       m.received_kop, m.refunded_kop, m.fact_cost_kop,
       (r.agreed_price_kop - m.received_kop + m.refunded_kop)::bigint AS due_kop,
       (m.received_kop - m.refunded_kop - m.fact_cost_kop)::bigint AS result_kop,
       (m.fact_cost_kop - r.planned_cost_kop)::bigint AS deviation_kop
FROM app.rpt_events r
JOIN app.events e ON e.id = r.event_id
CROSS JOIN LATERAL (
  SELECT coalesce(sum(x.amount_kop) FILTER (WHERE x.role = 'income'), 0)::bigint AS received_kop,
         coalesce(sum(x.amount_kop) FILTER (WHERE x.role = 'refund'), 0)::bigint AS refunded_kop,
         coalesce(sum(x.amount_kop) FILTER (WHERE x.role = 'expense' AND x.in_cost), 0)::bigint AS fact_cost_kop
  FROM app.rpt_event_money x WHERE x.event_id = r.event_id AND NOT x.reversed
) m;

CREATE VIEW app.rpt_shift_facts AS
SELECT s.shift_id, s.branch_id, s.staff_id, s.local_date, lower(s.planned_period) AS planned_start, upper(s.planned_period) AS planned_end,
       (extract(epoch FROM upper(s.planned_period) - lower(s.planned_period)) / 60)::int AS planned_minutes,
       s.status, s.state, s.paid_minutes, s.rate_missing, r.hourly_kop, r.attendance_fee_kop
FROM app.rpt_shifts s
LEFT JOIN LATERAL (
  SELECT x.hourly_kop, x.attendance_fee_kop FROM journal.staff_rates x
  WHERE x.staff_id = s.staff_id AND x.valid_from <= s.local_date
  ORDER BY x.valid_from DESC, x.created_at DESC, x.id DESC LIMIT 1
) r ON true;

CREATE VIEW app.rpt_shift_gap_rows AS
SELECT md5(g.branch_id::text || '|' || lower(g.gap_period)::text)::uuid AS gap_id, g.branch_id, g.local_date,
       lower(g.gap_period) AS gap_start, upper(g.gap_period) AS gap_end,
       (extract(epoch FROM upper(g.gap_period) - lower(g.gap_period)) / 60)::int AS gap_minutes
FROM app.rpt_shift_gaps g;

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

CREATE VIEW app.rpt_payout_expenses AS
SELECT fo.id AS operation_id, fo.branch_id, l.ref_id AS statement_id, st.staff_id, fo.amount_kop, fo.occurred_at
FROM app.finance_operation_links l
JOIN journal.finance_operations fo ON fo.id = l.operation_id
JOIN app.payroll_statements st ON st.id = l.ref_id
WHERE l.ref_type = 'payroll_statement' AND l.role = 'payout_expense' AND l.unlinked_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_event_results, app.rpt_shift_facts, app.rpt_shift_gap_rows, app.rpt_payroll_entries, app.rpt_payout_expenses FROM yu_app;
GRANT SELECT ON app.rpt_event_results, app.rpt_shift_facts, app.rpt_shift_gap_rows, app.rpt_payroll_entries, app.rpt_payout_expenses TO yu_reports;

-- migrate:down
DROP VIEW app.rpt_payout_expenses;
DROP VIEW app.rpt_payroll_entries;
DROP VIEW app.rpt_shift_gap_rows;
DROP VIEW app.rpt_shift_facts;
DROP VIEW app.rpt_event_results;
