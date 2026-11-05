-- 0405_seo: история адресов и зарезервированные слаги городов (K23 §5, §9; model-dannyh 0405; шаг S4-50; код – modules/content/paths.ts).
--   app.seo_slug_history – старые слаги сущности по сегментам пути. Владелец – content: игры и публикации пишет publish, города, филиалы
--   и комнаты – обработчик событий *.slug_changed (K4 «События этапа 4»). parent_key – в пределах чего слаг уникален: филиал – city_id,
--   комната – branch_id, игра – direction, публикация – type, город – ''. Связь полиморфная – без FK (как outbox и content_media_usages).
--   cities_slug_reserved – владелец ограничения network (строка здесь, K23 §9): список = карта сайта п.2.8 + адреса Э4 media, preview,
--   unsubscribe, info. Тот же список – RESERVED_CITY_SLUGS в packages/contracts/src/paths.ts (сверяет tests/content/paths.test.ts).

-- migrate:up
CREATE TABLE app.seo_slug_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('city','branch','room','game','publication')),
  entity_id   uuid NOT NULL,
  parent_key  text NOT NULL,
  old_slug    text NOT NULL,
  created_at  timestamptz NOT NULL,
  UNIQUE (entity_type, parent_key, old_slug)
);
CREATE INDEX seo_slug_history_entity_idx ON app.seo_slug_history (entity_type, entity_id);

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(slug, ', ') INTO bad FROM app.cities
   WHERE slug IN ('rooms','games','schedule','birthday','news','promotions','giveaways','tournaments','reviews','about','contacts','rules','privacy-policy','personal-data-consent','cookie-policy','advertising-consent','login','account','sitemap','api','admin','crm','assets','media','preview','unsubscribe','info');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0405: слаг города совпадает с зарезервированным адресом сайта (карта п.2.8): %. Сменить слаг в CRM и повторить миграцию', bad;
  END IF;
END $$;

ALTER TABLE app.cities ADD CONSTRAINT cities_slug_reserved
  CHECK (slug NOT IN ('rooms','games','schedule','birthday','news','promotions','giveaways','tournaments','reviews','about','contacts','rules','privacy-policy','personal-data-consent','cookie-policy','advertising-consent','login','account','sitemap','api','admin','crm','assets','media','preview','unsubscribe','info'));

-- migrate:down
ALTER TABLE app.cities DROP CONSTRAINT cities_slug_reserved;
DROP TABLE app.seo_slug_history;
