-- 0406_rpt_ops: представления отчётов по броням, ресурсам и клиентам (K24 §1, §13; шаг S4-60, план 6.6).
-- Как 0211: модуль reports читает чужие данные только через представления rpt_*, которые принадлежат модулю-владельцу;
-- формулу меняет только владелец:
--   app.rpt_bookings            – booking: бронь (текущая версия), инициатор отмены из статуса, «ожидают решения» (K11 №3);
--   app.rpt_booking_reschedules – booking: версия брони ≥ 2 (перенос) с прежним и новым началом;
--   app.rpt_visits              – booking: живое посещение (status = 'active') с плановым временем брони (Q-40);
--   app.rpt_no_shows            – booking: живая неявка;
--   app.rpt_unit_booked         – booking: активная строка занятости брони по единице; whole_room – бронь составной
--                                 конфигурации (больше одной единицы в текущей версии, «комната целиком»);
--   app.rpt_unit_blocks         – booking: активная блокировка по единице, kind – по коду причины;
--   app.rpt_units               – resources: единица занятости и её «собственный» ресурс (состав ровно из этой единицы) с
--                                 периодом действия valid_period: строка на каждый состав, включая закрытые и архивные
--                                 (история не переписывается, D4-20); единица без своего ресурса (PS4 в VR-комнате) –
--                                 resource_id NULL, valid_period NULL, self_bookable = false;
--   app.rpt_clients             – clients: клиент без телефона и имени (ПДн – только через clients/index.ts с маской K24 §6).
-- Колонки начала и конца брони – start_at/end_at (end – зарезервированное слово SQL; в K24 §1 – start, end).
-- Роль yu_reports (пул отчётов K24 §9) создаёт скрипт кластера (deploy/initdb/01-roles.sh, deploy.sh; в тестах – globalSetup)
-- вместе с default_transaction_read_only = on – миграция её не создаёт (ADR 0001, как yu_app) и выдаёт только SELECT
-- на rpt_* и таблицы календаря network (openIntervalsRange, K24 §3.3). У yu_app на rpt_* – только SELECT (простые
-- представления в PostgreSQL обновляемы, поэтому запись отзывается явно, как в 0211).

-- migrate:up
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yu_reports') THEN
    RAISE EXCEPTION 'Нет роли yu_reports: её создаёт скрипт инициализации кластера до миграций';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO yu_reports', current_database());
END
$$;
GRANT USAGE ON SCHEMA app TO yu_reports;

-- индексы владельцев под отчёты (K24 §1): период – по дате события
CREATE INDEX bookings_branch_created_idx ON app.bookings (branch_id, created_at);
CREATE INDEX bookings_branch_start_idx ON app.bookings (branch_id, lower(period));
CREATE INDEX visits_branch_arrived_idx ON app.visits (branch_id, arrived_at) WHERE status = 'active';
CREATE INDEX no_shows_branch_marked_idx ON app.no_shows (branch_id, marked_at) WHERE status = 'active';
CREATE INDEX booking_versions_created_idx ON journal.booking_versions (created_at) WHERE version >= 2;

CREATE VIEW app.rpt_bookings AS
SELECT b.id AS booking_id, b.number, b.branch_id, br.city_id, b.client_id,
       CASE WHEN c.status = 'guest' THEN 'guest' ELSE 'profile' END AS client_kind,
       b.resource_id, r.resource_type, r.name AS resource_name, r.room_id,
       lower(b.period) AS start_at, upper(b.period) AS end_at,
       (extract(epoch FROM upper(b.period) - lower(b.period)) / 60)::int AS minutes,
       b.status, b.created_at, b.source, b.price_kop, b.cancelled_at,
       CASE b.status WHEN 'cancelled_by_client' THEN 'client' WHEN 'cancelled_by_club' THEN 'club' END AS cancelled_by,
       dr.code AS cancel_reason_code, b.current_version AS versions_count,
       (b.status = 'confirmed' AND upper(b.period) <= now()) AS needs_decision,
       b.created_by_type, b.created_by_id
FROM app.bookings b
JOIN app.branches br ON br.id = b.branch_id
JOIN app.clients c ON c.id = b.client_id
JOIN app.resources r ON r.id = b.resource_id
LEFT JOIN app.dict_reasons dr ON dr.id = b.cancel_reason_id;

CREATE VIEW app.rpt_booking_reschedules AS
SELECT v.booking_id, b.branch_id, v.version, v.created_at AS rescheduled_at,
       lower(p.period) AS old_start, lower(v.period) AS new_start
FROM journal.booking_versions v
JOIN journal.booking_versions p ON p.booking_id = v.booking_id AND p.version = v.version - 1
JOIN app.bookings b ON b.id = v.booking_id
WHERE v.version >= 2;

CREATE VIEW app.rpt_visits AS
SELECT vi.id AS visit_id, vi.booking_id, vi.branch_id, vi.client_id,
       CASE WHEN c.status = 'guest' THEN 'guest' ELSE 'profile' END AS client_kind,
       vi.arrived_at, vi.completed_at, vi.marked_by,
       lower(b.period) AS planned_start, upper(b.period) AS planned_end,
       (extract(epoch FROM upper(b.period) - lower(b.period)) / 60)::int AS planned_minutes,
       r.resource_type
