-- 0425_rpt_gift_ops: подарок имениннику в отчёте «Сертификаты» (K24 §3.8, 14 §11: «учитывается отдельно как право на услугу, а не
-- денежный сертификат»; K20 §8). В 0311 представления подарков нет (rpt_events – только мероприятия), 0311 и 0415 не меняются.
-- Владелец – модуль events, как 0311; reports читает только rpt_* (ADR 0002 п.1). GRANT yu_reports – здесь же (D4-23).
--   app.rpt_gift_ops – событие подарка строкой, итог = Σ детализации (K24 §2, TC-20):
--     issue  – выдача: issued_at, филиал выдачи; выданные позже отменённые остаются выданными в своём периоде;
--     use    – использован: живая запись gift_uses в статусе used (после visit.confirmed; visit.reverted возвращает в booked –
--              строки нет), момент – changed_at, филиал – филиал брони (подарок используется в любом филиале сети, Q-114);
--     expire – сгорел: статус expired, момент – начало суток после valid_until по зоне филиала выдачи (последний день включительно).
--   entry_id – md5(gift_id|op)::uuid: ключ строки детализации (курсор).

-- migrate:up
CREATE VIEW app.rpt_gift_ops AS
SELECT md5(g.id::text || '|issue')::uuid AS entry_id, g.id AS gift_id, g.number, 'issue'::text AS op,
       g.issue_branch_id AS branch_id, g.issue_branch_id, g.client_id, NULL::uuid AS booking_id, g.issued_by AS author_id, g.issued_at AS at, g.status
FROM app.birthday_gifts g
UNION ALL
SELECT md5(g.id::text || '|use')::uuid, g.id, g.number, 'use', bk.branch_id, g.issue_branch_id, g.client_id, u.booking_id, NULL::uuid, u.changed_at, g.status
FROM app.birthday_gifts g
JOIN app.gift_uses u ON u.gift_id = g.id AND u.status = 'used'
JOIN app.bookings bk ON bk.id = u.booking_id
UNION ALL
SELECT md5(g.id::text || '|expire')::uuid, g.id, g.number, 'expire', g.issue_branch_id, g.issue_branch_id, g.client_id, NULL::uuid, NULL::uuid,
       ((g.valid_until + 1)::timestamp AT TIME ZONE b.timezone), g.status
FROM app.birthday_gifts g
JOIN app.branches b ON b.id = g.issue_branch_id
WHERE g.status = 'expired';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_gift_ops FROM yu_app;
GRANT SELECT ON app.rpt_gift_ops TO yu_reports;

-- migrate:down
DROP VIEW app.rpt_gift_ops;
