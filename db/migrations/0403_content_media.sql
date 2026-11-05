-- 0403_content_media: медиатека CMS (K22 §8, model-dannyh 0403, шаг S4-30; приём – modules/content/media.ts).
--   app.content_media – строка на файл: дедупликация по sha256 исходника, варианты перекодирования (WebP 480/960/1600,
--   JPEG 1600), storage_key – путь от MEDIA_DIR; адрес на сайте – /media/<key>. Исходник с EXIF на диск не пишется.
--   app.content_media_usages – где файл использован: по черновику (live = false) и по живой версии (live = true),
--   пересчитывается при saveDraft и publish; архив и удаление смотрят сюда. Связь полиморфная – без FK на сущность (как outbox).

-- migrate:up
CREATE TABLE app.content_media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256        text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime          text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  bytes         bigint NOT NULL CHECK (bytes > 0),
  width         int,
  height        int,
  variants      jsonb NOT NULL DEFAULT '[]',
  storage_key   text NOT NULL,
  alt           text CHECK (char_length(alt) <= 500),
  title         text CHECK (char_length(title) <= 200),
  original_name text CHECK (char_length(original_name) <= 255),
  purpose       text NOT NULL CHECK (purpose IN ('image','document')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','purged')),
  uploaded_by   uuid NOT NULL REFERENCES app.staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  row_version   int NOT NULL DEFAULT 1,
  CHECK ((purpose = 'document') = (mime = 'application/pdf')),
  CHECK ((purpose = 'image') = (width IS NOT NULL AND height IS NOT NULL))
);
CREATE INDEX content_media_list_idx ON app.content_media (status, created_at DESC);

CREATE TABLE app.content_media_usages (
  media_id    uuid NOT NULL REFERENCES app.content_media(id),
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  field       text NOT NULL,
  live        boolean NOT NULL,
  PRIMARY KEY (media_id, entity_type, entity_id, field, live)
);
CREATE INDEX content_media_usages_entity_idx ON app.content_media_usages (entity_type, entity_id, live);

-- migrate:down
DROP TABLE app.content_media_usages;
DROP TABLE app.content_media;