FROM app.visits vi
JOIN app.bookings b ON b.id = vi.booking_id
JOIN app.clients c ON c.id = vi.client_id
JOIN app.resources r ON r.id = b.resource_id
WHERE vi.status = 'active';

CREATE VIEW app.rpt_no_shows AS
SELECT n.id AS no_show_id, n.booking_id, n.branch_id, n.client_id, lower(b.period) AS planned_start,
       n.marked_at, n.marked_by, dr.code AS reason_code
FROM app.no_shows n
JOIN app.bookings b ON b.id = n.booking_id
LEFT JOIN app.dict_reasons dr ON dr.id = n.reason_id
WHERE n.status = 'active';

CREATE VIEW app.rpt_unit_booked AS
SELECT o.unit_id, b.resource_id, u.room_id, o.branch_id, b.id AS booking_id, o.period,
       (cardinality(v.unit_ids) > 1) AS whole_room, b.status
FROM app.occupancy o
JOIN app.bookings b ON b.id = o.source_id
JOIN app.occupancy_units u ON u.id = o.unit_id
JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
WHERE o.active AND o.source_type = 'booking' AND b.status NOT IN ('cancelled_by_client', 'cancelled_by_club');

CREATE VIEW app.rpt_unit_blocks AS
SELECT bu.unit_id, bl.branch_id, bl.id AS block_id, bu.period, dr.code AS reason_code,
       CASE dr.code WHEN 'repair' THEN 'repair' WHEN 'maintenance' THEN 'maintenance'
                    WHEN 'closure' THEN 'closure' ELSE 'admin' END AS kind
FROM app.resource_block_units bu
JOIN app.resource_blocks bl ON bl.id = bu.block_id
JOIN app.dict_reasons dr ON dr.id = bl.reason_id
WHERE bu.active AND bl.status = 'active';

CREATE VIEW app.rpt_units AS
SELECT u.id AS unit_id, own.resource_id, u.room_id, u.branch_id, own.resource_type,
       coalesce(own.self_bookable, false) AS self_bookable, u.name AS unit_name, u.status, own.valid_period
FROM app.occupancy_units u
LEFT JOIN LATERAL (
  -- период, когда состав ресурса – ровно эта единица: период строки состава, до архивации ресурса, минус время с другими единицами
  SELECT x.resource_id, x.resource_type, x.self_bookable, x.valid_period
  FROM (
    SELECT r.id AS resource_id, r.resource_type, r.self_bookable,
           (tstzmultirange(tstzrange(ru.valid_from, ru.valid_to, '[)')) * tstzmultirange(tstzrange(NULL, r.archived_at, '[)')))
             - coalesce((SELECT range_agg(tstzrange(o.valid_from, o.valid_to, '[)')) FROM app.resource_units o
                         WHERE o.resource_id = ru.resource_id AND o.unit_id <> u.id), '{}'::tstzmultirange) AS valid_period
    FROM app.resource_units ru
    JOIN app.resources r ON r.id = ru.resource_id
    WHERE ru.unit_id = u.id
  ) x
  WHERE NOT isempty(x.valid_period)
) own ON true;

CREATE VIEW app.rpt_clients AS
SELECT c.id AS client_id, c.status, c.created_at, c.registered_at, c.registration_source
FROM app.clients c;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_bookings, app.rpt_booking_reschedules, app.rpt_visits, app.rpt_no_shows,
  app.rpt_unit_booked, app.rpt_unit_blocks, app.rpt_units, app.rpt_clients FROM yu_app;
GRANT SELECT ON app.rpt_bookings, app.rpt_booking_reschedules, app.rpt_visits, app.rpt_no_shows,
  app.rpt_unit_booked, app.rpt_unit_blocks, app.rpt_units, app.rpt_clients TO yu_reports;
-- таблицы календаря network – для openIntervalsRange (K24 §1: единственное исключение из правила rpt_*)
GRANT SELECT ON app.cities, app.branches, app.branch_weekly_hours, app.calendar_exceptions TO yu_reports;

-- migrate:down
REVOKE SELECT ON app.cities, app.branches, app.branch_weekly_hours, app.calendar_exceptions FROM yu_reports;
DROP VIEW app.rpt_clients;
DROP VIEW app.rpt_units;
DROP VIEW app.rpt_unit_blocks;
DROP VIEW app.rpt_unit_booked;
DROP VIEW app.rpt_no_shows;
DROP VIEW app.rpt_visits;
DROP VIEW app.rpt_booking_reschedules;
DROP VIEW app.rpt_bookings;
DROP INDEX journal.booking_versions_created_idx;
DROP INDEX app.no_shows_branch_marked_idx;
DROP INDEX app.visits_branch_arrived_idx;
DROP INDEX app.bookings_branch_start_idx;
DROP INDEX app.bookings_branch_created_idx;
REVOKE USAGE ON SCHEMA app FROM yu_reports;
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM yu_reports', current_database());
END
$$;
