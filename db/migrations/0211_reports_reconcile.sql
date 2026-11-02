-- 0211_reports_reconcile: ночная сверка 16 §14 (шаг S2-80, план 6.4).
-- Модуль reports только читает чужие данные – через представления rpt_*, которые принадлежат модулю-владельцу данных
-- (ADR 0002 п.1, как booking_hold_points в 0208); формулу представления меняет только владелец:
--   app.rpt_ledger_balances       – core/ledger (K3): кэш balance счёта и сумма его записей (verifyBalance всех счетов);
--   app.rpt_loyalty_points        – loyalty (K15 §2): баланс счёта баллов клиента и Σ remaining активных партий;
--   app.rpt_loyalty_batches       – loyalty (K15 §2): кэш remaining партии и amount + Σ движений партии;
--   app.rpt_certificate_balances  – certificates (K16 §1): номинал, погашения, сгорание, корректировки и остаток счёта;
--   app.rpt_cash_places           – finance (K17 §2): остаток счёта места денег и Σ операций кассы по этому месту.
-- Свои таблицы reports: app.reconcile_runs (запуск: плановый раз в сутки или ручной) и
-- journal.reconcile_discrepancies (найденные расхождения, только вставка).
-- Сторно (entry_type 'reversal') относится к виду исходной записи: сторно погашения уменьшает погашения и т.д.

-- migrate:up
CREATE VIEW app.rpt_ledger_balances AS
SELECT a.id AS account_id, a.kind, a.unit, a.branch_id, a.owner_type, a.owner_id, a.balance,
       COALESCE((SELECT sum(e.amount) FROM journal.ledger_entries e WHERE e.account_id = a.id), 0)::bigint AS entries_sum
FROM app.ledger_accounts a;

CREATE VIEW app.rpt_loyalty_points AS
SELECT a.owner_id AS client_id, a.id AS account_id, a.balance,
       COALESCE((SELECT sum(b.remaining_centi) FROM app.loyalty_batches b WHERE b.client_id = a.owner_id AND b.status = 'active'), 0)::bigint
         AS batches_remaining
FROM app.ledger_accounts a
WHERE a.kind = 'loyalty_client' AND a.owner_type = 'client';

CREATE VIEW app.rpt_loyalty_batches AS
SELECT b.id AS batch_id, b.client_id, b.branch_id, b.status, b.amount_centi, b.remaining_centi,
       (b.amount_centi + COALESCE((SELECT sum(m.delta_centi) FROM journal.loyalty_batch_moves m WHERE m.batch_id = b.id), 0))::bigint
         AS moves_remaining
FROM app.loyalty_batches b;

CREATE VIEW app.rpt_certificate_balances AS
WITH e AS (
  SELECT le.account_id, COALESCE(o.entry_type, le.entry_type) AS kind, le.amount
  FROM journal.ledger_entries le
  LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
  WHERE le.account_id IN (SELECT ledger_account_id FROM app.certificates)
)
SELECT c.id AS certificate_id, c.number, c.sale_branch_id AS branch_id, c.ledger_account_id AS account_id, c.nominal_kop,
       (c.cancelled_at IS NOT NULL) AS cancelled,
       COALESCE((SELECT sum(r.amount_kop) FROM app.certificate_redemptions r
                 WHERE r.certificate_id = c.id AND r.status <> 'returned'), 0)::bigint AS redeemed_kop,
       COALESCE((SELECT -sum(e.amount) FROM e WHERE e.account_id = c.ledger_account_id AND e.kind = 'certificate.expire'), 0)::bigint
         AS expired_kop,
       COALESCE((SELECT sum(e.amount) FROM e WHERE e.account_id = c.ledger_account_id AND e.kind = 'certificate.correction'), 0)::bigint
         AS corrections_kop,
       a.balance AS balance_kop
FROM app.certificates c
JOIN app.ledger_accounts a ON a.id = c.ledger_account_id;

