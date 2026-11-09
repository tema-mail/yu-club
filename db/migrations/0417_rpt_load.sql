-- 0417_rpt_load: нагрузка отчётов (S4-131, K24 §9). Формулы представлений не меняются – только план запросов.
-- 1) app.rpt_finance_operations (владелец finance, K17, 0407). EXPLAIN (ANALYZE, BUFFERS) на синтетике Q-93 (1 млн операций кассы): app.rpt_finance_operations соединяло КАЖДУЮ операцию
-- с исходной (LEFT JOIN по reversal_of), и планировщик строил хэш всей journal.finance_operations (Seq Scan 1 млн строк,
-- 31 МБ, temp-файлы) в любом запросе – даже в итоге за месяц одного филиала. Исходная нужна только сторно (reversal_of NOT NULL),
-- поэтому представление – UNION ALL двух ветвей: обычная операция (свои поля) и сторно, соединённое с исходной по первичному
-- ключу. Строки, колонки, их порядок и значения те же (CHECK 0202: kind = 'reversal' ⇔ reversal_of IS NOT NULL, FK – исходная
-- есть всегда, поэтому LEFT JOIN = JOIN). Отбор по филиалу и дате уходит внутрь обеих ветвей.
-- Индекс под остаток места денег (finance.ts placeBalances, «остаток(t) = Σ операций до t», K24 §3.4): покрывающий – остаток
-- считается по индексу без чтения таблицы. Сторно и переводы – редкие строки, их ветвь читает таблицу по ключу.
-- 2) app.clients (владелец clients): rpt_visits и rpt_bookings отдают client_kind выражением CASE по clients.status, и условие
-- client_kind = 'profile' планировщик без статистики оценивал в 0,5% строк (100 из 20 000): выбирал вложенные циклы по всей
-- истории посещений (1,6 с на «уникальных посетителей» месяца). Статистика по самому выражению даёт верную оценку.
-- 3) app.bookings (владелец booking): rpt_visits и rpt_no_shows фильтруются по плановому началу брони (lower(period)), а филиал
-- берут у посещения – индекс 0406 (branch_id, lower(period)) им не подходит, и каждый показатель посещаемости делал полный
-- просмотр bookings (+42 seq_scan на дашборд). Индекс по одному началу брони даёт выборку периода по индексу. Индекс по одной дате
-- создания – детализации «создано» по всей сети (экспорт 100 000 строк): страница идёт по дате от курсора, а не сортирует весь период.
-- 0406, 0407 не правятся: раннер сверяет контрольные суммы. Права – как в 0407.

-- migrate:up
CREATE OR REPLACE VIEW app.rpt_finance_operations AS
SELECT fo.id AS operation_id, fo.number, fo.branch_id, fo.kind, fo.place,
       fo.method, fo.direction, fo.amount_kop,
       fo.amount_kop AS signed_kop,
       CASE fo.direction WHEN 'in' THEN fo.amount_kop ELSE -fo.amount_kop END AS delta_kop,
       CASE WHEN fo.kind = 'place_transfer' THEN CASE fo.place WHEN 'cash' THEN 'noncash' ELSE 'cash' END END AS counter_place,
       fo.source, fo.category_id, fo.subcategory_id,
       fo.ref_type, fo.ref_id, fo.comment, fo.occurred_at, fo.author_id,
       EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id) AS is_reversed,
       fo.reversal_of, fo.kind AS original_kind
FROM journal.finance_operations fo
WHERE fo.reversal_of IS NULL
UNION ALL
SELECT fo.id, fo.number, fo.branch_id, fo.kind, fo.place,
       coalesce(o.method, fo.method), fo.direction, fo.amount_kop,
       -fo.amount_kop,
       CASE fo.direction WHEN 'in' THEN fo.amount_kop ELSE -fo.amount_kop END,
       CASE WHEN o.kind = 'place_transfer' THEN CASE fo.place WHEN 'cash' THEN 'noncash' ELSE 'cash' END END,
       coalesce(o.source, fo.source), coalesce(o.category_id, fo.category_id), coalesce(o.subcategory_id, fo.subcategory_id),
       fo.ref_type, fo.ref_id, fo.comment, fo.occurred_at, fo.author_id,
       EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id),
       fo.reversal_of, o.kind
FROM journal.finance_operations fo
JOIN journal.finance_operations o ON o.id = fo.reversal_of
WHERE fo.reversal_of IS NOT NULL;

CREATE INDEX finance_operations_place_balance_idx ON journal.finance_operations (branch_id, occurred_at)
  INCLUDE (place, direction, amount_kop, kind) WHERE reversal_of IS NULL;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_finance_operations FROM yu_app;
GRANT SELECT ON app.rpt_finance_operations TO yu_reports;

CREATE STATISTICS app.clients_kind_stx ON ((CASE WHEN status = 'guest' THEN 'guest' ELSE 'profile' END)) FROM app.clients;
ANALYZE app.clients;

CREATE INDEX bookings_start_idx ON app.bookings (lower(period));
CREATE INDEX bookings_created_idx ON app.bookings (created_at);

-- migrate:down
DROP INDEX app.bookings_created_idx;
DROP INDEX app.bookings_start_idx;
DROP STATISTICS app.clients_kind_stx;
DROP INDEX journal.finance_operations_place_balance_idx;
CREATE OR REPLACE VIEW app.rpt_finance_operations AS
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

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_finance_operations FROM yu_app;
GRANT SELECT ON app.rpt_finance_operations TO yu_reports;
