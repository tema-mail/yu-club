-- 0209_loyalty_reserve_insufficient: причина снятия резерва 'insufficient' (K15 §3, ревизия 02.11). Модуль-владелец – loyalty.
-- Подтверждение удержания, когда доступных баллов меньше, чем нужно на все его брони: резерв удержания снимается с
-- этой причиной, а не 'hold_changed' (позиции не менялись).

-- migrate:up
ALTER TABLE app.loyalty_reserves DROP CONSTRAINT loyalty_reserves_release_reason_check;
ALTER TABLE app.loyalty_reserves ADD CONSTRAINT loyalty_reserves_release_reason_check CHECK (release_reason IN (
  'hold_expired','hold_released','hold_changed','booking_cancelled','no_show','rescheduled_short','replaced','paid_other','insufficient'));

-- migrate:down
UPDATE app.loyalty_reserves SET release_reason = 'hold_changed' WHERE release_reason = 'insufficient';
ALTER TABLE app.loyalty_reserves DROP CONSTRAINT loyalty_reserves_release_reason_check;
ALTER TABLE app.loyalty_reserves ADD CONSTRAINT loyalty_reserves_release_reason_check CHECK (release_reason IN (
  'hold_expired','hold_released','hold_changed','booking_cancelled','no_show','rescheduled_short','replaced','paid_other'));
