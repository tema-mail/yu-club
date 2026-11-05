-- 0412_notifications_booking_fk: отложенный FK notifications.booking_id → bookings (обещан шапкой 0111, model-dannyh «0401», D4-12).
-- Вынесен из 0401: 0401 уже в main, а правка применённой миграции останавливает раннер.
-- Строк с выдуманной бронью быть не должно; нашлась на стенде – миграция падает, стенд пересоздаётся (--reset-stage).

-- migrate:up
ALTER TABLE app.notifications ADD CONSTRAINT notifications_booking_fk FOREIGN KEY (booking_id) REFERENCES app.bookings(id);

-- migrate:down
ALTER TABLE app.notifications DROP CONSTRAINT notifications_booking_fk;
