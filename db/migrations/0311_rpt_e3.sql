-- 0311_rpt_e3: представления Э3 для отчётов Э4 и ночной сверки 16 §14 (K20 §11, K24 §3.9–3.10, §12, шаг S3-95, D4-23).
-- Владельцы – модули Э3 и finance, как 0211: reports читает только эти представления, формулу меняет владелец (ADR 0002 п.1).
--   Для отчётов (K20 §11): rpt_events, rpt_event_money, rpt_repair_money, rpt_shifts, rpt_shift_gaps, rpt_payroll, rpt_equipment, rpt_repairs.
--   Для сверки: rpt_payroll_accruals (shifts), rpt_object_expenses и rpt_operation_links (finance).
-- Права: GRANT SELECT выдаёт сама миграция, запись отзывается (представления в PostgreSQL обновляемы). USAGE на схему выдаёт и 0406:
-- порядок 03xx/04xx окончательно выстроится перед Э5 (план 6.5.1), поэтому 0311 выдаёт его тоже и при откате не забирает.
-- CHECK check_name: DROP + ADD с ПОЛНЫМ списком. utilization_over_capacity (S4-136, 0408) уже здесь: кто бы из 0311 и 0408 ни применился
-- последним, в списке все значения (С4.1). object_type расширяется так же.
-- Решения:
--   rpt_shifts.state: no_show и cancelled – NULL (K20 §11 перечисляет только planned, open, closed, unclosed; empty – из rpt_shift_gaps).
--   rpt_shift_gaps: окно [сегодня − 400; сегодня + 62] дня: представление без параметров, а отчёт K24 просит не больше года назад и планирование вперёд.
--   rpt_payroll: строка на период × сотрудник × филиал. Выплата проводится без филиала (K18 §9) и может лечь после конца периода, поэтому
--     paid_kop берётся по ссылке на ведомость и стоит только в строке branch_id IS NULL; Σ paid_kop по строкам = выплачено сотруднику за период.
--   rpt_payroll_accruals: доплата за выход зависит от настройки на момент начисления (payroll.attendance_fee_min_minutes), истории настройки нет,
--     поэтому верной считается сумма hourly или hourly + fee; hourly – точная формула accrualParts (rates.ts). pending – событие ещё в очереди: не расхождение.

-- migrate:up
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yu_reports') THEN
    RAISE EXCEPTION 'Нет роли yu_reports: её создаёт скрипт инициализации кластера до миграций';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA app TO yu_reports;

CREATE VIEW app.rpt_events AS
SELECT e.id AS event_id, e.number, e.branch_id, t.code AS type_code, e.status,
       (e.planned_start AT TIME ZONE b.timezone)::date AS held_on,
       COALESCE(l.agreed_kop, 0)::bigint AS agreed_price_kop,
       COALESCE(l.planned_cost_kop, 0)::bigint AS planned_cost_kop,
       COALESCE(k.by_kind, '{}'::jsonb) AS planned_cost_by_kind,
       COALESCE(l.discounts_kop, 0)::bigint AS discounts_kop,
       EXISTS (SELECT 1 FROM app.event_bookings eb WHERE eb.event_id = e.id) AS has_booking,
       EXISTS (SELECT 1 FROM app.event_resources er WHERE er.event_id = e.id AND er.status = 'active') AS has_resources,
       e.source, e.customer_client_id
FROM app.events e
JOIN app.event_types t ON t.id = e.type_id
JOIN app.branches b ON b.id = e.branch_id
LEFT JOIN LATERAL (
  SELECT sum(round(x.quantity * x.price_kop - x.discount_kop)) AS agreed_kop, sum(x.plan_cost_kop) AS planned_cost_kop, sum(x.discount_kop) AS discounts_kop
  FROM app.event_lines x WHERE x.event_id = e.id AND x.status = 'active'
) l ON true
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(q.kind, q.kop) AS by_kind
  FROM (SELECT x.kind, sum(x.plan_cost_kop)::bigint AS kop FROM app.event_lines x
        WHERE x.event_id = e.id AND x.status = 'active' AND x.plan_cost_kop IS NOT NULL GROUP BY x.kind) q
) k ON true;

