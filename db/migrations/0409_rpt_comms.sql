-- 0409_rpt_comms: представления отчёта «Уведомления и публикации» (K24 §1, §3.11, §13; шаг S4-74, план 6.6).
-- Владельцы (формулу меняет только владелец, как 0211):
--   app.rpt_notifications    – notifications (K21): уведомление без текста и без клиента; read_at – прочтение в центре уведомлений;
--   app.rpt_consent_changes  – clients (K9): запись журнала согласий на рекламу; client_id – для области директора и маски в детализации;
--   app.rpt_content_versions – content (K22): публикация версии, type – вид публикации или сущность; branch_ids – филиалы охвата, NULL – вся сеть
--                              (город раскрыт в филиалы на момент запроса; нужно только для области директора, TC-16).
-- Права сама выдаёт эта миграция (D4-23): у yu_app только SELECT, yu_reports – SELECT.

-- migrate:up
CREATE VIEW app.rpt_notifications AS
SELECT n.id AS notification_id, n.branch_id, n.category, n.kind, n.source, n.campaign_id, n.status, n.created_at, n.sent_at, n.read_at
FROM app.notifications n;

CREATE VIEW app.rpt_consent_changes AS
SELECT c.id AS consent_id, c.client_id, c.granted, c.at, c.source
FROM journal.client_consents c
WHERE c.kind = 'marketing';

CREATE VIEW app.rpt_content_versions AS
WITH city_branches AS (
  SELECT city_id, array_agg(id) AS ids FROM app.branches GROUP BY city_id
), publication_scopes AS (
  SELECT s.publication_id,
         min(CASE s.scope_type WHEN 'network' THEN 1 WHEN 'city' THEN 2 ELSE 3 END) AS level,
         array_agg(x.branch_id) FILTER (WHERE x.branch_id IS NOT NULL) AS ids
  FROM app.content_publication_scopes s
  LEFT JOIN LATERAL (
    SELECT s.branch_id WHERE s.scope_type = 'branch'
    UNION ALL
    SELECT unnest(cb.ids) FROM city_branches cb WHERE s.scope_type = 'city' AND cb.city_id = s.city_id
  ) x ON true
  GROUP BY s.publication_id
)
SELECT v.id AS version_id, v.entity_type, v.entity_id, coalesce(p.type, v.entity_type) AS type, v.version_no, v.published_at,
       CASE
         WHEN v.entity_type = 'publication' THEN CASE ps.level WHEN 1 THEN 'network' WHEN 2 THEN 'city' WHEN 3 THEN 'branch' ELSE 'network' END
         WHEN v.entity_type IN ('room_page', 'branch_page') THEN 'branch'
         WHEN coalesce(cp.city_id, hb.city_id) IS NOT NULL THEN 'city'
         ELSE 'network'
       END AS scope_type,
       CASE
         WHEN v.entity_type = 'publication' THEN CASE WHEN ps.level = 1 THEN NULL ELSE ps.ids END
         WHEN v.entity_type = 'room_page' THEN ARRAY[r.branch_id]
         WHEN v.entity_type = 'branch_page' THEN ARRAY[bp.branch_id]
         ELSE cb.ids
       END AS branch_ids
FROM journal.content_versions v
LEFT JOIN app.content_publications p ON v.entity_type = 'publication' AND p.id = v.entity_id
LEFT JOIN publication_scopes ps ON v.entity_type = 'publication' AND ps.publication_id = v.entity_id
LEFT JOIN app.content_room_pages rp ON v.entity_type = 'room_page' AND rp.id = v.entity_id
LEFT JOIN app.rooms r ON r.id = rp.room_id
LEFT JOIN app.content_branch_pages bp ON v.entity_type = 'branch_page' AND bp.id = v.entity_id
LEFT JOIN app.content_pages cp ON v.entity_type = 'content_page' AND cp.id = v.entity_id
LEFT JOIN app.content_home_blocks hb ON v.entity_type = 'home_block' AND hb.id = v.entity_id
LEFT JOIN city_branches cb ON cb.city_id = coalesce(cp.city_id, hb.city_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_notifications, app.rpt_consent_changes, app.rpt_content_versions FROM yu_app;
GRANT SELECT ON app.rpt_notifications, app.rpt_consent_changes, app.rpt_content_versions TO yu_reports;

-- migrate:down
DROP VIEW app.rpt_content_versions;
DROP VIEW app.rpt_consent_changes;
DROP VIEW app.rpt_notifications;
