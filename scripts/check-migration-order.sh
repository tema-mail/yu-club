#!/usr/bin/env bash
# Новая миграция в ветке должна быть старше (по номеру) всех миграций базы слияния.
# Раннер db/migrate.ts отвергает миграцию младше применённой, а на свежей базе тестов это не видно –
# ловится только на стенде. Было дважды: 0440 → 0447 и 0447 → 0450 (слияние клиентов, 10–11.11.2026).
# Запуск: scripts/check-migration-order.sh [база]   база по умолчанию – origin/main, в CI на push в main – HEAD^1.
set -euo pipefail
BASE="${1:-origin/main}"
git rev-parse --verify -q "$BASE^{commit}" >/dev/null || { echo "нет ревизии $BASE – нечего сравнивать"; exit 0; }
MB="$(git merge-base "$BASE" HEAD)"
num() { sed -E 's#.*/([0-9]{4})_.*#\1#'; }
MAX="$(git ls-tree --name-only "$MB" db/migrations/ | grep -E '/[0-9]{4}_.*\.sql$' | num | sort -n | tail -1)"
ADDED="$(git diff --name-only --diff-filter=A "$MB" HEAD -- db/migrations/ | grep -E '/[0-9]{4}_.*\.sql$' || true)"
[ -z "$ADDED" ] && { echo "новых миграций нет (база $BASE, последняя $MAX)"; exit 0; }
FAIL=0
while read -r f; do
  n="$(echo "$f" | num)"
  if [ "$((10#$n))" -le "$((10#$MAX))" ]; then echo "!!! $f: номер $n не больше последней миграции базы $MAX – переименуйте"; FAIL=1; fi
done <<< "$ADDED"
DUP="$(git ls-tree --name-only HEAD db/migrations/ | grep -E '/[0-9]{4}_' | num | sort | uniq -d)"
[ -n "$DUP" ] && { echo "!!! повтор номера миграции: $DUP"; FAIL=1; }
[ "$FAIL" = 0 ] && echo "порядок миграций в норме: новые $(echo "$ADDED" | num | tr '\n' ' ')> $MAX"
exit "$FAIL"
