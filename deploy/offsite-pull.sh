#!/usr/bin/env bash
# Копия бэкапа вне сервера (S3-99), вариант стенда: забор С МАКА по ssh.
# Сервер копий наружу не шлёт; мак сам забирает свежие дампы deploy/backup.sh
# (<база>-*.dump и .counts) и, если есть, каталоги медиатеки и вложений.
#   1. rsync дампов в $DEST/dumps (без --delete: на сервере 14 дней, здесь KEEP дней);
#   2. sha256 каждого нового файла сверяется с sha256sum на сервере, при расхождении файл
#      убирается и – «ОШИБКА»; совпавшая сумма пишется рядом (<файл>.sha256);
#   3. для последнего дампа – текстовая форма <имя>.sql.gz (pg_restore -f - в контейнере
#      читает только файл дампа, к базе не подключается): на маке нет pg_restore, а SQL
#      восстанавливается и без него (offsite-verify.mjs; при аварии – psql -f);
#   4. каталоги из OFFSITE_DIRS – зеркалом в $DEST/files/<имя> с --delete: принудительно
#      удалённое фото субъекта (K22 §8) пропадает и из копии; сами файлы по хешу не меняются;
#   5. хранение: файлы дампов старше KEEP суток удаляются;
#   --verify: после забора пробное восстановление последнего дампа во временную
#      embedded-postgres (deploy/offsite-verify.mjs), сверка с .counts, база удаляется.
# Права: каталоги 700, файлы 600. Пароли не выводятся (ssh по ключу, пароль временной базы
# одноразовый). Неуспех – «ОШИБКА» в выводе и в $DEST/logs/offsite.log, ненулевой код,
# уведомление macOS и POST на OFFSITE_ALERT_URL, если задан.
# Расписание не ставится этим скриптом – шаблон deploy/offsite-pull.plist.example.
# Боевой сервер заказчика: см. ADR 0001, строка про S3-99 (выгрузка в S3-хранилище в РФ).
#
# Запуск: deploy/offsite-pull.sh [--verify] [--no-pull]
# Переменные: OFFSITE_HOST (firstvds-msk), OFFSITE_REMOTE_DIR (/opt/yu-club/backups),
#   OFFSITE_DIRS («/opt/yu-club/media /opt/yu-club/attachments»), OFFSITE_DEST (~/Backups/yu-club),
#   OFFSITE_RETENTION_DAYS (30), BACKUP_DB (yu_club), PG_CONTAINER (yu-club-postgres),
#   NODE (node из PATH или ~/.local/bin/node), YU_NODE_ROOT (где node_modules с pg и embedded-postgres).
set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HERE=$(cd "$(dirname "$0")" && pwd)
HOST=${OFFSITE_HOST:-firstvds-msk}
RDIR=${OFFSITE_REMOTE_DIR:-/opt/yu-club/backups}
DIRS=${OFFSITE_DIRS:-/opt/yu-club/media /opt/yu-club/attachments}
DEST=${OFFSITE_DEST:-$HOME/Backups/yu-club}
KEEP=${OFFSITE_RETENTION_DAYS:-30}
DB=${BACKUP_DB:-yu_club}
CT=${PG_CONTAINER:-yu-club-postgres}
NODE=${NODE:-$(command -v node || echo "$HOME/.local/bin/node")}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15)
VERIFY=0; PULL=1
for a in "$@"; do
  case "$a" in
    --verify) VERIFY=1 ;;
    --no-pull) PULL=0 ;;
    *) echo "неизвестный ключ: $a (есть --verify, --no-pull)" >&2; exit 2 ;;
  esac
done

mkdir -p "$DEST/dumps" "$DEST/files" "$DEST/logs"
chmod 700 "$DEST" "$DEST/dumps" "$DEST/files" "$DEST/logs"
LOG="$DEST/logs/offsite.log"
touch "$LOG"; chmod 600 "$LOG"
exec > >(tee -a "$LOG") 2>&1

fail() {
  echo "$(date -Iseconds) ОШИБКА копии вне сервера $DB: $*"
  [ -n "${OFFSITE_ALERT_URL:-}" ] && curl -s -m 10 -X POST --data-urlencode "text=yu-club: копия вне сервера не удалась: $*" "$OFFSITE_ALERT_URL" >/dev/null || true
  osascript -e "display notification \"$(printf '%s' "$*" | tr -d '"\\' | cut -c1-120)\" with title \"yu-club: ОШИБКА копии бэкапа\"" >/dev/null 2>&1 || true
  exit 1
}
trap 'fail "команда упала (строка $LINENO)"' ERR

sha_local() { shasum -a 256 "$1" | cut -d' ' -f1; }

