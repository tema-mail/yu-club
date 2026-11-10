#!/usr/bin/env bash
# Проверка живости yu-club для cron владельца (17 §13.3, 18 §9.4): дёргает GET /health/deep и решает, тревога или нет.
# Печатает одну строку и выходит с кодом: 0 – всё в порядке, 1 – тревога (строка годится в текст оповещения), 2 – неверный вызов.
# Отправку оповещения (Telegram, почта) скрипт не делает – это техдолг владельца: cron ловит код 1 и сам шлёт строку, например
#   */5 * * * * /opt/yu-club/scripts/monitor-check.sh https://yu-club.example.ru || curl -s -X POST "$ALERT_URL" --data-urlencode "text=$(...)"
# Использование: monitor-check.sh <адрес сайта или API> [ok|degraded]
#   второй аргумент (или MONITOR_ALERT_ON) – с какого статуса тревога: degraded (по умолчанию) или down (тогда degraded – только печать).
# Тело /health/deep: {"status":"ok|degraded|down","version":...,"checks":{...}} – status первым ключом (server.ts), jq не нужен.
# curl -k: стенд живёт на tls internal (nip.io); на боевом домене с настоящим сертификатом -k безвреден.
set -u
BASE="${1:-${MONITOR_URL:-}}"
ALERT_ON="${2:-${MONITOR_ALERT_ON:-degraded}}"
TIMEOUT="${MONITOR_TIMEOUT:-15}"
if [ -z "$BASE" ]; then
  echo "использование: $0 <https://адрес> [degraded|down]" >&2
  exit 2
fi
case "$ALERT_ON" in degraded|down) ;; *) echo "второй аргумент: degraded или down" >&2; exit 2 ;; esac
URL="${BASE%/}/health/deep"

BODY=$(curl -sk -m "$TIMEOUT" -o - -w '\n%{http_code}' "$URL" 2>/dev/null)
CURL_CODE=$?
HTTP=$(printf '%s' "$BODY" | tail -n 1)
JSON=$(printf '%s' "$BODY" | sed '$d')

if [ "$CURL_CODE" -ne 0 ] || [ -z "$HTTP" ] || [ "$HTTP" = "000" ]; then
  echo "АВАРИЯ yu-club: $URL не отвечает (curl код $CURL_CODE, таймаут ${TIMEOUT} с)"
  exit 1
fi
STATUS=$(printf '%s' "$JSON" | sed -n 's/^{"status":"\([a-z]*\)".*/\1/p')
if [ -z "$STATUS" ]; then
  echo "АВАРИЯ yu-club: $URL отдал HTTP $HTTP без статуса (не API? тело: $(printf '%s' "$JSON" | head -c 120))"
  exit 1
fi
# проблемные проверки – имена с их статусом, без чисел (краткая строка для оповещения)
PROBLEMS=$(printf '%s' "$JSON" | grep -o '"[a-z]*":{"status":"\(degraded\|down\)"' | sed 's/"\([a-z]*\)":{"status":"\([a-z]*\)"/\1=\2/' | tr '\n' ' ')
case "$STATUS" in
  ok)
    echo "ok yu-club: HTTP $HTTP, всё в порядке"
    exit 0 ;;
  degraded)
    if [ "$ALERT_ON" = "down" ]; then
      echo "degraded yu-club (без тревоги): $PROBLEMS"
      exit 0
    fi
    echo "ТРЕВОГА yu-club: degraded – $PROBLEMS"
    exit 1 ;;
  down)
    echo "АВАРИЯ yu-club: down (HTTP $HTTP) – $PROBLEMS"
    exit 1 ;;
  *)
    echo "АВАРИЯ yu-club: неизвестный статус '$STATUS' (HTTP $HTTP)"
    exit 1 ;;
esac
