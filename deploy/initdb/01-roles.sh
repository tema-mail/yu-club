#!/bin/sh
# Роли и база yu-club (ADR 0001). Образ postgres выполняет скрипт один раз –
# на пустом каталоге данных. Пароли – из окружения контейнера (файл окружения стенда, не git).
#   yu_owner – владелец базы и объектов, под ним идут миграции;
#   yu_app   – рантайм, права выдаёт миграция 0001;
#   yu_boss  – очередь pg-boss процесса worker: владелец только схемы pgboss
#              (схему с владельцем выдаёт deploy/deploy.sh после миграций – и после пересоздания базы).
# На уже развёрнутом кластере недостающие роли создаёт deploy/deploy.sh тем же SQL.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$YU_OWNER_PASSWORD" -v app_pw="$YU_APP_PASSWORD" -v boss_pw="$YU_BOSS_PASSWORD" <<'SQL'
CREATE ROLE yu_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE yu_app LOGIN PASSWORD :'app_pw';
CREATE ROLE yu_boss LOGIN PASSWORD :'boss_pw';
CREATE DATABASE yu_club OWNER yu_owner;
REVOKE ALL ON DATABASE yu_club FROM PUBLIC;
SQL
