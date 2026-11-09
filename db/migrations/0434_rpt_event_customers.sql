-- 0434_rpt_event_customers: заказчик мероприятия для глобального поиска CRM (K24 §5, S4-79). Поиск находил мероприятие по заказчику
-- только среди клиентов с бронью в зоне: заказчик без брони и телефон «+7 …» не находились. Поля заказчика лежат в app.events,
-- а reports читает только rpt_* (ADR 0002 п.1), поэтому – отдельное представление. Владелец – модуль events, как 0311.
-- ПДн (имя, телефон): yu_reports прав НЕ получает (K24 §6) – поиск идёт основным пулом (yu_app), зону задаёт окно филиалов в search.ts.
--   app.rpt_event_customers – строка на мероприятие: event_id, branch_id, customer_name, customer_phone_e164 (E.164, CHECK в 0305).

-- migrate:up
CREATE VIEW app.rpt_event_customers AS
SELECT e.id AS event_id, e.branch_id, e.customer_name, e.customer_phone_e164
FROM app.events e;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_event_customers FROM yu_app;
REVOKE ALL ON app.rpt_event_customers FROM yu_reports;

-- migrate:down
DROP VIEW app.rpt_event_customers;
