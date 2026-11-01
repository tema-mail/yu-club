-- 0111_notifications: подписки Web Push, плановые и отправленные уведомления, журнал попыток (K14, K9, model-dannyh §0111, 09 §6, §9–10).
-- Модуль-владелец – notifications. Канал один – Web Push (VAPID, Q-30); SMS и почту не подключаем (09 §2, §15).
-- Настройки клиента «Напоминания»/«Реклама» и согласия – уже в 0105 (client_notification_prefs, journal.client_consents).
-- endpoint подписки – персональные данные (адрес конкретного браузера, 152-ФЗ): в аудит и логи идёт только маска (хост),
-- ключи p256dh/auth – секреты (K2 SECRET_KEYS). Удаление клиента (обезличивание) гасит подписки тем же модулем.
-- booking_id пока без FK: таблица броней – 0101–0104 потока брони; ссылка добавится отдельной миграцией после схода С3.
-- Время пишет приложение из Clock ($now); DEFAULT now() – страховка для ручных вставок.

-- migrate:up
CREATE TABLE app.push_subscriptions (            -- Web Push (Q-30)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES app.clients(id),
  session_id      uuid REFERENCES app.client_sessions(id),   -- сессия ЛК, из которой подписались: выход гасит подписки этой сессии (K9 №3)
  endpoint        text NOT NULL UNIQUE CHECK (endpoint ~ '^https?://' AND length(endpoint) <= 2048),
  p256dh          text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{86,88}$'),   -- 65 байт base64url
  auth            text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{22,24}$'),     -- 16 байт base64url
  user_agent      text CHECK (length(user_agent) <= 512),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoke_reason   text CHECK (revoke_reason IN ('unsubscribed','gone','logout')),
  last_success_at timestamptz,
  last_error      text CHECK (length(last_error) <= 200),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX push_subscriptions_client_idx ON app.push_subscriptions (client_id) WHERE revoked_at IS NULL;
CREATE INDEX push_subscriptions_session_idx ON app.push_subscriptions (session_id) WHERE revoked_at IS NULL;

CREATE TABLE app.notifications (                 -- 09 §9: одна строка – одно сообщение клиенту; она же журнал статусов
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES app.clients(id),
  branch_id       uuid REFERENCES app.branches(id),
  category        text NOT NULL CHECK (category IN ('service','reminder','marketing','event_cancel','personal')),   -- 09 §3
  kind            text NOT NULL CHECK (kind IN ('booking_confirmed','booking_cancelled','booking_rescheduled',
                                                'reminder_day_before','reminder_before_start','campaign')),
  booking_id      uuid,                          -- FK на app.bookings – после 0101–0104 (см. шапку)
  booking_version int,
  source          text NOT NULL CHECK (source IN ('system','staff')),
  initiator_id    uuid,
  title           text NOT NULL CHECK (length(title) <= 120),
  body            text NOT NULL CHECK (length(body) <= 500),
  url             text CHECK (url ~ '^/'),       -- только путь на своём сайте
  planned_at      timestamptz NOT NULL,
  not_after       timestamptz,                   -- позже не шлём: начало сеанса для напоминаний (09 §6.2)
  status          text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned','queued','sending','sent_to_provider','delivered','error','cancelled',
    'skipped_by_prefs','skipped_booking_changed','no_channel')),       -- 'delivered' не ставим без подтверждения (09 §9)
  attempts        smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at        timestamptz,                   -- следующая попытка после временной ошибки провайдера (09 §10)
  sent_at         timestamptz,
  error           text CHECK (length(error) <= 200),
  skip_reason     text CHECK (length(skip_reason) <= 64),
  dedupe_key      text NOT NULL UNIQUE,          -- '<kind>:<booking_id>:<booking_version>' – один этап на версию (09 §6.4 п.7)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (category <> 'reminder' OR booking_id IS NOT NULL),
  CHECK (status <> 'sent_to_provider' OR sent_at IS NOT NULL)
);
CREATE INDEX notifications_due_idx ON app.notifications ((coalesce(retry_at, planned_at))) WHERE status = 'planned';
CREATE INDEX notifications_booking_idx ON app.notifications (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX notifications_client_idx ON app.notifications (client_id, created_at DESC);

-- Попытка доставки на одну подписку: ответ push-сервиса. Только вставка – это журнал (04 §11.4).
CREATE TABLE journal.notification_deliveries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES app.notifications(id),
  subscription_id uuid NOT NULL REFERENCES app.push_subscriptions(id),
  attempt         smallint NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('accepted','gone','retryable','rejected','timeout')),
  http_status     smallint,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_notification_idx ON journal.notification_deliveries (notification_id);
SELECT journal.make_append_only('journal.notification_deliveries');

-- migrate:down
DROP TABLE journal.notification_deliveries;
DROP TABLE app.notifications;
DROP TABLE app.push_subscriptions;