if [ "$PULL" = 1 ]; then
  "${SSH[@]}" "$HOST" true 2>/dev/null || fail "нет связи с $HOST по ssh"
  rsync -a --timeout=120 -e "${SSH[*]}" --include "$DB-*.dump" --include "$DB-*.counts" --exclude '*' \
    "$HOST:$RDIR/" "$DEST/dumps/" || fail "rsync дампов с $HOST:$RDIR не прошёл"

  # суммы с сервера; сверяем каждый файл, у которого ещё нет подтверждённой суммы
  SUMS=$("${SSH[@]}" "$HOST" "cd '$RDIR' && sha256sum $DB-*.dump $DB-*.counts") || fail "sha256sum на сервере не прошёл"
  CHECKED=0
  while read -r sum name; do
    f="$DEST/dumps/$name"
    [ -f "$f" ] || fail "файл $name есть на сервере, но не пришёл"
    [ -f "$f.sha256" ] && [ "$(cat "$f.sha256")" = "$sum" ] && continue
    got=$(sha_local "$f")
    if [ "$got" != "$sum" ]; then rm -f "$f"; fail "сумма $name не совпала с сервером (файл удалён, заберётся заново)"; fi
    echo "$sum" > "$f.sha256"; touch -r "$f" "$f.sha256"   # хранение идёт по времени дампа
    CHECKED=$((CHECKED + 1))
  done <<< "$SUMS"

  LAST=$(ls -1t "$DEST/dumps"/"$DB"-*.dump 2>/dev/null | head -1 || true)
  [ -n "$LAST" ] || fail "на сервере нет дампов $DB в $RDIR"
  NAME=$(basename "$LAST" .dump)
  if [ ! -s "$DEST/dumps/$NAME.sql.gz" ]; then
    "${SSH[@]}" "$HOST" "docker exec $CT pg_restore --no-owner --no-privileges -f - /backups/$NAME.dump" \
      | gzip -6 > "$DEST/dumps/$NAME.sql.gz.part" || { rm -f "$DEST/dumps/$NAME.sql.gz.part"; fail "текстовая форма $NAME не снялась"; }
    [ -s "$DEST/dumps/$NAME.sql.gz.part" ] || fail "пустая текстовая форма $NAME"
    mv "$DEST/dumps/$NAME.sql.gz.part" "$DEST/dumps/$NAME.sql.gz"
    sha_local "$DEST/dumps/$NAME.sql.gz" > "$DEST/dumps/$NAME.sql.gz.sha256"
    touch -r "$LAST" "$DEST/dumps/$NAME.sql.gz" "$DEST/dumps/$NAME.sql.gz.sha256"
  fi

  for d in $DIRS; do
    if "${SSH[@]}" "$HOST" "test -d '$d'"; then
      mkdir -p "$DEST/files/$(basename "$d")"
      rsync -a --delete --timeout=300 -e "${SSH[*]}" "$HOST:$d/" "$DEST/files/$(basename "$d")/" || fail "rsync каталога $d не прошёл"
      echo "каталог $d: файлов $(find "$DEST/files/$(basename "$d")" -type f | wc -l | tr -d ' ')"
    else
      echo "каталога $d на сервере нет – пропуск"
    fi
  done

  # хранение KEEP суток (по времени файла, rsync сохраняет серверное)
  find "$DEST/dumps" -maxdepth 1 -type f -name "$DB-*" -mtime +"$((KEEP - 1))" -delete
  chmod -R go-rwx "$DEST"
  echo "$(date -Iseconds) забрано с $HOST: новых сумм сверено $CHECKED, последний $NAME.dump $(du -h "$LAST" | cut -f1), дампов в копии $(ls -1 "$DEST/dumps"/"$DB"-*.dump | wc -l | tr -d ' ')"
fi

if [ "$VERIFY" = 1 ]; then
  LAST=$(ls -1t "$DEST/dumps"/"$DB"-*.sql.gz 2>/dev/null | head -1 || true)
  [ -n "$LAST" ] || fail "нет текстовой формы дампа в $DEST/dumps"
  NAME=$(basename "$LAST" .sql.gz)
  for f in "$NAME.dump" "$NAME.counts" "$NAME.sql.gz"; do
    [ -s "$DEST/dumps/$f" ] && [ -s "$DEST/dumps/$f.sha256" ] || fail "нет $f или его суммы"
    [ "$(sha_local "$DEST/dumps/$f")" = "$(cat "$DEST/dumps/$f.sha256")" ] || fail "сумма $f в копии испорчена"
  done
  echo "суммы $NAME (.dump, .counts, .sql.gz) совпали"
  "$NODE" "$HERE/offsite-verify.mjs" "$DEST/dumps/$NAME.sql.gz" "$DEST/dumps/$NAME.counts" || fail "пробное восстановление $NAME не прошло"
fi
