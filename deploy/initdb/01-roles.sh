#!/bin/sh
# Роли и база yu-club (ADR 0001). Образ postgres выполняет скрипт один раз –
# на пустом каталоге данных. Пароли – из окружения контейнера (файл окружения стенда, не git).
#   yu_owner – владелец базы и объектов, под ним идут миграции;
#   yu_app   – рантайм, права выдаёт миграция 0001.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$YU_OWNER_PASSWORD" -v app_pw="$YU_APP_PASSWORD" <<'SQL'
CREATE ROLE yu_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE yu_app LOGIN PASSWORD :'app_pw';
CREATE DATABASE yu_club OWNER yu_owner;
REVOKE ALL ON DATABASE yu_club FROM PUBLIC;
SQL
