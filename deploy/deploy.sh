#!/usr/bin/env bash
# Выкладка тест-стенда yu-club с мака (S0-19): код из git HEAD → $ROOT/src на сервере, сборка образов API, CRM и сайта,
# Postgres (роли – deploy/initdb), миграции под yu_owner, запуск API, свой блок в общем Caddy
# (копия → замена своего блока → validate → reload; соседи проверяются до и после),
# бэкап по расписанию 04:40 UTC (backup.sh, затем restore-check.sh), проверка снаружи.
# Сервер, ключ, адрес и сеть Caddy – окружением; переезд к заказчику = другие значения + свой .env.
#   deploy/deploy.sh
#   YU_HOST=root@1.2.3.4 YU_DOMAIN=crm.example.ru YU_CADDY=/etc/caddy/Caddyfile YU_CADDY_CT=caddy deploy/deploy.sh
# Пароли БД, SESSION_PEPPER, CERT_PEPPER и пара VAPID генерируются на сервере один раз в $ROOT/.env (600) и никуда не выводятся.
#
# Следующий шаг (не сделан, решение владельца позже): .github/workflows/deploy-test.yml – выкладка по тегу
# test-*: тот же сценарий из Actions; нужен деплой-ключ сервера в секретах репозитория.
set -euo pipefail
HOST=${YU_HOST:-root@45.12.72.227}
KEY=${YU_KEY:-$HOME/.ssh/omni_assistant_firstvds_ed25519}
DOMAIN=${YU_DOMAIN:-yu-club.45.12.72.227.nip.io}
ROOT=${YU_ROOT:-/opt/yu-club}
CADDY=${YU_CADDY:-/opt/dzenbot/Caddyfile}
CADDY_CT=${YU_CADDY_CT:-dzenbot-caddy-1}
CRM_DOMAIN=${YU_CRM_DOMAIN:-yu-crm.45.12.72.227.nip.io}
NEIGHBOURS=${YU_NEIGHBOURS:-"https://gaz-mag.ru/ https://lupa.45.12.72.227.nip.io/login https://teyes.45.12.72.227.nip.io/"}
cd "$(dirname "$0")/.."
# ServerAliveInterval: тихая сборка образа (build -q) идёт минутами – без пингов сеть рвёт сессию
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$HOST")

RESET=0
case "${1:-}" in
  --reset-stage) RESET=1 ;;
  "") ;;
  *) echo "Неизвестный аргумент: $1 (есть только --reset-stage)"; exit 1 ;;
esac

[ -z "$(git status --porcelain -- apps db deploy package.json package-lock.json .dockerignore)" ] || { echo "Есть незакоммиченные правки – сначала коммит"; exit 1; }
REV=$(git rev-parse --short HEAD)
echo "→ выкладываю $REV на $DOMAIN"
# --reset-stage (ADR 0001): база стенда пересоздаётся – бэкап → drop/create → миграции с нуля → deploy/seed-stand.sh.
# Только на сервере с APP_ENV=stage; на проде миграции идут лишь по порядку.
if [ "$RESET" = 1 ]; then
  "${SSH[@]}" "grep -qx 'APP_ENV=stage' $ROOT/.env" || { echo "!!! --reset-stage только для APP_ENV=stage в $ROOT/.env – отказ"; exit 1; }
  echo "→ режим --reset-stage: база стенда будет пересоздана"
fi

# 1. код
git archive --format=tar HEAD | "${SSH[@]}" "set -e; mkdir -p $ROOT/data $ROOT/backups; chmod 700 $ROOT/backups; rm -rf $ROOT/src.new; mkdir $ROOT/src.new; tar -x -C $ROOT/src.new; rm -rf $ROOT/src.old; [ -d $ROOT/src ] && mv $ROOT/src $ROOT/src.old; mv $ROOT/src.new $ROOT/src; echo $REV > $ROOT/src/REVISION"
# CRM и сайт собираются здесь (дерево чистое = HEAD): на стенде astro build не помещается в память
for app in crm site; do
  PATH="$HOME/.local/node/bin:$PATH" npm run -s build -w "@yu/$app" >/dev/null
  tar --no-xattrs -C "apps/$app" -cf - dist | "${SSH[@]}" "set -e; mkdir -p $ROOT/src/apps/$app; tar -x -C $ROOT/src/apps/$app"
done
echo "→ CRM и сайт собраны на маке и отправлены"

