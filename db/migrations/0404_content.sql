-- 0404_content: контент сайта (K22 §2–§4, §17; model-dannyh 0404; шаг S4-32; команды – modules/content/versions.ts).
--   journal.content_versions – только вставка: снимок того, что видит посетитель (alt и размеры медиа заморожены, K22 §8 п.5).
--   Версионируемые таблицы: общие столбцы K22 §3 (status, draft, live_version_id, row_version …); поля поиска и фильтра живой
--   версии (slug, publish_from …) пишет только publish. Публичные запросы столбец draft не выбирают. Удаления нет (12 §9.5).

-- migrate:up
CREATE TABLE journal.content_versions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type       text NOT NULL CHECK (entity_type IN ('publication','game','room_page','branch_page','content_page','home_block')),
  entity_id         uuid NOT NULL,
  version_no        int NOT NULL CHECK (version_no >= 1),
  snapshot          jsonb NOT NULL,
  action            text NOT NULL CHECK (action IN ('publish','rollback_publish')),
  published_by      uuid NOT NULL,
  published_at      timestamptz NOT NULL,
  reason            text,
  source_version_id bigint REFERENCES journal.content_versions(id),
  UNIQUE (entity_type, entity_id, version_no),
  CHECK ((action = 'rollback_publish') = (source_version_id IS NOT NULL))
);
SELECT journal.make_append_only('journal.content_versions');

CREATE TABLE app.content_publications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('news','promotion','giveaway','tournament')),
  slug             text CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 90),
  publish_from     timestamptz,
  publish_to       timestamptz,
  indexable        boolean NOT NULL DEFAULT true,
  cover_media_id   uuid REFERENCES app.content_media(id),
  rules_media_id   uuid REFERENCES app.content_media(id),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished','archived')),
  draft            jsonb NOT NULL,
  draft_updated_at timestamptz NOT NULL,
  draft_updated_by uuid NOT NULL,
  live_version_id  bigint REFERENCES journal.content_versions(id),
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  archived_at      timestamptz,
  UNIQUE (type, slug)
);
CREATE INDEX content_publications_live_idx ON app.content_publications (type, publish_from DESC) WHERE status = 'published';

CREATE TABLE app.content_publication_scopes (
  publication_id uuid NOT NULL REFERENCES app.content_publications(id),
  scope_type     text NOT NULL CHECK (scope_type IN ('network','city','branch')),
  city_id        uuid REFERENCES app.cities(id),
  branch_id      uuid REFERENCES app.branches(id),
  CHECK ((scope_type = 'network') = (city_id IS NULL AND branch_id IS NULL)),
  CHECK (scope_type <> 'city' OR (city_id IS NOT NULL AND branch_id IS NULL)),
  CHECK (scope_type <> 'branch' OR (branch_id IS NOT NULL AND city_id IS NULL))
);
CREATE INDEX content_publication_scopes_idx ON app.content_publication_scopes (publication_id);

CREATE TABLE app.content_games (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction        text NOT NULL CHECK (direction IN ('pc','vr','playstation')),
  slug             text CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 90),
  has_full         boolean NOT NULL DEFAULT false,
  cover_media_id   uuid REFERENCES app.content_media(id),
  sort_order       int NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished','archived')),
  draft            jsonb NOT NULL,
  draft_updated_at timestamptz NOT NULL,
  draft_updated_by uuid NOT NULL,
  live_version_id  bigint REFERENCES journal.content_versions(id),
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  archived_at      timestamptz,
  UNIQUE (direction, slug)
);

CREATE TABLE app.content_game_branches (
  game_id    uuid NOT NULL REFERENCES app.content_games(id),
  branch_id  uuid NOT NULL REFERENCES app.branches(id),
  available  boolean NOT NULL,
  note       text CHECK (length(note) <= 120),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (game_id, branch_id)
);

CREATE TABLE app.content_room_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          uuid NOT NULL UNIQUE REFERENCES app.rooms(id),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished','archived')),
  draft            jsonb NOT NULL,
  draft_updated_at timestamptz NOT NULL,
  draft_updated_by uuid NOT NULL,
  live_version_id  bigint REFERENCES journal.content_versions(id),
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  archived_at      timestamptz
);

CREATE TABLE app.content_branch_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL UNIQUE REFERENCES app.branches(id),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished','archived')),
  draft            jsonb NOT NULL,
  draft_updated_at timestamptz NOT NULL,
  draft_updated_by uuid NOT NULL,
  live_version_id  bigint REFERENCES journal.content_versions(id),
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  archived_at      timestamptz
);

CREATE TABLE app.content_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL CHECK (key IN ('about','contacts_intro','rules','privacy-policy','personal-data-consent','cookie-policy','advertising-consent')),
  city_id          uuid REFERENCES app.cities(id),
  document_version text CHECK (document_version IS NULL OR document_version ~ '^[a-z-]+-\d{4}-\d{2}-\d{2}(-\d+)?$'),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished','archived')),
  draft            jsonb NOT NULL,
  draft_updated_at timestamptz NOT NULL,
  draft_updated_by uuid NOT NULL,
  live_version_id  bigint REFERENCES journal.content_versions(id),
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  archived_at      timestamptz,
  CHECK (city_id IS NULL OR key IN ('about','rules','contacts_intro')),
  UNIQUE NULLS NOT DISTINCT (key, city_id)
);

CREATE TABLE app.content_home_blocks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_type       text NOT NULL CHECK (block_type IN ('hero','about','directions','advantages','promo_strip','cta')),
  city_id          uuid REFERENCES app.cities(id),
  sort_order       int NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished','archived')),
  draft            jsonb NOT NULL,
  draft_updated_at timestamptz NOT NULL,
  draft_updated_by uuid NOT NULL,
  live_version_id  bigint REFERENCES journal.content_versions(id),
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  archived_at      timestamptz,
  UNIQUE NULLS NOT DISTINCT (block_type, city_id)
);

-- Удаления контента нет (12 §9.5, приёмка 18); охват живой версии переписывает publish – там DELETE нужен.
REVOKE DELETE, TRUNCATE ON app.content_publications, app.content_games, app.content_game_branches, app.content_room_pages,
  app.content_branch_pages, app.content_pages, app.content_home_blocks FROM yu_app;

-- migrate:down
DROP TABLE app.content_home_blocks;
DROP TABLE app.content_pages;
DROP TABLE app.content_branch_pages;
DROP TABLE app.content_room_pages;
DROP TABLE app.content_game_branches;
DROP TABLE app.content_games;
DROP TABLE app.content_publication_scopes;
DROP TABLE app.content_publications;
DROP TABLE journal.content_versions;