-- Деньги – по живым связям K17 §14, а не по ref_type операции: привязанный вручную расход своего ref_type не имеет.
CREATE VIEW app.rpt_event_money AS
SELECT l.ref_id AS event_id, fo.id AS operation_id, fo.kind, l.role, l.in_cost, el.kind AS line_kind,
       fo.category_id, fo.subcategory_id, fo.amount_kop, fo.direction, fo.occurred_at,
       EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id) AS reversed
FROM app.finance_operation_links l
JOIN journal.finance_operations fo ON fo.id = l.operation_id
LEFT JOIN app.event_lines el ON el.id = l.line_id
WHERE l.ref_type = 'event' AND l.unlinked_at IS NULL;

CREATE VIEW app.rpt_repair_money AS
SELECT l.ref_id AS repair_id, fo.id AS operation_id, fo.amount_kop, fo.occurred_at, fo.branch_id AS payer_branch_id,
       EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id) AS reversed
FROM app.finance_operation_links l
JOIN journal.finance_operations fo ON fo.id = l.operation_id
WHERE l.ref_type = 'repair' AND l.unlinked_at IS NULL;

CREATE VIEW app.rpt_shifts AS
SELECT s.id AS shift_id, s.branch_id, s.staff_id, s.local_date, s.period AS planned_period,
       CASE WHEN s.fact_start IS NOT NULL AND (s.fact_end IS NULL OR s.fact_end >= s.fact_start)
            THEN tstzrange(s.fact_start, s.fact_end, '[)') END AS actual_period,
       s.status,
       CASE s.status
         WHEN 'planned' THEN CASE WHEN s.period @> now() THEN 'open' ELSE 'planned' END
         WHEN 'worked' THEN 'closed'
         WHEN 'needs_review' THEN 'unclosed'
       END AS state,
       s.paid_minutes,
       NOT EXISTS (SELECT 1 FROM journal.staff_rates x WHERE x.staff_id = s.staff_id AND x.valid_from <= s.local_date) AS rate_missing
FROM app.staff_shifts s;

-- Те же правила, что coverage.ts и resolveDay: исключение на филиал важнее недели; закрывающий вид или выходной – дня нет; пусто = открытое минус смены.
CREATE VIEW app.rpt_shift_gaps AS
WITH days AS (
  SELECT b.id AS branch_id, b.timezone, d::date AS local_date
  FROM app.branches b
  CROSS JOIN generate_series((CURRENT_DATE - 400)::timestamp, (CURRENT_DATE + 62)::timestamp, interval '1 day') d
  WHERE b.status = 'active'
), open_hours AS (
  SELECT d.branch_id, d.local_date, d.timezone,
         CASE WHEN ex.kind IS NOT NULL THEN ex.open_time WHEN NOT w.is_closed THEN w.open_time END AS open_time,
         CASE WHEN ex.kind IS NOT NULL THEN ex.close_time WHEN NOT w.is_closed THEN w.close_time END AS close_time
  FROM days d
  LEFT JOIN LATERAL (
    SELECT x.kind, x.open_time, x.close_time FROM app.calendar_exceptions x
    WHERE x.branch_id = d.branch_id AND x.local_date = d.local_date AND x.scope_type = 'branch' AND x.status = 'active'
    ORDER BY x.created_at DESC, x.id LIMIT 1
  ) ex ON true
  LEFT JOIN app.branch_weekly_hours w
    ON w.branch_id = d.branch_id AND w.weekday = extract(isodow FROM d.local_date)
   AND w.valid_from <= d.local_date AND (w.valid_to IS NULL OR w.valid_to >= d.local_date)
)
SELECT h.branch_id, h.local_date, gap.gap_period
FROM open_hours h
CROSS JOIN LATERAL unnest(
  tstzmultirange(tstzrange((h.local_date + h.open_time) AT TIME ZONE h.timezone, (h.local_date + h.close_time) AT TIME ZONE h.timezone, '[)'))
  - COALESCE((SELECT range_agg(s.period) FROM app.staff_shifts s
              WHERE s.branch_id = h.branch_id AND s.local_date = h.local_date AND s.status IN ('planned','worked','needs_review')), '{}'::tstzmultirange)
) AS gap(gap_period)
WHERE h.open_time IS NOT NULL AND h.close_time IS NOT NULL;