# 2. окружение – один раз, пароли генерируются на сервере
"${SSH[@]}" "set -e; test -f $ROOT/.env || { umask 077; printf 'APP_ENV=stage\nPUBLIC_SITE_URL=https://%s\nPOSTGRES_PASSWORD=%s\nYU_OWNER_PASSWORD=%s\nYU_APP_PASSWORD=%s\nDATA_DIR=%s/data\nBACKUP_DIR=%s/backups\nBACKUP_RETENTION_DAYS=14\nCADDY_NETWORK=dzenbot_default\n' $DOMAIN \$(openssl rand -hex 24) \$(openssl rand -hex 24) \$(openssl rand -hex 24) $ROOT $ROOT > $ROOT/.env; echo '→ создан $ROOT/.env (600)'; }; chmod 600 $ROOT/.env"
# SESSION_PEPPER (K12) – тоже один раз; на стенде, где .env создан раньше, дописывается. Смена значения = выход всех сотрудников.
"${SSH[@]}" "set -e; grep -q '^SESSION_PEPPER=' $ROOT/.env || { umask 077; printf 'SESSION_PEPPER=%s\n' \$(openssl rand -hex 32) >> $ROOT/.env; echo '→ в $ROOT/.env добавлен SESSION_PEPPER'; }; chmod 600 $ROOT/.env"
# CERT_PEPPER (K16 §3, S2-08) – HMAC кода сертификата, тоже один раз; дописывается на стенде со старым .env.
# Смена значения = все выданные коды сертификатов перестают сходиться – после первой продажи не менять.
"${SSH[@]}" "set -e; grep -q '^CERT_PEPPER=' $ROOT/.env || { umask 077; printf 'CERT_PEPPER=%s\n' \$(openssl rand -hex 32) >> $ROOT/.env; echo '→ в $ROOT/.env добавлен CERT_PEPPER'; }; chmod 600 $ROOT/.env"
# VAPID (Web Push, S1-15) – пара P-256 тоже один раз: SEC1 DER 121 байт, закрытый ключ – байты 8..39, открытый – последние 65.
# Смена пары = все подписки браузеров недействительны (клиентам подписываться заново).
"${SSH[@]}" "set -e; grep -q '^VAPID_PRIVATE_KEY=' $ROOT/.env || { umask 077; K=\$(mktemp); openssl ecparam -name prime256v1 -genkey -noout -outform DER -out \$K; test \$(wc -c <\$K) -eq 121; printf 'VAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\nVAPID_SUBJECT=https://%s\n' \$(tail -c 65 \$K | base64 | tr '+/' '-_' | tr -d '=\n') \$(head -c 39 \$K | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n') $DOMAIN >> $ROOT/.env; rm -f \$K; echo '→ в $ROOT/.env добавлены VAPID_*'; }; chmod 600 $ROOT/.env"
# пароль роли yu_boss (pg-boss процесса worker) – тоже один раз
"${SSH[@]}" "set -e; grep -q '^YU_BOSS_PASSWORD=' $ROOT/.env || { umask 077; printf 'YU_BOSS_PASSWORD=%s\n' \$(openssl rand -hex 24) >> $ROOT/.env; echo '→ в $ROOT/.env добавлен YU_BOSS_PASSWORD'; }; chmod 600 $ROOT/.env"

# 3. образ, база, миграции, API, worker
"${SSH[@]}" "bash -s" <<REMOTE
set -euo pipefail
cd $ROOT/src/deploy
DC=(docker compose --env-file $ROOT/.env -f compose.yml)
GIT_SHA=$REV "\${DC[@]}" build --pull -q api </dev/null   # по одному образу – меньше пик памяти
"\${DC[@]}" build --pull -q crm </dev/null
"\${DC[@]}" build --pull -q site </dev/null
"\${DC[@]}" up -d --wait postgres </dev/null
# роль yu_boss (pg-boss процесса worker) – и на кластере, созданном до неё; пароль идёт в psql через stdin
BOSS_PW=\$(grep '^YU_BOSS_PASSWORD=' $ROOT/.env | cut -d= -f2-)
printf "DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yu_boss') THEN CREATE ROLE yu_boss LOGIN; END IF; END \\\$\\\$;\nALTER ROLE yu_boss PASSWORD '%s';\n" "\$BOSS_PW" \
  | docker exec -i yu-club-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q
if [ "$RESET" = 1 ]; then
  grep -qx 'APP_ENV=stage' $ROOT/.env || { echo "!!! не stage – отказ"; exit 1; }
  BACKUP_DB=yu_club bash $ROOT/src/deploy/backup.sh </dev/null
  "\${DC[@]}" stop worker site crm api </dev/null
  docker exec yu-club-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS yu_club WITH (FORCE)" -c "CREATE DATABASE yu_club OWNER yu_owner" \
    -c "REVOKE ALL ON DATABASE yu_club FROM PUBLIC"
  echo "→ база yu_club пересоздана (бэкап выше)"
fi
# без stdin: иначе run съест остаток этого скрипта
if ! OUT=\$("\${DC[@]}" run --rm -T migrate </dev/null 2>&1); then
  echo "\$OUT" | tail -5
  if echo "\$OUT" | grep -q 'порядок нарушен'; then
    echo "!!! порядок миграций на стенде нарушен (миграция из параллельной ветки) – нужен deploy/deploy.sh --reset-stage"
  fi
  exit 1
fi
echo "\$OUT" | grep -E 'Применены|Нечего' || true
# схема pgboss – собственность yu_boss: pg-boss сам создаёт в ней таблицы и разделы очередей (ADR 0001)
docker exec yu-club-postgres psql -U postgres -d yu_club -v ON_ERROR_STOP=1 -q \
  -c "GRANT CONNECT ON DATABASE yu_club TO yu_boss" -c "CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION yu_boss" \
  -c "ALTER SCHEMA pgboss OWNER TO yu_boss"
