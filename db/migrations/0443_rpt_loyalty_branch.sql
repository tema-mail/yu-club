-- 0443_rpt_loyalty_branch: филиал операции в строке движения баллов (K24 §3.7, TC-20 «сумма филиалов + без филиала = сеть»).
-- Владелец – модуль loyalty, как 0407; reports читает только rpt_* (ADR 0002 п.1). Колонки 0407 те же и в том же порядке (CREATE OR REPLACE).
-- branch_id – филиал операции, а не автора: у начисления и штрафа – филиал посещения (неявки), у списания – филиал брони или заказа
-- товара, у возврата и сторно – филиал исходной записи (K3 reverse переносит branch_id и ref), у сгорания – филиал партии.
-- Запись K3 уже несёт его при проводке; если пусто – по ссылке записи (COALESCE считает подзапрос только при NULL).
-- Ручная корректировка (loyalty.manual) и её сторно – NULL = «сеть»: видна только в сетевой области, в отчёт по филиалу не входит;
-- сторно – по исходному типу (t.orig), как и остальные колонки. Права – как в 0407.

-- migrate:up
CREATE OR REPLACE VIEW app.rpt_loyalty_moves AS
WITH t AS (
  SELECT e.id, a.owner_id AS client_id, e.branch_id, e.entry_type, coalesce(o.entry_type, e.entry_type) AS orig, e.amount,
         e.ref_type, e.ref_id, e.occurred_at, e.author_type
  FROM journal.ledger_entries e
  JOIN app.ledger_accounts a ON a.id = e.account_id AND a.kind = 'loyalty_client' AND a.owner_type = 'client'
  LEFT JOIN journal.ledger_entries o ON o.id = e.reversal_of
)
SELECT t.id AS entry_id, t.client_id,
       CASE WHEN t.orig = 'loyalty.manual' THEN NULL
            ELSE coalesce(t.branch_id,
                          CASE t.ref_type
                            WHEN 'visit' THEN (SELECT v.branch_id FROM app.visits v WHERE v.id = t.ref_id)
                            WHEN 'no_show' THEN (SELECT n.branch_id FROM app.no_shows n WHERE n.id = t.ref_id)
                            WHEN 'booking' THEN (SELECT b.branch_id FROM app.bookings b WHERE b.id = t.ref_id)
                            WHEN 'goods_order' THEN (SELECT g.branch_id FROM app.loyalty_goods_orders g WHERE g.id = t.ref_id)
                          END) END AS branch_id,
       CASE WHEN t.entry_type = 'reversal' THEN 'reversal' ELSE m.kind END AS entry_type,
       m.kind AS original_type,
       CASE t.orig WHEN 'loyalty.spend_time' THEN 'time' WHEN 'loyalty.spend_goods' THEN 'goods' END AS spend_kind,
       t.amount AS amount_centi, t.ref_type, t.ref_id, t.occurred_at AS at, t.author_type
FROM t
JOIN (VALUES ('loyalty.accrual', 'accrual'), ('loyalty.penalty', 'penalty'), ('loyalty.spend_time', 'spend'),
             ('loyalty.spend_goods', 'spend'), ('loyalty.return', 'return'), ('loyalty.manual', 'adjust'),
             ('loyalty.expire', 'expire')) AS m(code, kind) ON m.code = t.orig;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_loyalty_moves FROM yu_app;
GRANT SELECT ON app.rpt_loyalty_moves TO yu_reports;

-- migrate:down
CREATE OR REPLACE VIEW app.rpt_loyalty_moves AS
WITH t AS (
  SELECT e.id, a.owner_id AS client_id, e.branch_id, e.entry_type, coalesce(o.entry_type, e.entry_type) AS orig, e.amount,
         e.ref_type, e.ref_id, e.occurred_at, e.author_type
  FROM journal.ledger_entries e
  JOIN app.ledger_accounts a ON a.id = e.account_id AND a.kind = 'loyalty_client' AND a.owner_type = 'client'
  LEFT JOIN journal.ledger_entries o ON o.id = e.reversal_of
)
SELECT t.id AS entry_id, t.client_id, t.branch_id,
       CASE WHEN t.entry_type = 'reversal' THEN 'reversal' ELSE m.kind END AS entry_type,
       m.kind AS original_type,
       CASE t.orig WHEN 'loyalty.spend_time' THEN 'time' WHEN 'loyalty.spend_goods' THEN 'goods' END AS spend_kind,
       t.amount AS amount_centi, t.ref_type, t.ref_id, t.occurred_at AS at, t.author_type
FROM t
JOIN (VALUES ('loyalty.accrual', 'accrual'), ('loyalty.penalty', 'penalty'), ('loyalty.spend_time', 'spend'),
             ('loyalty.spend_goods', 'spend'), ('loyalty.return', 'return'), ('loyalty.manual', 'adjust'),
             ('loyalty.expire', 'expire')) AS m(code, kind) ON m.code = t.orig;
