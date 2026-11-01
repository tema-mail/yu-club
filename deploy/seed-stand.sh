#!/usr/bin/env bash
# Засев тест-стенда с мака (после deploy/deploy.sh): первый Владелец (seed-owner.ts) и демо-данные Э0 (db/seed/dev.ts).
# Пароли генерируются на маке один раз и лежат только там (600):
#   ~/.config/yu-club/admin-login, admin-pass – Владелец (после первого входа CRM потребует сменить пароль);
#   ~/.config/yu-club/demo-pass – демо-сотрудники засева.
# На сервер пароли идут через stdin ssh – не в аргументах и не в файлах. Повторный запуск безопасен:
# Владелец уже есть – шаг пропускается, демо-засев не плодит дубли. Только для stage/dev (засев сам откажет на prod).
#   deploy/seed-stand.sh
#   YU_OWNER_READY=1 deploy/seed-stand.sh – после deploy.sh --reset-stage: пароль Владельца уже сменён раньше,
#     обязательную смену не включаем (только stage).
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
  if [ '"${YU_OWNER_READY:-0}"' = 1 ]; then
    grep -qx APP_ENV=stage '"$ROOT"'/.env || { echo "!!! YU_OWNER_READY только на stage"; exit 1; }
    docker exec -i yu-club-postgres psql -U postgres -d yu_club -v ON_ERROR_STOP=1 -q -v email="$OWNER_EMAIL" \
      <<< "UPDATE app.staff SET must_change_password = false WHERE role = '"'"'owner'"'"' AND email = :'"'"'email'"'"';"
    echo "→ пароль Владельца – текущий с мака, смена не требуется (стенд пересоздан)"
  fi
else
  echo "→ активный Владелец уже есть – seed-owner пропущен"
fi
"${DC[@]}" run --rm -T --no-deps -e SEED_PASSWORD api node db/seed/dev.ts </dev/null'

printf '%s\n%s\n%s\n' "$(cat "$CFG/admin-login")" "$(cat "$CFG/admin-pass")" "$(cat "$CFG/demo-pass")" \
  | "${SSH[@]}" "bash -c $(printf '%q' "$REMOTE")"
echo "→ засев готов; вход: $(cat "$CFG/admin-login") / пароль в $CFG/admin-pass"