-- Как computeTotals (payroll.ts): дата записи – payrollDateSql, сторно относится к виду исходной записи, carryOffset в итоги не входит.
CREATE VIEW app.rpt_payroll AS
WITH entries AS (
  SELECT p.id AS period_id, a.owner_id AS staff_id, le.branch_id, COALESCE(o.entry_type, le.entry_type) AS kind, le.amount, le.id
  FROM journal.ledger_entries le
  JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll'
  LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
  JOIN app.payroll_periods p ON (le.occurred_at AT TIME ZONE 'UTC')::date BETWEEN p.date_from AND p.date_to
  WHERE NOT (le.refs ? 'carryOffset') AND COALESCE(o.entry_type, le.entry_type) <> 'payroll.payout'
), parts AS (
  SELECT e.period_id, e.staff_id, e.branch_id, sum(x.hourly_part_kop) AS hourly_kop, sum(x.fee_part_kop) AS fee_kop
  FROM entries e
  JOIN journal.payroll_accruals x ON x.ledger_entry_id = e.id
  WHERE NOT EXISTS (SELECT 1 FROM journal.ledger_entries r WHERE r.reversal_of = e.id)
  GROUP BY 1, 2, 3
), sums AS (
  SELECT period_id, staff_id, branch_id,
         sum(amount) FILTER (WHERE kind = 'payroll.accrual') AS accrued,
         -sum(amount) FILTER (WHERE kind = 'payroll.penalty') AS penalties,
         sum(amount) FILTER (WHERE kind = 'payroll.bonus') AS bonuses,
         sum(amount) FILTER (WHERE kind = 'payroll.correction') AS adjustments
  FROM entries GROUP BY 1, 2, 3
), payouts AS (
  SELECT st.period_id, st.staff_id, NULL::uuid AS branch_id,
         COALESCE((SELECT -sum(le.amount) FROM journal.ledger_entries le
                   LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
                   WHERE le.ref_type = 'payroll_statement' AND le.ref_id = st.id AND COALESCE(o.entry_type, le.entry_type) = 'payroll.payout'), 0) AS paid
  FROM app.payroll_statements st
), rows_ AS (
  SELECT period_id, staff_id, branch_id FROM sums
  UNION
  SELECT period_id, staff_id, branch_id FROM payouts
)
SELECT r.period_id, r.staff_id, r.branch_id,
       COALESCE(p.hourly_kop, 0)::bigint AS hours_amount_kop,
       COALESCE(p.fee_kop, 0)::bigint AS per_shift_kop,
       COALESCE(s.penalties, 0)::bigint AS penalties_kop,
       COALESCE(s.bonuses, 0)::bigint AS bonuses_kop,
       COALESCE(s.adjustments, 0)::bigint AS adjustments_kop,
       (COALESCE(s.accrued, 0) - COALESCE(s.penalties, 0) + COALESCE(s.bonuses, 0) + COALESCE(s.adjustments, 0))::bigint AS to_pay_kop,
       COALESCE(po.paid, 0)::bigint AS paid_kop,
       st.actual_payout_date AS paid_at,
       st.status AS statement_status
FROM rows_ r
LEFT JOIN sums s ON s.period_id = r.period_id AND s.staff_id = r.staff_id AND s.branch_id IS NOT DISTINCT FROM r.branch_id
LEFT JOIN parts p ON p.period_id = r.period_id AND p.staff_id = r.staff_id AND p.branch_id IS NOT DISTINCT FROM r.branch_id
LEFT JOIN payouts po ON po.period_id = r.period_id AND po.staff_id = r.staff_id AND po.branch_id IS NOT DISTINCT FROM r.branch_id
LEFT JOIN app.payroll_statements st ON st.period_id = r.period_id AND st.staff_id = r.staff_id;

