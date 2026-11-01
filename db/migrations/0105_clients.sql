-- 0105_clients: карточка клиента, согласия, настройки уведомлений (K9, model-dannyh §0105, 03 §3–4, §10, §13).
-- Модуль-владелец – clients. Одна карточка на телефон (UNIQUE); телефон NULL – только у обезличенной (152-ФЗ).
-- Время пишет приложение из Clock ($now); DEFAULT now() – страховка для ручных вставок.
-- journal.client_consents – только вставка: согласие и отказ – отдельные записи с версией текста и временем.

-- migrate:up
CREATE TABLE app.clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164          text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  phone_verified_at   timestamptz,
  first_name          text,
  last_name           text,
  email               text CHECK (email = lower(email)),
  birth_date          date,
  status              text NOT NULL DEFAULT 'guest'
    CHECK (status IN ('guest','active','restricted','blocked','deletion_requested','anonymized')),
  status_reason       text,
  status_until        timestamptz,
  registration_source text CHECK (registration_source IN ('site','crm')),
  registered_at       timestamptz,
  last_login_at       timestamptz,
  last_activity_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_type     text NOT NULL CHECK (created_by_type IN ('staff','client','system')),
  created_by_id       uuid,
  row_version         int NOT NULL DEFAULT 1,
  CHECK (phone_e164 IS NOT NULL OR status = 'anonymized'),
  CHECK (status <> 'guest' OR registered_at IS NULL)
);
CREATE INDEX clients_name_idx ON app.clients (lower(last_name), lower(first_name));
-- Порядок списка CRM и курсор (фамилия, имя, id): то же выражение, что в searchClients.
CREATE INDEX clients_order_idx ON app.clients (lower(coalesce(last_name, '')), lower(coalesce(first_name, '')), id);
-- Поиск CRM (03 §14): по началу фамилии/имени, по последним 4 цифрам телефона, по email.
CREATE INDEX clients_last_name_prefix_idx ON app.clients (lower(last_name) text_pattern_ops);
CREATE INDEX clients_first_name_prefix_idx ON app.clients (lower(first_name) text_pattern_ops);
CREATE INDEX clients_phone_last4_idx ON app.clients (right(phone_e164, 4));
CREATE INDEX clients_email_idx ON app.clients (email) WHERE email IS NOT NULL;

CREATE TABLE journal.client_consents (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id        uuid NOT NULL REFERENCES app.clients(id),
  kind             text NOT NULL CHECK (kind IN ('pd_processing','marketing','reminders')),
  granted          boolean NOT NULL,
  document_version text,
  source           text NOT NULL CHECK (source IN ('site','account','crm')),
  at               timestamptz NOT NULL DEFAULT now(),
  actor_type       text NOT NULL CHECK (actor_type IN ('staff','client','system')),
  actor_id         uuid,
  CHECK (kind <> 'pd_processing' OR NOT granted OR document_version IS NOT NULL)
);
CREATE INDEX client_consents_client_idx ON journal.client_consents (client_id, kind, at);
SELECT journal.make_append_only('journal.client_consents');

CREATE TABLE app.client_notification_prefs (
  client_id         uuid PRIMARY KEY REFERENCES app.clients(id),
  reminders_enabled boolean NOT NULL DEFAULT true,
  marketing_enabled boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- migrate:down
DROP TABLE app.client_notification_prefs;
DROP TABLE journal.client_consents;
DROP TABLE app.clients;
