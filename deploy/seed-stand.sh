#!/usr/bin/env bash
# Засев тест-стенда с мака (после deploy/deploy.sh): первый Владелец (seed-owner.ts) и демо-данные Э0 (db/seed/dev.ts).
# Пароли генерируются на маке один раз и лежат только там (600):
#   ~/.config/yu-club/admin-login, admin-pass – Владелец (после первого входа CRM потребует сменить пароль);
#   ~/.config/yu-club/demo-pass – демо-сотрудники засева.
# На сервер пароли идут через stdin ssh – не в аргументах и не в файлах. Повторный запуск безопасен:
# Владелец уже есть – шаг пропускается, демо-засев не плодит дубли. Только для stage/dev (засев сам откажет на prod).
#   deploy/seed-stand.sh
set -euo pipefail
HOST=${YU_HOST:-root@45.12.72.227}
KEY=${YU_KEY:-$HOME/.ssh/omni_assistant_firstvds_ed25519}
ROOT=${YU_ROOT:-/opt/yu-club}
CFG=${YU_CFG:-$HOME/.config/yu-club}
EMAIL=${YU_OWNER_EMAIL:-owner@yu-club.test}
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=20 "$HOST")

mkdir -p "$CFG"; chmod 700 "$CFG"
( umask 077
  [ -s "$CFG/admin-login" ] || printf '%s\n' "$EMAIL" > "$CFG/admin-login"
  [ -s "$CFG/admin-pass" ] || openssl rand -hex 16 > "$CFG/admin-pass"
  [ -s "$CFG/demo-pass" ] || openssl rand -hex 16 > "$CFG/demo-pass" )
chmod 600 "$CFG/admin-login" "$CFG/admin-pass" "$CFG/demo-pass"

# shellcheck disable=SC2016 # переменные раскрываются на сервере
REMOTE='set -euo pipefail
IFS= read -r OWNER_EMAIL; IFS= read -r OWNER_PASSWORD; IFS= read -r SEED_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD SEED_PASSWORD
cd '"$ROOT"'/src/deploy
DC=(docker compose --env-file '"$ROOT"'/.env -f compose.yml)
N=$(docker exec yu-club-postgres psql -U postgres -d yu_club -At -c "SELECT count(*) FROM app.staff WHERE role = '"'"'owner'"'"' AND status = '"'"'active'"'"'")
if [ "$N" = 0 ]; then
  "${DC[@]}" run --rm -T --no-deps -e OWNER_EMAIL -e OWNER_PASSWORD api node apps/api/src/modules/staff/seed-owner.ts </dev/null
else
  echo "→ активный Владелец уже есть – seed-owner пропущен"
fi
"${DC[@]}" run --rm -T --no-deps -e SEED_PASSWORD api node db/seed/dev.ts </dev/null'

printf '%s\n%s\n%s\n' "$(cat "$CFG/admin-login")" "$(cat "$CFG/admin-pass")" "$(cat "$CFG/demo-pass")" \
  | "${SSH[@]}" "bash -c $(printf '%q' "$REMOTE")"
echo "→ засев готов; вход: $(cat "$CFG/admin-login") / пароль в $CFG/admin-pass"