GIT_SHA=$REV "\${DC[@]}" up -d --wait api crm site </dev/null
"\${DC[@]}" up -d worker </dev/null
sleep 5
docker ps --filter name=yu-club-worker --filter status=running -q | grep -q . || { docker logs --tail 20 yu-club-worker; echo "!!! worker не запустился"; exit 1; }
docker logs yu-club-worker 2>&1 | grep -q '"msg":"запущен' || { docker logs --tail 20 yu-club-worker; echo "!!! worker не сообщил о старте"; exit 1; }
docker image prune -f --filter label=project=yu-club >/dev/null
echo "→ контейнеры: \$(docker ps --filter name=yu-club- --format '{{.Names}} {{.Status}}' | tr '\n' ';')"
REMOTE
# после пересоздания – засев: Владелец с текущим паролем с мака (без обязательной смены), демо-данные
[ "$RESET" = 1 ] && YU_OWNER_READY=1 deploy/seed-stand.sh

# 4. общий Caddy – только свой блок
codes() { for u in $NEIGHBOURS; do printf '%s ' "$(curl -sk -o /dev/null -m 15 -w '%{http_code}' "$u")"; done; }
BEFORE=$(codes); echo "→ соседи до: $BEFORE"
"${SSH[@]}" "bash -s" <<REMOTE
set -euo pipefail
NEW=\$(mktemp)
# старый блок yu-club (если есть) вырезаем, новый дописываем в конец
awk '/^# >>> yu-club/{skip=1} !skip{print} /^# <<< yu-club/{skip=0}' $CADDY > "\$NEW"
[ -z "\$(tail -n1 "\$NEW")" ] || echo >> "\$NEW"
cat $ROOT/src/deploy/Caddyfile.yu-club >> "\$NEW"
if cmp -s "\$NEW" $CADDY; then echo "→ блок yu-club без изменений"; rm -f "\$NEW"; exit 0; fi
BAK=$CADDY.bak-yu-club-\$(date +%Y%m%d%H%M%S)
cp -p $CADDY "\$BAK"
cat "\$NEW" > $CADDY; rm -f "\$NEW"     # перезапись того же файла: смонтирован в контейнер по inode
if ! docker exec $CADDY_CT caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/yu-club-validate.log 2>&1; then
  cat "\$BAK" > $CADDY; tail -5 /tmp/yu-club-validate.log; echo "Caddy не принял конфиг – вернул копию"; exit 1
fi
docker exec $CADDY_CT caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
echo "→ блок yu-club поставлен, Caddy перечитал конфиг (копия: \$BAK)"
REMOTE
sleep 3
AFTER=$(codes); echo "→ соседи после: $AFTER"
[ "$BEFORE" = "$AFTER" ] || echo "!!! коды соседей изменились: было [$BEFORE], стало [$AFTER] – проверить"

# 5. бэкап по расписанию: 04:40 UTC – дамп, затем проверка восстановления
"${SSH[@]}" "set -e; install -m 700 $ROOT/src/deploy/backup.sh $ROOT/backup.sh; install -m 700 $ROOT/src/deploy/restore-check.sh $ROOT/restore-check.sh; printf 'SHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n40 4 * * * root $ROOT/backup.sh >>$ROOT/backups/backup.log 2>&1 && $ROOT/restore-check.sh >>$ROOT/backups/backup.log 2>&1\n' > /etc/cron.d/yu-club; chmod 644 /etc/cron.d/yu-club"

# 6. проверка снаружи
HEALTH=$(curl -sk -m 20 "https://$DOMAIN/health" || true)
printf '%s https://%s/health %s\n' "$(curl -sk -o /dev/null -m 20 -w '%{http_code}' "https://$DOMAIN/health")" "$DOMAIN" "$HEALTH"
printf '%s http://%s/health → %s\n' "$(curl -s -o /dev/null -m 20 -w '%{http_code}' "http://$DOMAIN/health")" "$DOMAIN" "$(curl -s -o /dev/null -m 20 -w '%{redirect_url}' "http://$DOMAIN/health")"
printf '%s https://%s/ (сайт)\n' "$(curl -sk -o /dev/null -m 20 -w '%{http_code}' "https://$DOMAIN/")" "$DOMAIN"
printf '%s https://%s/login\n' "$(curl -sk -o /dev/null -m 20 -w '%{http_code}' "https://$CRM_DOMAIN/login")" "$CRM_DOMAIN"
printf '%s http://%s/login → %s\n' "$(curl -s -o /dev/null -m 20 -w '%{http_code}' "http://$CRM_DOMAIN/login")" "$CRM_DOMAIN" "$(curl -s -o /dev/null -m 20 -w '%{redirect_url}' "http://$CRM_DOMAIN/login")"
case "$HEALTH" in *"\"version\":\"$REV\""*) echo "→ готово: https://$DOMAIN, CRM https://$CRM_DOMAIN (ревизия $REV)";; *) echo "!!! /health не отдал версию $REV"; exit 1;; esac
