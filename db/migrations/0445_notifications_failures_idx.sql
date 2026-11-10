-- 0445_notifications_failures_idx: счётчик сбоев критичных уведомлений для рабочего стола Владельца (K21 §9, K24 §4; S4-80).
-- Владелец – модуль notifications (0111, 0401). Рабочий стол считает сервисные строки со статусом error за период
-- без сделанного повтора: частичный индекс по ошибкам (их мало против всех строк) и индекс по retry_of (проверка
-- «повтор уже был» – иначе каждая ошибка просматривала бы всю таблицу; ручной повтор тоже считает строки retry_of).

-- migrate:up
CREATE INDEX notifications_service_error_idx ON app.notifications (planned_at) WHERE category = 'service' AND status = 'error';
CREATE INDEX notifications_retry_of_idx ON app.notifications (retry_of) WHERE retry_of IS NOT NULL;

-- migrate:down
DROP INDEX app.notifications_retry_of_idx;
DROP INDEX app.notifications_service_error_idx;
