#!/usr/bin/env bash
# Выкладка тест-стенда yu-club с мака (S0-19): код из git HEAD → $ROOT/src на сервере, сборка образов API и CRM,
# Postgres (роли – deploy/initdb), миграции под yu_owner, запуск API, свой блок в общем Caddy
# (копия → замена своего блока → validate → reload; соседи проверяются до и после),
# бэкап по расписанию 04:40 UTC (backup.sh, затем restore-check.sh), проверка снаружи.
# Сервер, ключ, адрес и сеть Caddy – окружением; переезд к заказчику = другие значения + свой .env.
#   deploy/deploy.sh
#   YU_HOST=root@1.2.3.4 YU_DOMAIN=crm.example.ru YU_CADDY=/etc/caddy/Caddyfile YU_CADDY_CT=caddy deploy/deploy.sh
# Пароли БД, SESSION_PEPPER и пара VAPID генерируются на сервере один раз в $ROOT/.env (600) и никуда не выводятся.
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
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=20 "$HOST")

[ -z "$(git status --porcelain -- apps db deploy package.json package-lock.json .dockerignore)" ] || { echo "Есть незакоммиченные правки – сначала коммит"; exit 1; }
REV=$(git rev-parse --short HEAD)
echo "→ выкладываю $REV на $DOMAIN"

# 1. код
git archive --format=tar HEAD | "${SSH[@]}" "set -e; mkdir -p $ROOT/data $ROOT/backups; chmod 700 $ROOT/backups; rm -rf $ROOT/src.new; mkdir $ROOT/src.new; tar -x -C $ROOT/src.new; rm -rf $ROOT/src.old; [ -d $ROOT/src ] && mv $ROOT/src $ROOT/src.old; mv $ROOT/src.new $ROOT/src; echo $REV > $ROOT/src/REVISION"
# CRM собирается здесь (дерево чистое = HEAD): на стенде astro build не помещается в память
PATH="$HOME/.local/node/bin:$PATH" npm run -s build -w @yu/crm >/dev/null
tar -C apps/crm -cf - dist | "${SSH[@]}" "set -e; mkdir -p $ROOT/src/apps/crm; tar -x -C $ROOT/src/apps/crm"
echo "→ CRM собрана на маке и отправлена"

# 2. окружение – один раз, пароли генерируются на сервере
"${SSH[@]}" "set -e; test -f $ROOT/.env || { umask 077; printf 'APP_ENV=stage\nPUBLIC_SITE_URL=https://%s\nPOSTGRES_PASSWORD=%s\nYU_OWNER_PASSWORD=%s\nYU_APP_PASSWORD=%s\nDATA_DIR=%s/data\nBACKUP_DIR=%s/backups\nBACKUP_RETENTION_DAYS=14\nCADDY_NETWORK=dzenbot_default\n' $DOMAIN \$(openssl rand -hex 24) \$(openssl rand -hex 24) \$(openssl rand -hex 24) $ROOT $ROOT > $ROOT/.env; echo '→ создан $ROOT/.env (600)'; }; chmod 600 $ROOT/.env"
# SESSION_PEPPER (K12) – тоже один раз; на стенде, где .env создан раньше, дописывается. Смена значения = выход всех сотрудников.
"${SSH[@]}" "set -e; grep -q '^SESSION_PEPPER=' $ROOT/.env || { umask 077; printf 'SESSION_PEPPER=%s\n' \$(openssl rand -hex 32) >> $ROOT/.env; echo '→ в $ROOT/.env добавлен SESSION_PEPPER'; }; chmod 600 $ROOT/.env"
# VAPID (Web Push, S1-15) – пара P-256 тоже один раз: SEC1 DER 121 байт, закрытый ключ – байты 8..39, открытый – последние 65.
# Смена пары = все подписки браузеров недействительны (клиентам подписываться заново).
"${SSH[@]}" "set -e; grep -q '^VAPID_PRIVATE_KEY=' $ROOT/.env || { umask 077; K=\$(mktemp); openssl ecparam -name prime256v1 -genkey -noout -outform DER -out \$K; test \$(wc -c <\$K) -eq 121; printf 'VAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\nVAPID_SUBJECT=https://%s\n' \$(tail -c 65 \$K | base64 | tr '+/' '-_' | tr -d '=\n') \$(head -c 39 \$K | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n') $DOMAIN >> $ROOT/.env; rm -f \$K; echo '→ в $ROOT/.env добавлены VAPID_*'; }; chmod 600 $ROOT/.env"

# 3. образ, база, миграции, API
"${SSH[@]}" "bash -s" <<REMOTE
set -euo pipefail
cd $ROOT/src/deploy
DC=(docker compose --env-file $ROOT/.env -f compose.yml)
GIT_SHA=$REV "\${DC[@]}" build --pull -q api </dev/null   # по одному образу – меньше пик памяти
"\${DC[@]}" build --pull -q crm </dev/null
"\${DC[@]}" up -d --wait postgres </dev/null
"\${DC[@]}" run --rm -T migrate </dev/null   # без stdin: иначе run съест остаток этого скрипта
GIT_SHA=$REV "\${DC[@]}" up -d --wait api crm </dev/null
docker image prune -f --filter label=project=yu-club >/dev/null
echo "→ контейнеры: \$(docker ps --filter name=yu-club- --format '{{.Names}} {{.Status}}' | tr '\n' ';')"
REMOTE

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
printf '%s https://%s/login\n' "$(curl -sk -o /dev/null -m 20 -w '%{http_code}' "https://$CRM_DOMAIN/login")" "$CRM_DOMAIN"
printf '%s http://%s/login → %s\n' "$(curl -s -o /dev/null -m 20 -w '%{http_code}' "http://$CRM_DOMAIN/login")" "$CRM_DOMAIN" "$(curl -s -o /dev/null -m 20 -w '%{redirect_url}' "http://$CRM_DOMAIN/login")"
case "$HEALTH" in *"\"version\":\"$REV\""*) echo "→ готово: https://$DOMAIN, CRM https://$CRM_DOMAIN (ревизия $REV)";; *) echo "!!! /health не отдал версию $REV"; exit 1;; esac
