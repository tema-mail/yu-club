-- 0420_staff_feed: лента событий CRM (13 §11; model-dannyh «0411» – номер 0420, 0411 не занят, но 0417–0419 – поток отчётов; S4-28, D4-46).
-- Модуль-владелец – notifications. Push, почта и мессенджеры сотрудникам не вводятся (Q-147 по умолчанию: «на первом этапе достаточно
-- списка событий и индикаторов в CRM»). Отклонения от model-dannyh: (1) прочтение – отдельная таблица на сотрудника: строку зоны
-- филиала видят несколько человек, один read_at в строке погасил бы её всем; (2) столбец action – какое право K1 нужно, чтобы видеть
-- строку зоны (staff_id IS NULL); у адресной строки (staff_id) права не нужно – она только адресату; (3) body и occurred_at.
-- Источники: обработчики outbox shift.changed (K18 §11), repair.registered / repair.closed (K19 §11) – staff-feed.ts; ошибка
-- критичного сервисного клиенту (K21 §9) – триггер на notifications ниже: модуль notifications событий не публикует (K4), а статус
-- error / no_channel ставят несколько путей отправителя – триггер ловит все и пишет в той же транзакции.

-- migrate:up
CREATE TABLE app.staff_feed_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES app.branches(id),
  staff_id    uuid REFERENCES app.staff(id),                 -- адресат; NULL – все сотрудники с правом action в зоне филиала
  action      text CHECK (action IN ('equipment.view','notifications.view')),
  kind        text NOT NULL CHECK (kind IN ('shift_changed','repair_registered','repair_closed','service_notification_failed')),
  ref_type    text NOT NULL CHECK (ref_type IN ('shift','repair','client')),   -- объект для перехода в карточку
  ref_id      uuid NOT NULL,
  title       text NOT NULL CHECK (length(title) <= 200),
  body        text CHECK (length(body) <= 500),
  dedupe_key  text NOT NULL UNIQUE,                          -- '<kind>:<eventId>' – двойная доставка события → одна строка
  occurred_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_feed_events_audience CHECK ((staff_id IS NULL) <> (action IS NULL))
);
CREATE INDEX staff_feed_events_branch_idx ON app.staff_feed_events (branch_id, occurred_at DESC, id);
CREATE INDEX staff_feed_events_staff_idx ON app.staff_feed_events (staff_id, occurred_at DESC, id) WHERE staff_id IS NOT NULL;
CREATE INDEX staff_feed_events_ref_idx ON app.staff_feed_events (ref_type, ref_id);

CREATE TABLE app.staff_feed_reads (                          -- прочтение строки ленты сотрудником (статус обработки, 13 §11)
  event_id uuid NOT NULL REFERENCES app.staff_feed_events(id),
  staff_id uuid NOT NULL REFERENCES app.staff(id),
  read_at  timestamptz NOT NULL,
  PRIMARY KEY (staff_id, event_id)
);
-- лента только на вставку: приложение читает и добавляет, правка и удаление – нет (как 0404, 0408)
REVOKE UPDATE, DELETE, TRUNCATE ON app.staff_feed_events, app.staff_feed_reads FROM yu_app;

-- Критичное сервисное (09 §5 табл., §7: отмена и изменение записи или мероприятия) не дошло: error или no_channel при push.
-- Один раз на строку уведомления; ручной повтор (retry_of) – новая строка и, если снова не дошёл, своя запись ленты.
CREATE FUNCTION app.staff_feed_notification_failed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.staff_feed_events (branch_id, action, kind, ref_type, ref_id, title, body, dedupe_key, occurred_at, created_at)
  VALUES (NEW.branch_id, 'notifications.view', 'service_notification_failed', 'client', NEW.client_id,
    left('Клиент не получил: ' || NEW.title, 200),
    CASE WHEN NEW.status = 'no_channel' THEN 'Нет канала push – сообщите клиенту по телефону' ELSE 'Ошибка отправки – повторите из журнала или позвоните клиенту' END,
    'service_notification_failed:' || NEW.id, NEW.updated_at, NEW.updated_at)
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_staff_feed_failed AFTER UPDATE OF status ON app.notifications
  FOR EACH ROW WHEN (NEW.status IN ('error','no_channel') AND OLD.status IS DISTINCT FROM NEW.status AND NEW.category = 'service' AND NEW.push
    AND NEW.branch_id IS NOT NULL AND NEW.kind IN ('booking_cancelled','booking_rescheduled','event_cancelled','event_rescheduled'))
  EXECUTE FUNCTION app.staff_feed_notification_failed();

-- migrate:down
DROP TRIGGER notifications_staff_feed_failed ON app.notifications;
DROP FUNCTION app.staff_feed_notification_failed();
DROP TABLE app.staff_feed_reads;
DROP TABLE app.staff_feed_events;
