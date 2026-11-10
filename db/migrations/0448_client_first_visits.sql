-- 0448_client_first_visits: первое посещение клиента в филиале (S4-131; K24 §3.6, §9 «не уложились – агрегаты»; D5-11).
-- Владелец – booking (посещения). «Впервые пришедшие», «вернувшиеся», «повторные» и «не посещавшие в периоде» K24 §3.6 считаются
-- по истории: отчёт клиентов читал все посещения сети с началом брони (полный просмотр visits и bookings, +5 seq_scan на синтетике Q-93).
-- Здесь – строка на пару клиент × филиал: первое посещение (min начала брони живых посещений) и число живых посещений.
--   Сеть: первое посещение клиента = min по его строкам, всего посещений = сумма. Область (город, филиалы): «было до периода» =
--   первое посещение в филиале области раньше начала суток периода этого филиала. Поэтому пара, а не одна строка на клиента:
--   с одной строкой «не посещавшие в периоде» для зоны Директора опять читали бы историю посещений.
--   Пишут ТОЛЬКО триггеры (SECURITY DEFINER владельца миграций, как 0418): вставка посещений – прибавка одним шагом на оператор;
--   отмена отметки (visits.status → reverted, 0110: посещение не удаляется) и перенос брони с живым посещением – пересчёт пары из её
--   живых посещений (их у пары единицы, индекс visits_client_idx); строка агрегата блокируется до чтения посещений – параллельная
--   вставка не теряется. У yu_app прав на запись нет. Существующие посещения – одной вставкой.
--   app.rpt_client_first_visits – чтение для отчётов (yu_reports), client_kind – как у rpt_visits; права – как 0407.

-- migrate:up
CREATE TABLE app.client_first_visits (
  client_id uuid NOT NULL REFERENCES app.clients(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  first_visit_at timestamptz NOT NULL,
  visits_count integer NOT NULL CHECK (visits_count > 0),
  PRIMARY KEY (client_id, branch_id)
);
CREATE INDEX client_first_visits_branch_idx ON app.client_first_visits (branch_id, first_visit_at);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.client_first_visits FROM yu_app;

-- пересчёт одной пары из живых посещений: нет посещений – строки нет
CREATE FUNCTION app.client_first_visits_recompute(p_client uuid, p_branch uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f timestamptz;
  n integer;
BEGIN
  PERFORM 1 FROM app.client_first_visits WHERE client_id = p_client AND branch_id = p_branch FOR UPDATE;
  SELECT min(lower(b.period)), count(*) INTO f, n
  FROM app.visits v JOIN app.bookings b ON b.id = v.booking_id
  WHERE v.client_id = p_client AND v.branch_id = p_branch AND v.status = 'active';
  IF n = 0 THEN
    DELETE FROM app.client_first_visits WHERE client_id = p_client AND branch_id = p_branch;
  ELSE
    INSERT INTO app.client_first_visits AS a (client_id, branch_id, first_visit_at, visits_count) VALUES (p_client, p_branch, f, n)
      ON CONFLICT (client_id, branch_id) DO UPDATE SET first_visit_at = EXCLUDED.first_visit_at, visits_count = EXCLUDED.visits_count;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.client_first_visits_recompute(uuid, uuid) FROM PUBLIC;

-- вставка посещений: одним шагом на оператор (засев и синтетика вставляют тысячами)
CREATE FUNCTION app.client_first_visits_on_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.client_first_visits AS a (client_id, branch_id, first_visit_at, visits_count)
  SELECT i.client_id, i.branch_id, min(lower(b.period)), count(*)
  FROM ins i JOIN app.bookings b ON b.id = i.booking_id
  WHERE i.status = 'active'
  GROUP BY i.client_id, i.branch_id
  ON CONFLICT (client_id, branch_id) DO UPDATE
    SET first_visit_at = least(a.first_visit_at, EXCLUDED.first_visit_at), visits_count = a.visits_count + EXCLUDED.visits_count;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.client_first_visits_on_insert() FROM PUBLIC;

CREATE TRIGGER visits_client_first_visits AFTER INSERT ON app.visits
  REFERENCING NEW TABLE AS ins FOR EACH STATEMENT EXECUTE FUNCTION app.client_first_visits_on_insert();

-- отмена отметки (и любая смена статуса): пара пересчитывается
CREATE FUNCTION app.client_first_visits_on_visit_status() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.client_first_visits_recompute(NEW.client_id, NEW.branch_id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.client_first_visits_on_visit_status() FROM PUBLIC;

CREATE TRIGGER visits_client_first_visits_status AFTER UPDATE OF status ON app.visits
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION app.client_first_visits_on_visit_status();

-- перенос брони с живым посещением (по K5 переносится только confirmed, но дата первого посещения от этого правила не зависит)
CREATE FUNCTION app.client_first_visits_on_booking_period() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT client_id, branch_id FROM app.visits WHERE booking_id = NEW.id AND status = 'active' LOOP
    PERFORM app.client_first_visits_recompute(v.client_id, v.branch_id);
  END LOOP;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.client_first_visits_on_booking_period() FROM PUBLIC;

CREATE TRIGGER bookings_client_first_visits AFTER UPDATE OF period ON app.bookings
  FOR EACH ROW WHEN (lower(OLD.period) IS DISTINCT FROM lower(NEW.period)) EXECUTE FUNCTION app.client_first_visits_on_booking_period();

INSERT INTO app.client_first_visits (client_id, branch_id, first_visit_at, visits_count)
SELECT v.client_id, v.branch_id, min(lower(b.period)), count(*)
FROM app.visits v JOIN app.bookings b ON b.id = v.booking_id
WHERE v.status = 'active'
GROUP BY v.client_id, v.branch_id;

CREATE VIEW app.rpt_client_first_visits AS
SELECT a.client_id, a.branch_id,
       CASE WHEN c.status = 'guest' THEN 'guest' ELSE 'profile' END AS client_kind,
       a.first_visit_at, a.visits_count
FROM app.client_first_visits a
JOIN app.clients c ON c.id = a.client_id;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_client_first_visits FROM yu_app;
GRANT SELECT ON app.rpt_client_first_visits TO yu_reports;

-- migrate:down
DROP VIEW app.rpt_client_first_visits;
DROP TRIGGER bookings_client_first_visits ON app.bookings;
DROP FUNCTION app.client_first_visits_on_booking_period();
DROP TRIGGER visits_client_first_visits_status ON app.visits;
DROP FUNCTION app.client_first_visits_on_visit_status();
DROP TRIGGER visits_client_first_visits ON app.visits;
DROP FUNCTION app.client_first_visits_on_insert();
DROP FUNCTION app.client_first_visits_recompute(uuid, uuid);
DROP TABLE app.client_first_visits;