CREATE VIEW app.rpt_equipment AS
SELECT i.id AS equipment_id, i.branch_id, pl.unit_id, pl.room_id,
       COALESCE(ARRAY(SELECT ru.resource_id FROM app.resource_units ru
                      WHERE ru.unit_id = pl.unit_id AND ru.valid_from <= now() AND (ru.valid_to IS NULL OR ru.valid_to > now())
                      ORDER BY ru.resource_id), '{}'::uuid[]) AS resource_ids,
       i.status, i.inventory_number AS inventory_no, i.serial_number AS serial_no, i.category_id
FROM app.equipment_items i
LEFT JOIN app.equipment_placements pl ON pl.item_id = i.id AND pl.removed_at IS NULL;

CREATE VIEW app.rpt_repairs AS
SELECT r.id AS repair_id, r.equipment_id, r.branch_id,
       COALESCE(r.broken_at, r.detected_at) AS incident_at,
       (r.broken_at IS NULL) AS incident_at_is_detected,
       (SELECT min(h.at) FROM journal.repair_status_history h WHERE h.repair_id = r.id AND h.to_status = 'in_repair') AS started_at,
       r.completed_at AS finished_at,
       r.executor_id AS contractor_id,
       EXISTS (SELECT 1 FROM app.equipment_warranties w
               WHERE w.equipment_id = r.equipment_id AND w.status = 'active'
                 AND (COALESCE(r.broken_at, r.detected_at))::date BETWEEN w.starts_on AND w.ends_on) AS warranty,
       r.priority, r.status,
       COALESCE(ARRAY(SELECT rb.block_id FROM app.repair_blocks rb WHERE rb.repair_id = r.id ORDER BY rb.block_id), '{}'::uuid[]) AS block_ids
FROM app.repairs r;

-- Сверка начисления: сумма K3 по смене против формулы по минутам и ставке, с которой считали (последнее начисление, иначе rateAt).
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

-- Сверка расходов объекта: Σ живых расходов объекта (по живой связи или по ссылке операции, если связи не было вовсе) против Σ по живым связям.
-- Отвязанная с причиной операция (K17 §14) считается снятой с объекта. Сторнированная не считается нигде: linksOf её тоже не отдаёт.
CREATE VIEW app.rpt_object_expenses AS
WITH ops AS (
  SELECT fo.id, fo.amount_kop, fo.ref_type, fo.ref_id
  FROM journal.finance_operations fo
  WHERE fo.kind = 'expense' AND NOT EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id)
), linked AS (
  SELECT l.ref_type, l.ref_id, sum(o.amount_kop) AS kop
  FROM app.finance_operation_links l JOIN ops o ON o.id = l.operation_id
  WHERE l.unlinked_at IS NULL AND l.role = 'expense' AND l.ref_type IN ('event','repair')
  GROUP BY 1, 2
), unlinked AS (
  SELECT o.ref_type, o.ref_id, sum(o.amount_kop) AS kop
  FROM ops o
  WHERE o.ref_type IN ('event','repair') AND o.ref_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM app.finance_operation_links l WHERE l.operation_id = o.id)
  GROUP BY 1, 2
)
SELECT COALESCE(a.ref_type, b.ref_type) AS ref_type, COALESCE(a.ref_id, b.ref_id) AS ref_id,
       COALESCE(e.branch_id, r.branch_id) AS branch_id,
       (COALESCE(a.kop, 0) + COALESCE(b.kop, 0))::bigint AS operations_kop,
       COALESCE(a.kop, 0)::bigint AS links_kop
FROM linked a
FULL JOIN unlinked b ON b.ref_type = a.ref_type AND b.ref_id = a.ref_id
LEFT JOIN app.events e ON COALESCE(a.ref_type, b.ref_type) = 'event' AND e.id = COALESCE(a.ref_id, b.ref_id)
LEFT JOIN app.repairs r ON COALESCE(a.ref_type, b.ref_type) = 'repair' AND r.id = COALESCE(a.ref_id, b.ref_id);

