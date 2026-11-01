#!/usr/bin/env bash
# Бэкап базы yu-club (S0-17): pg_dump -Fc из работающего контейнера, хранение BACKUP_RETENTION_DAYS дней.
# Рядом с дампом – файл .counts: число записей по каждой таблице и сумма журнала операций,
# снятые в том же снимке, что и дамп (pg_export_snapshot → pg_dump --snapshot). По нему
# deploy/restore-check.sh сверяет восстановленную базу без гонки с живыми записями.
# Неуспех: строка «ОШИБКА» в выводе (cron пишет его в backup.log) и ненулевой код;
# если задан BACKUP_ALERT_URL – туда уходит POST с текстом (канал оповещения выберут позже).
# Запуск: /opt/yu-club/backup.sh   (окружение – /opt/yu-club/.env, если есть)
set -euo pipefail
ENV_FILE=${ENV_FILE:-/opt/yu-club/.env}
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
CT=${PG_CONTAINER:-yu-club-postgres}
DB=${BACKUP_DB:-yu_club}
DIR=${BACKUP_DIR:-/opt/yu-club/backups}          # на хосте; в контейнере он же смонтирован как /backups
KEEP=${BACKUP_RETENTION_DAYS:-14}
NAME=$DB-$(date -u +%Y%m%d-%H%M%S)

fail() {
  echo "$(date -Is) ОШИБКА бэкапа $DB: $*"
  [ -n "${BACKUP_ALERT_URL:-}" ] && curl -s -m 10 -X POST --data-urlencode "text=yu-club: бэкап $DB не удался: $*" "$BACKUP_ALERT_URL" >/dev/null || true
  rm -f "$DIR/$NAME.dump.part" "$DIR/$NAME.counts.part" "$DIR/$NAME.snap" "$DIR/$NAME.failed"
  exit 1
}
trap 'fail "команда упала (строка $LINENO)"' ERR

mkdir -p "$DIR"; chmod 700 "$DIR"
docker exec "$CT" pg_isready -q -U postgres -d "$DB" || fail "база недоступна"

# Один сеанс psql: снимок → дамп этого снимка → подсчёт в том же снимке.
# Имя снимка – через файл: psql не подставляет переменные в \!.
docker exec -i "$CT" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -At >/dev/null <<SQL
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\o /backups/$NAME.snap
SELECT pg_export_snapshot();
\o
\! pg_dump -U postgres -Fc --snapshot="\$(cat /backups/$NAME.snap)" -f /backups/$NAME.dump.part $DB || echo "pg_dump упал" > /backups/$NAME.failed
\o /backups/$NAME.counts.part
SELECT 'rows ' || n.nspname || '.' || c.relname || ' ' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY 1;
SELECT 'ledger_sum ' || coalesce((
  SELECT (xpath('/row/s/text()', query_to_xml(format('SELECT coalesce(sum(amount), 0) AS s FROM %s', c.oid::regclass), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'amount' AND NOT a.attisdropped
  WHERE c.relname = 'ledger_entries' AND c.relkind IN ('r', 'p') LIMIT 1), 'нет_таблицы');
\o
COMMIT;
SQL

rm -f "$DIR/$NAME.snap"
if [ -f "$DIR/$NAME.failed" ]; then rm -f "$DIR/$NAME.failed"; fail "pg_dump вернул ошибку"; fi
[ -s "$DIR/$NAME.dump.part" ] || fail "пустой дамп"
[ -s "$DIR/$NAME.counts.part" ] || fail "нет подсчёта записей"
mv "$DIR/$NAME.dump.part" "$DIR/$NAME.dump"
mv "$DIR/$NAME.counts.part" "$DIR/$NAME.counts"
chmod 600 "$DIR/$NAME.dump" "$DIR/$NAME.counts"

# хранение: старше KEEP суток – удалить (только свои файлы этой базы)
find "$DIR" -maxdepth 1 -type f \( -name "$DB-*.dump" -o -name "$DB-*.counts" \) -mtime +"$((KEEP - 1))" -delete

echo "$(date -Is) бэкап $NAME.dump $(du -h "$DIR/$NAME.dump" | cut -f1), таблиц $(grep -c '^rows ' "$DIR/$NAME.counts"), $(grep '^ledger_sum ' "$DIR/$NAME.counts")"
