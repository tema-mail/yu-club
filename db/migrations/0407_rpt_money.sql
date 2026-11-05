-- 0407_rpt_money: денежные представления отчётов (K24 §1, §13; шаг S4-61, план 6.6).
-- Владельцы (формулу меняет только владелец, как 0211):
--   app.rpt_finance_operations – finance (K17): операция кассы; сторно – строкой исходного вида (original_kind, source,
--                                method, категории – исходной операции), signed_kop со знаком минус: Σ signed_kop
--                                по виду = итог вида с учётом сторно. delta_kop – движение своего места (in +, out −);
--                                перевод между местами (и его сторно) двигает и второе место: counter_place, −delta_kop;
--   app.rpt_payments           – finance (K10): строка платежа сеанса (деньги, баллы, сертификат) и возвращённое по ней;
--   app.rpt_loyalty_moves      – loyalty (K15, K3): запись бонусного счёта клиента; entry_type – вид K24 §3.7
--                                (accrual, penalty, spend, return, adjust, expire, reversal), original_type – вид исходной
--                                записи для сторно; amount_centi – со знаком журнала K3 (сторно противоположно исходной);
--   app.rpt_loyalty_balances   – loyalty: баланс клиента, доступное (баланс − активные резервы), blocked – ≤ −50 баллов (K15 §8);
--   app.rpt_certificate_ops    – certificates (K16): событие сертификата по журналу K3 его счёта – sale, redeem,
--                                redeem_return (сторно погашения), expire, cancel (сторно продажи), correction;
--                                amount_kop – модуль суммы события, branch_id – где событие (погашение – филиал сеанса).
-- Права – как 0406: у yu_app только SELECT, yu_reports – SELECT (роль создаёт скрипт кластера).

-- migrate:up
CREATE VIEW app.rpt_finance_operations AS
SELECT fo.id AS operation_id, fo.number, fo.branch_id, fo.kind, fo.place,
       coalesce(o.method, fo.method) AS method, fo.direction, fo.amount_kop,
       CASE WHEN fo.kind = 'reversal' THEN -fo.amount_kop ELSE fo.amount_kop END AS signed_kop,
       CASE fo.direction WHEN 'in' THEN fo.amount_kop ELSE -fo.amount_kop END AS delta_kop,
       CASE WHEN coalesce(o.kind, fo.kind) = 'place_transfer' THEN CASE fo.place WHEN 'cash' THEN 'noncash' ELSE 'cash' END END
         AS counter_place,
       coalesce(o.source, fo.source) AS source,
       coalesce(o.category_id, fo.category_id) AS category_id,
       coalesce(o.subcategory_id, fo.subcategory_id) AS subcategory_id,
       fo.ref_type, fo.ref_id, fo.comment, fo.occurred_at, fo.author_id,
       EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id) AS is_reversed,
       fo.reversal_of, coalesce(o.kind, fo.kind) AS original_kind
FROM journal.finance_operations fo
LEFT JOIN journal.finance_operations o ON o.id = fo.reversal_of;

CREATE VIEW app.rpt_payments AS
SELECT p.id AS payment_id, l.line_no, s.booking_id, s.branch_id, s.client_id, l.method, l.amount_kop, l.points_centi,
       l.certificate_id, p.recorded_at AS paid_at, p.recorded_by,
       coalesce((SELECT sum(r.amount_kop) FROM app.payment_refunds r
                 WHERE r.payment_id = p.id AND r.line_no = l.line_no AND r.outcome = 'returned'), 0)::bigint AS refunded_kop,
       p.status
FROM app.payments p
JOIN app.payment_lines l ON l.payment_id = p.id
JOIN app.payment_sessions s ON s.booking_id = p.session_id;

CREATE VIEW app.rpt_loyalty_moves AS
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

CREATE VIEW app.rpt_loyalty_balances AS
SELECT a.owner_id AS client_id, a.balance AS balance_centi,
       (a.balance - coalesce((SELECT sum(r.amount_centi) FROM app.loyalty_reserves r
                              WHERE r.client_id = a.owner_id AND r.status IN ('hold', 'booking')), 0))::bigint AS available_centi,
       (a.balance <= -5000) AS blocked
FROM app.ledger_accounts a
WHERE a.kind = 'loyalty_client' AND a.owner_type = 'client';

CREATE VIEW app.rpt_certificate_ops AS
SELECT e.id AS entry_id, c.id AS certificate_id, c.number, c.sale_branch_id,
       CASE coalesce(o.entry_type, e.entry_type)
         WHEN 'certificate.issue' THEN CASE WHEN e.entry_type = 'reversal' THEN 'cancel' ELSE 'sale' END
         WHEN 'certificate.redeem' THEN CASE WHEN e.entry_type = 'reversal' THEN 'redeem_return' ELSE 'redeem' END
         WHEN 'certificate.expire' THEN 'expire'
         ELSE 'correction' END AS op,
       abs(e.amount)::bigint AS amount_kop, e.amount AS signed_kop,
       coalesce(rd.branch_id, rr.branch_id, e.branch_id, c.sale_branch_id) AS branch_id,
       coalesce(rd.client_id, rr.client_id, CASE WHEN coalesce(o.entry_type, e.entry_type) = 'certificate.issue' THEN c.buyer_client_id END) AS client_id,
       coalesce(rd.booking_id, rr.booking_id) AS booking_id, e.author_id, e.occurred_at AS at, e.balance_after AS balance_after_kop
FROM journal.ledger_entries e
JOIN app.certificates c ON c.ledger_account_id = e.account_id
LEFT JOIN journal.ledger_entries o ON o.id = e.reversal_of
LEFT JOIN app.certificate_redemptions rd ON rd.ledger_entry_id = e.id
LEFT JOIN app.certificate_redemptions rr ON rr.return_entry_id = e.id;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_finance_operations, app.rpt_payments, app.rpt_loyalty_moves,
  app.rpt_loyalty_balances, app.rpt_certificate_ops FROM yu_app;
GRANT SELECT ON app.rpt_finance_operations, app.rpt_payments, app.rpt_loyalty_moves, app.rpt_loyalty_balances,
  app.rpt_certificate_ops TO yu_reports;
-- названия статей расходов для отчёта 3.4 (справочник finance, без денег)
GRANT SELECT ON app.finance_categories TO yu_reports;

-- migrate:down
REVOKE SELECT ON app.finance_categories FROM yu_reports;
DROP VIEW app.rpt_certificate_ops;
DROP VIEW app.rpt_loyalty_balances;
DROP VIEW app.rpt_loyalty_moves;
DROP VIEW app.rpt_payments;
DROP VIEW app.rpt_finance_operations;
