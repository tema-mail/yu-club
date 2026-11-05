#!/usr/bin/env bash
# Проверка восстановления (S0-17): последний (или заданный) дамп разворачивается в чистую
# временную базу того же кластера, затем число записей по каждой таблице и сумма журнала
# операций сравниваются с файлом .counts, снятым в момент бэкапа (deploy/backup.sh).
# Временная база удаляется в любом случае. Неуспех – «ОШИБКА» в выводе и ненулевой код.
# Запуск: /opt/yu-club/restore-check.sh [путь/к/дампу.dump]
set -euo pipefail
ENV_FILE=${ENV_FILE:-/opt/yu-club/.env}
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
CT=${PG_CONTAINER:-yu-club-postgres}
DB=${BACKUP_DB:-yu_club}
DIR=${BACKUP_DIR:-/opt/yu-club/backups}
DUMP=${1:-$(ls -1t "$DIR"/"$DB"-*.dump 2>/dev/null | head -1 || true)}
TMP=restore_check_$(date -u +%Y%m%d%H%M%S)
SEEN=$(mktemp)

fail() {
  echo "$(date -Is) ОШИБКА проверки восстановления $DB: $*"
  [ -n "${BACKUP_ALERT_URL:-}" ] && curl -s -m 10 -X POST --data-urlencode "text=yu-club: проверка восстановления $DB не прошла: $*" "$BACKUP_ALERT_URL" >/dev/null || true
  exit 1
}
cleanup() {
  rm -f "$SEEN"
  docker exec "$CT" psql -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS $TMP WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'fail "команда упала (строка $LINENO)"' ERR

[ -n "$DUMP" ] && [ -s "$DUMP" ] || fail "нет дампа в $DIR"
COUNTS=${DUMP%.dump}.counts
[ -s "$COUNTS" ] || fail "нет файла подсчёта $COUNTS"
case "$DUMP" in "$DIR"/*) IN_CT=/backups/${DUMP#"$DIR"/} ;; *) fail "дамп должен лежать в $DIR (смонтирован в контейнер)" ;; esac

docker exec "$CT" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $TMP" >/dev/null
docker exec "$CT" pg_restore -U postgres -d "$TMP" --exit-on-error "$IN_CT" || fail "pg_restore вернул ошибку"

# тот же запрос, что в backup.sh, но по восстановленной базе
docker exec -i "$CT" psql -U postgres -d "$TMP" -v ON_ERROR_STOP=1 -q -At >"$SEEN" <<'SQL'
SELECT 'rows ' || n.nspname || '.' || c.relname || ' ' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY 1;
SELECT 'ledger_sum ' || coalesce((
  SELECT (xpath('/row/s/text()', query_to_xml(format('SELECT coalesce(sum(amount), 0) AS s FROM %s', c.oid::regclass), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'amount' AND NOT a.attisdropped
  WHERE c.relname = 'ledger_entries' AND c.relkind IN ('r', 'p') LIMIT 1), 'нет_таблицы');
SQL

if ! diff -u "$COUNTS" "$SEEN" >&2; then fail "восстановленная база не совпала с $COUNTS (разница выше)"; fi
TABLES=$(grep -c '^rows ' "$SEEN" || true)
[ "$TABLES" -gt 0 ] || fail "в восстановленной базе нет таблиц"
ROWS=$(awk '/^rows /{s+=$3} END{print s+0}' "$SEEN")

# Медиатека (S4-07, K22 §8): каждый файл строки content_media восстановленной базы (исходник и все варианты,
# кроме принудительно очищенных – status = 'purged') есть в снимке рядом с дампом. Таблицы нет (до Э4) – пропуск.
MEDIA_SNAP=${DUMP%.dump}.media
KEYS=$(mktemp)
HAS_MEDIA=$(docker exec "$CT" psql -U postgres -d "$TMP" -q -At -c "SELECT to_regclass('app.content_media') IS NOT NULL")
if [ "$HAS_MEDIA" = "t" ]; then
  docker exec -i "$CT" psql -U postgres -d "$TMP" -v ON_ERROR_STOP=1 -q -At >"$KEYS" <<'SQL'
SELECT k FROM (
  SELECT storage_key AS k FROM app.content_media WHERE status <> 'purged'
  UNION SELECT v->>'key' FROM app.content_media, jsonb_array_elements(variants) v WHERE status <> 'purged'
) x WHERE k IS NOT NULL ORDER BY 1;
SQL
fi
MEDIA_FILES=$(grep -c . "$KEYS" || true)
if [ "$MEDIA_FILES" -gt 0 ]; then
  [ -d "$MEDIA_SNAP" ] || { rm -f "$KEYS"; fail "в базе $MEDIA_FILES файлов медиа, а снимка $MEDIA_SNAP нет"; }
  MISSING=0
  while IFS= read -r key; do
    case "$key" in /*|*..*) echo "недопустимый storage_key: $key" >&2; MISSING=$((MISSING + 1)); continue ;; esac
    [ -f "$MEDIA_SNAP/$key" ] || { echo "нет файла медиа: $key" >&2; MISSING=$((MISSING + 1)); }
  done <"$KEYS"
  rm -f "$KEYS"
  [ "$MISSING" -eq 0 ] || fail "в снимке медиа нет $MISSING файлов из $MEDIA_FILES (список выше)"
else
  rm -f "$KEYS"
fi
echo "$(date -Is) восстановление $(basename "$DUMP") проверено: таблиц $TABLES, записей $ROWS, $(grep '^ledger_sum ' "$SEEN"), файлов медиа $MEDIA_FILES"
