-- 0302_attachments: закрытые вложения Э3 (K19 §9, model-dannyh 0302, шаг S3-06; адаптер – core/files.ts).
--   app.attachments – строка на версию файла: владелец (полиморфно, реестр registerAttachmentOwner), тип документа,
--   адрес на диске по sha256 (<sha[0:2]>/<sha>), размер, тип по сигнатуре, подпись имени (путь из неё не строится).
--   Файл не заменяется: новая версия – новая строка с supersedes (у версии один наследник – UNIQUE), ошибочная –
--   status 'invalid' с причиной. У yu_app нет UPDATE содержимого и DELETE – меняются только поля «недействителен».

-- migrate:up
CREATE TABLE app.attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type      text NOT NULL CHECK (owner_type ~ '^[a-z][a-z_]{1,30}$'),
  owner_id        uuid NOT NULL,
  doc_type        text NOT NULL CHECK (doc_type IN ('photo','receipt','check','invoice','act','warranty_card','waybill','service_report','other')),
  storage_key     text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{2}/[0-9a-f]{64}$'),
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  mime_type       text NOT NULL,
  original_name   text CHECK (char_length(original_name) <= 255),
  comment         text,
  supersedes      uuid UNIQUE REFERENCES app.attachments(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
  invalid_reason  text,
  invalidated_by  uuid,
  invalidated_at  timestamptz,
  created_by_type text NOT NULL CHECK (created_by_type IN ('staff','system')),
  created_by_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (storage_key = substr(sha256, 1, 2) || '/' || sha256),
  CHECK ((status = 'invalid') = (invalid_reason IS NOT NULL)),
  CHECK (invalid_reason IS NULL OR btrim(invalid_reason) <> ''),
  CHECK (supersedes IS NULL OR supersedes <> id)
);
CREATE INDEX attachments_owner_idx ON app.attachments (owner_type, owner_id, created_at);
CREATE INDEX attachments_storage_idx ON app.attachments (storage_key);
REVOKE UPDATE, DELETE, TRUNCATE ON app.attachments FROM yu_app;
GRANT UPDATE (status, invalid_reason, invalidated_by, invalidated_at) ON app.attachments TO yu_app;

-- migrate:down
DROP TABLE app.attachments;