-- Одна операция – одна живая связь, на существующий объект, с ролью по виду операции и в её филиале (K17 §14). Строка на живую связь.
CREATE VIEW app.rpt_operation_links AS
SELECT l.id AS link_id, l.operation_id, fo.branch_id, l.ref_type, l.ref_id, l.role, fo.kind,
       count(*) OVER (PARTITION BY l.operation_id) AS live_links,
       CASE
         WHEN count(*) OVER (PARTITION BY l.operation_id) > 1 THEN 'multiple_live'
         WHEN NOT CASE l.ref_type
                    WHEN 'event' THEN EXISTS (SELECT 1 FROM app.events x WHERE x.id = l.ref_id)
                    WHEN 'repair' THEN EXISTS (SELECT 1 FROM app.repairs x WHERE x.id = l.ref_id)
                    WHEN 'payroll_statement' THEN EXISTS (SELECT 1 FROM app.payroll_statements x WHERE x.id = l.ref_id)
                  END THEN 'orphan_ref'
         WHEN fo.kind <> CASE l.role WHEN 'income' THEN 'income' WHEN 'refund' THEN 'refund' ELSE 'expense' END THEN 'role_mismatch'
         WHEN fo.branch_id <> l.branch_id THEN 'branch_mismatch'
       END AS issue
FROM app.finance_operation_links l
JOIN journal.finance_operations fo ON fo.id = l.operation_id
WHERE l.unlinked_at IS NULL;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_events, app.rpt_event_money, app.rpt_repair_money, app.rpt_shifts, app.rpt_shift_gaps,
  app.rpt_payroll, app.rpt_equipment, app.rpt_repairs, app.rpt_payroll_accruals, app.rpt_object_expenses, app.rpt_operation_links FROM yu_app;
GRANT SELECT ON app.rpt_events, app.rpt_event_money, app.rpt_repair_money, app.rpt_shifts, app.rpt_shift_gaps,
  app.rpt_payroll, app.rpt_equipment, app.rpt_repairs, app.rpt_payroll_accruals, app.rpt_object_expenses, app.rpt_operation_links TO yu_reports;

ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT reconcile_discrepancies_check_name_check;
ALTER TABLE journal.reconcile_discrepancies ADD CONSTRAINT reconcile_discrepancies_check_name_check CHECK (check_name IN (
  'ledger_balance','loyalty_points','loyalty_batch','certificate_balance','cash_place',
  'payroll_accrual','payroll_balance','event_expense','repair_expense','operation_link',
  'utilization_over_capacity'));
ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT reconcile_discrepancies_object_type_check;
ALTER TABLE journal.reconcile_discrepancies ADD CONSTRAINT reconcile_discrepancies_object_type_check CHECK (object_type IN (
  'ledger_account','client','loyalty_batch','certificate','branch',
  'shift','staff','event','repair','finance_operation'));

-- migrate:down
ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT reconcile_discrepancies_object_type_check;
ALTER TABLE journal.reconcile_discrepancies ADD CONSTRAINT reconcile_discrepancies_object_type_check
  CHECK (object_type IN ('ledger_account','client','loyalty_batch','certificate','branch')) NOT VALID;
ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT reconcile_discrepancies_check_name_check;
ALTER TABLE journal.reconcile_discrepancies ADD CONSTRAINT reconcile_discrepancies_check_name_check
  CHECK (check_name IN ('ledger_balance','loyalty_points','loyalty_batch','certificate_balance','cash_place')) NOT VALID;
DROP VIEW app.rpt_operation_links;
DROP VIEW app.rpt_object_expenses;
DROP VIEW app.rpt_payroll_accruals;
DROP VIEW app.rpt_repairs;
DROP VIEW app.rpt_equipment;
DROP VIEW app.rpt_payroll;
DROP VIEW app.rpt_shift_gaps;
DROP VIEW app.rpt_shifts;
DROP VIEW app.rpt_repair_money;
DROP VIEW app.rpt_event_money;
DROP VIEW app.rpt_events;
