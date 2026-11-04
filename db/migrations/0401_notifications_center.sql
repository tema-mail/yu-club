-- 0401_notifications_center: центр уведомлений в ЛК и подготовка рассылок Э4 (K21 §2–§4, §7, §15; model-dannyh «0401»; D4-03).
-- Модуль-владелец – notifications. Категории сокращаются до service / reminder / marketing: «личное» и «отмена мероприятия» –
-- виды (kind), политика согласия идёт от категории (09 §3.5). Новые статусы: skipped_by_frequency (частота рекламы),
-- inbox_only (сообщение только в центр, push = false). read_at – прочтение в центре (09 §11).
-- 38-ФЗ ст. 18: согласие на рекламу – только с версией текста документа (CHECK в journal.client_consents, NOT VALID + VALIDATE).
-- Отложенный FK notifications.booking_id → bookings из model-dannyh здесь НЕ добавляется: тесты K14 Э1 пишут строки
-- с выдуманной бронью (фейковый BookingLookup) – FK потребует их переписать; отдельный шаг (отклонение S4-10, см. отчёт).

-- migrate:up
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.notifications WHERE category IN ('event_cancel','personal')) THEN
    RAISE EXCEPTION '0401: есть строки notifications с категорией event_cancel/personal – перенесите их в kind до миграции';
  END IF;
END $$;

ALTER TABLE app.notifications
  ADD COLUMN read_at     timestamptz,
  ADD COLUMN push        boolean NOT NULL DEFAULT true,
  ADD COLUMN campaign_id uuid,                                    -- FK – в 0402
  ADD COLUMN retry_of    uuid REFERENCES app.notifications(id),   -- ручной повтор (K21 §9)
  ADD COLUMN purpose     text CHECK (length(purpose) <= 200);     -- назначение личного (09 §3.5)

ALTER TABLE app.notifications DROP CONSTRAINT notifications_category_check,
  ADD CONSTRAINT notifications_category_check CHECK (category IN ('service','reminder','marketing'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('booking_confirmed','booking_cancelled','booking_rescheduled',
    'reminder_day_before','reminder_before_start','personal','campaign','event_cancelled','event_rescheduled','account_event'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_status_check,
  ADD CONSTRAINT notifications_status_check CHECK (status IN ('planned','queued','sending','sent_to_provider','delivered','error',
    'cancelled','skipped_by_prefs','skipped_booking_changed','no_channel','skipped_by_frequency','inbox_only'));
ALTER TABLE app.notifications ADD CONSTRAINT notifications_push_or_inbox CHECK (push OR status IN ('inbox_only','cancelled'));

CREATE INDEX notifications_inbox_idx ON app.notifications (client_id, (coalesce(sent_at, planned_at)) DESC, id)
  WHERE status IN ('sent_to_provider','no_channel','error','inbox_only');
CREATE INDEX notifications_unread_idx ON app.notifications (client_id)
  WHERE read_at IS NULL AND status IN ('sent_to_provider','no_channel','error','inbox_only');
CREATE INDEX notifications_marketing_recent_idx ON app.notifications (client_id, sent_at DESC)
  WHERE category = 'marketing' AND status IN ('sent_to_provider','sending');

ALTER TABLE journal.client_consents ADD CONSTRAINT client_consents_marketing_version
  CHECK (kind <> 'marketing' OR NOT granted OR document_version IS NOT NULL) NOT VALID;
ALTER TABLE journal.client_consents VALIDATE CONSTRAINT client_consents_marketing_version;

-- migrate:down
-- Откат только на пустом Э4: строки новых видов и статусов не проходят прежние CHECK – миграция падает (K21 §15).
ALTER TABLE journal.client_consents DROP CONSTRAINT client_consents_marketing_version;
DROP INDEX app.notifications_marketing_recent_idx;
DROP INDEX app.notifications_unread_idx;
DROP INDEX app.notifications_inbox_idx;
ALTER TABLE app.notifications DROP CONSTRAINT notifications_push_or_inbox;
ALTER TABLE app.notifications DROP CONSTRAINT notifications_status_check,
  ADD CONSTRAINT notifications_status_check CHECK (status IN (
    'planned','queued','sending','sent_to_provider','delivered','error','cancelled',
    'skipped_by_prefs','skipped_booking_changed','no_channel'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('booking_confirmed','booking_cancelled','booking_rescheduled',
    'reminder_day_before','reminder_before_start','campaign'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_category_check,
  ADD CONSTRAINT notifications_category_check CHECK (category IN ('service','reminder','marketing','event_cancel','personal'));
ALTER TABLE app.notifications
  DROP COLUMN purpose,
  DROP COLUMN retry_of,
  DROP COLUMN campaign_id,
  DROP COLUMN push,
  DROP COLUMN read_at;
