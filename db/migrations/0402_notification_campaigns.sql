-- 0402_notification_campaigns: шаблоны, кампании (любое ручное сообщение – кампания) и снимок получателей (K21 §5, §6, §8, §15;
-- model-dannyh «0402»). Модуль-владелец – notifications.
-- Неизменность (09 §14): после выхода из draft title, body, url, category, audience, push, purpose не меняются – триггер
-- отклоняет UPDATE с кодом 42501; правка текста – только новой кампанией.
-- Снимок аудитории при подтверждении – журнал (только вставка): новые клиенты позже не добавляются.

-- migrate:up
CREATE TABLE app.notification_templates (               -- K21 §8
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category    text NOT NULL CHECK (category IN ('service','marketing')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),   -- плейсхолдеры – белый список K21 §8, проверка в коде
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version int NOT NULL DEFAULT 1,
  created_by  uuid NOT NULL REFERENCES app.staff(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.notification_campaigns (                -- K21 §6
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','expanding','sending','done','cancelled')),
  purpose          text CHECK (length(purpose) <= 200),
  category         text NOT NULL CHECK (category IN ('service','marketing')),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  url              text CHECK (url IS NULL OR url ~ '^/([^/\\]|$)'),   -- только путь своего сайта
  push             boolean NOT NULL DEFAULT true,
  audience         jsonb NOT NULL,                       -- { kind: client|booking|event|segment, … }, segment.v1 (K21 §5)
  area_type        text NOT NULL CHECK (area_type IN ('network','city','branch')),
  area_ids         uuid[] NOT NULL DEFAULT '{}',
  planned_at       timestamptz,
  advertiser_note  text CHECK (length(advertiser_note) <= 200),
  erid             text CHECK (length(erid) <= 64),      -- 38-ФЗ ст. 18.1 (Q-130, Q-148)
  template_id      uuid REFERENCES app.notification_templates(id),
  preview_snapshot jsonb,
  preview_at       timestamptz,
  total            int CHECK (total IS NULL OR total >= 0),
  created_by       uuid NOT NULL REFERENCES app.staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_by     uuid REFERENCES app.staff(id),
  confirmed_at     timestamptz,
  cancelled_reason text CHECK (length(cancelled_reason) <= 500),
  row_version      int NOT NULL DEFAULT 1,
  CHECK (status IN ('draft','cancelled') OR confirmed_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL),
  CHECK (area_type = 'network' OR cardinality(area_ids) > 0)
);
CREATE INDEX notification_campaigns_list_idx ON app.notification_campaigns (created_at DESC, id);
CREATE INDEX notification_campaigns_active_idx ON app.notification_campaigns (status) WHERE status IN ('confirmed','expanding','sending');

CREATE FUNCTION app.notification_campaigns_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body OR NEW.url IS DISTINCT FROM OLD.url
    OR NEW.category IS DISTINCT FROM OLD.category OR NEW.audience IS DISTINCT FROM OLD.audience
    OR NEW.push IS DISTINCT FROM OLD.push OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.area_type IS DISTINCT FROM OLD.area_type OR NEW.area_ids IS DISTINCT FROM OLD.area_ids) THEN
    RAISE EXCEPTION 'кампания % подтверждена: текст и аудитория не меняются (09 §14)', OLD.id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_campaigns_frozen BEFORE UPDATE ON app.notification_campaigns
  FOR EACH ROW EXECUTE FUNCTION app.notification_campaigns_frozen();

CREATE TABLE journal.notification_campaign_recipients (  -- снимок аудитории при подтверждении (09 §14)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id    uuid NOT NULL REFERENCES app.notification_campaigns(id),
  client_id      uuid NOT NULL REFERENCES app.clients(id),
  home_branch_id uuid REFERENCES app.branches(id),       -- для тихих часов (K21 §5)
  decision       text NOT NULL CHECK (length(decision) <= 64),   -- решение decideSend на момент снимка
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, client_id)
);
SELECT journal.make_append_only('journal.notification_campaign_recipients');

ALTER TABLE app.notifications ADD CONSTRAINT notifications_campaign_fk FOREIGN KEY (campaign_id) REFERENCES app.notification_campaigns(id);
CREATE INDEX notifications_campaign_idx ON app.notifications (campaign_id, status) WHERE campaign_id IS NOT NULL;

-- migrate:down
DROP INDEX app.notifications_campaign_idx;
ALTER TABLE app.notifications DROP CONSTRAINT notifications_campaign_fk;
DROP TABLE journal.notification_campaign_recipients;
DROP TRIGGER notification_campaigns_frozen ON app.notification_campaigns;
DROP FUNCTION app.notification_campaigns_frozen();
DROP TABLE app.notification_campaigns;
DROP TABLE app.notification_templates;
