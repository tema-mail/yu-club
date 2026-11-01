-- 0001_init: расширения, схемы и роль приложения.
--
-- Механизм «журнал – только вставка» (аудит K2, журнал операций K3 и др.):
--   * схема app      – обычные таблицы модулей: yu_app получает SELECT/INSERT/UPDATE/DELETE;
--   * схема journal  – журнальные таблицы: yu_app получает только SELECT/INSERT.
--   Права выдаются автоматически через ALTER DEFAULT PRIVILEGES – для таблиц,
--   которые создаёт та же учётка, что запускает миграции (мигратор, владелец объектов).
--   yu_app не владелец таблиц, поэтому не может ни ALTER/DROP, ни выдать себе права.
--   Проверка: journal.append_only_violations() возвращает журнальные таблицы, где у
--   yu_app есть UPDATE/DELETE/TRUNCATE (должно быть пусто; тест держит это в CI).
--   Если таблицу в journal создал другой владелец – выровнять вызовом
--   journal.make_append_only('journal.<таблица>').
--
-- Роль yu_app – общая на кластер – миграция НЕ создаёт и НЕ удаляет (ADR 0001):
-- её заводит скрипт инициализации контейнера с паролем из секретов окружения
-- (в тестах – globalSetup). Миграция проверяет, что роль есть, и выдаёт права.
-- Запускать от владельца объектов (yu_owner) – он же должен владеть базой.

-- migrate:up
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yu_app') THEN
    RAISE EXCEPTION 'Нет роли yu_app: её создаёт скрипт инициализации кластера до миграций';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO yu_app', current_database());
END
$$;

CREATE SCHEMA app;
CREATE SCHEMA journal;
GRANT USAGE ON SCHEMA app, journal TO yu_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO yu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA journal GRANT SELECT, INSERT ON TABLES TO yu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA journal GRANT USAGE, SELECT ON SEQUENCES TO yu_app;

-- Явно привести таблицу к режиму «только вставка» для yu_app.
CREATE FUNCTION journal.make_append_only(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON %s FROM yu_app, PUBLIC', tbl);
  EXECUTE format('GRANT SELECT, INSERT ON %s TO yu_app', tbl);
END
$$;

-- Журнальные таблицы, где у yu_app есть лишние права (должно быть пусто).
-- UPDATE проверяется и на уровне колонок: GRANT UPDATE (col) обходит табличную проверку.
CREATE FUNCTION journal.append_only_violations() RETURNS TABLE (table_name text, privilege text)
LANGUAGE sql STABLE AS $$
  SELECT c.oid::regclass::text, p.priv
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'journal'
  CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
  WHERE c.relkind IN ('r', 'p')
    AND (has_table_privilege('yu_app', c.oid, p.priv)
         OR (p.priv = 'UPDATE' AND has_any_column_privilege('yu_app', c.oid, 'UPDATE')))
  ORDER BY 1, 2
$$;

REVOKE ALL ON FUNCTION journal.make_append_only(regclass) FROM PUBLIC;

-- migrate:down
-- Схемы должны быть пусты (последующие миграции к этому моменту откачены):
-- DROP без CASCADE, чтобы не снести чужие данные молча.
DROP FUNCTION journal.append_only_violations();
DROP FUNCTION journal.make_append_only(regclass);
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM yu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON SEQUENCES FROM yu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA journal REVOKE ALL ON TABLES FROM yu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA journal REVOKE ALL ON SEQUENCES FROM yu_app;
DROP SCHEMA journal;
DROP SCHEMA app;

DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM yu_app', current_database());
END
$$;

DROP EXTENSION IF EXISTS btree_gist;