-- Операция кассы двигает своё место (place) по direction; перевод между местами (и его сторно) – ещё и второе место
-- с обратным знаком (K17 §4: place у перевода – источник).
CREATE VIEW app.rpt_cash_places AS
WITH moves AS (
  SELECT fo.branch_id, fo.place, CASE fo.direction WHEN 'in' THEN fo.amount_kop ELSE -fo.amount_kop END AS delta
  FROM journal.finance_operations fo
  UNION ALL
  SELECT fo.branch_id, CASE fo.place WHEN 'cash' THEN 'noncash' ELSE 'cash' END,
         CASE fo.direction WHEN 'in' THEN -fo.amount_kop ELSE fo.amount_kop END
  FROM journal.finance_operations fo
  LEFT JOIN journal.finance_operations orig ON orig.id = fo.reversal_of
  WHERE fo.kind = 'place_transfer' OR orig.kind = 'place_transfer'
), ops AS (
  SELECT branch_id, place, sum(delta)::bigint AS operations_sum FROM moves GROUP BY branch_id, place
), acc AS (
  SELECT a.owner_id AS branch_id, CASE a.kind WHEN 'cash_branch' THEN 'cash' ELSE 'noncash' END AS place, a.id AS account_id, a.balance
  FROM app.ledger_accounts a
  WHERE a.kind IN ('cash_branch', 'cash_branch_noncash') AND a.owner_type = 'branch'
)
SELECT COALESCE(acc.branch_id, ops.branch_id) AS branch_id, COALESCE(acc.place, ops.place) AS place, acc.account_id,
       COALESCE(acc.balance, 0)::bigint AS balance, COALESCE(ops.operations_sum, 0)::bigint AS operations_sum
FROM acc FULL JOIN ops ON ops.branch_id = acc.branch_id AND ops.place = acc.place;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_ledger_balances, app.rpt_loyalty_points, app.rpt_loyalty_batches,
  app.rpt_certificate_balances, app.rpt_cash_places FROM yu_app;

CREATE TABLE app.reconcile_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger            text NOT NULL CHECK (trigger IN ('schedule','manual')),
  scheduled_for      date,                                  -- сутки планового запуска по зоне расписания
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz,
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','discrepancies','failed')),
  checked            jsonb NOT NULL DEFAULT '{}',            -- сколько объектов проверено каждой проверкой
  discrepancy_count  int NOT NULL DEFAULT 0 CHECK (discrepancy_count >= 0),
  error              text,
  CHECK ((trigger = 'schedule') = (scheduled_for IS NOT NULL)),
  CHECK ((status = 'running') = (finished_at IS NULL))
);
-- плановый запуск – один на сутки, даже если worker перезапустился или их два
CREATE UNIQUE INDEX reconcile_runs_one_per_day ON app.reconcile_runs (scheduled_for) WHERE trigger = 'schedule';
CREATE INDEX reconcile_runs_started_idx ON app.reconcile_runs (started_at);
REVOKE DELETE, TRUNCATE ON app.reconcile_runs FROM yu_app;

CREATE TABLE journal.reconcile_discrepancies (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES app.reconcile_runs(id),
  check_name   text NOT NULL CHECK (check_name IN ('ledger_balance','loyalty_points','loyalty_batch','certificate_balance','cash_place')),
  object_type  text NOT NULL CHECK (object_type IN ('ledger_account','client','loyalty_batch','certificate','branch')),
  object_id    uuid NOT NULL,
  branch_id    uuid,
  expected     bigint NOT NULL,                             -- что должно быть по первичным данным
  actual       bigint NOT NULL,                             -- что хранится (кэш, остаток счёта)
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconcile_discrepancies_run_idx ON journal.reconcile_discrepancies (run_id);
SELECT journal.make_append_only('journal.reconcile_discrepancies');

-- migrate:down
DROP TABLE journal.reconcile_discrepancies;
DROP TABLE app.reconcile_runs;
DROP VIEW app.rpt_cash_places;
DROP VIEW app.rpt_certificate_balances;
DROP VIEW app.rpt_loyalty_batches;
DROP VIEW app.rpt_loyalty_points;
DROP VIEW app.rpt_ledger_balances;
