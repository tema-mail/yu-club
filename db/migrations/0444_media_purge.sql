-- 0444_media_purge: журнал принудительных очисток фото по требованию субъекта (K22 §8 «Принудительная очистка», K11 №227а,
--   техдолг 4.1б; остаток S4-89). journal.media_purged – только вставка: что очищено (media_id и sha256 исходника – по нему файл
--   находят в старом бэкапе), код причины из списка, кем и когда, сколько файлов стёрто и какие сущности получили версию без фото.
--   Свободного текста нет: ни ФИО, ни содержания заявления – журнал выгружается отдельно от дампа, и после восстановления
--   бэкапа старше очистки очистки повторяются по нему (регламент 4.1б). Основание словами (номер и дата документа) – только
--   в journal.audit_events (действие media.purged), как раньше. FK нет намеренно: строка должна читаться и без исходной базы.

-- migrate:up
CREATE TABLE journal.media_purged (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  media_id    uuid NOT NULL,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  reason_code text NOT NULL CHECK (reason_code IN ('subject_request','consent_withdrawn','rights_claim','legal_order')),
  purged_by   uuid NOT NULL,
  purged_at   timestamptz NOT NULL,
  files       int NOT NULL CHECK (files >= 0),
  affected    jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX media_purged_media_idx ON journal.media_purged (media_id);
SELECT journal.make_append_only('journal.media_purged');

-- migrate:down
DROP TABLE journal.media_purged;
