-- 0208_booking_hold_points: представления booking для резерва баллов (K15 §3, ADR 0002 п.1 – чужие таблицы только
-- через модуль-владелец). Модуль-владелец – booking; loyalty читает только эти представления, не holds/hold_items/resources.
-- booking_hold_points – удержание и подпись его позиций: sha256 отсортированных id позиций 'active' (для подтверждённого
-- удержания – 'converted': те же позиции, перешедшие в брони). Подпись меняют добавление, удаление позиции и отказ;
-- перезапуск таймера (expires_at) – нет. Формулу подписи держит booking.
-- booking_hold_point_items – активные позиции удержания: минуты и тип ресурса (резерв = Σ минут × 100, 07 §6.1).

-- migrate:up
CREATE VIEW app.booking_hold_points AS
SELECT h.id AS hold_id, h.client_id, h.branch_id, h.status, h.expires_at,
       (SELECT encode(sha256(convert_to(coalesce(string_agg(hi.id::text, ',' ORDER BY hi.id), ''), 'UTF8')), 'hex')
        FROM app.hold_items hi
        WHERE hi.hold_id = h.id AND hi.status = CASE WHEN h.status = 'converted' THEN 'converted' ELSE 'active' END) AS items_signature
FROM app.holds h;

CREATE VIEW app.booking_hold_point_items AS
SELECT hi.hold_id, hi.id AS item_id, (extract(epoch FROM upper(hi.period) - lower(hi.period)) / 60)::int AS minutes, r.resource_type
FROM app.hold_items hi JOIN app.resources r ON r.id = hi.resource_id
WHERE hi.status = 'active';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.booking_hold_points, app.booking_hold_point_items FROM yu_app;

-- migrate:down
DROP VIEW app.booking_hold_point_items;
DROP VIEW app.booking_hold_points;
