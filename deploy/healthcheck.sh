#!/usr/bin/env bash
set -euo pipefail
# Healthcheck прод + стенд (cron, каждые 2 мин):
#  - сервис не отвечает -> автоперезапуск systemd-юнита и перепроверка;
#  - Telegram-алерт при смене состояния (упал / перезапущен / вернулся),
#    без спама: состояние хранится в /var/tmp/factory-os-health.
# Настройка алертов: /etc/factory-os-alert.env
#   ALERT_CHAT_ID=<telegram chat id>          # кому слать (без него - только лог)
#   ALERT_BOT_TOKEN=<token>                    # опционально; по умолчанию BOT_TOKEN прод-.env

STATE_DIR=/var/tmp/factory-os-health
mkdir -p "$STATE_DIR"

[ -f /etc/factory-os-alert.env ] && . /etc/factory-os-alert.env
if [ -z "${ALERT_BOT_TOKEN:-}" ] && [ -f /opt/factory-os/.env ]; then
  ALERT_BOT_TOKEN=$(grep -E '^BOT_TOKEN=' /opt/factory-os/.env | head -1 | cut -d= -f2- | tr -d '"\r' || true)
fi

notify() {
  local text="$1"
  echo "[$(date '+%F %T')] $text"
  if [ -n "${ALERT_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ]; then
    curl -s -m 10 "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
      -d chat_id="${ALERT_CHAT_ID}" --data-urlencode text="$text" >/dev/null || true
  fi
}

# check <имя> <url> <systemd-юнит|-> ; юнит '-' = только алерт, без рестарта (nginx-слой).
check() {
  local name="$1" url="$2" svc="$3"
  local state_file="$STATE_DIR/$name"
  local prev
  prev=$(cat "$state_file" 2>/dev/null || echo up)

  if curl -fsS -m 10 "$url" >/dev/null 2>&1; then
    [ "$prev" != up ] && notify "✅ Factory OS [$name] снова отвечает."
    echo up > "$state_file"
    return 0
  fi

  if [ "$svc" != "-" ]; then
    systemctl restart "$svc" 2>/dev/null || true
    sleep 8
    if curl -fsS -m 10 "$url" >/dev/null 2>&1; then
      notify "⚠️ Factory OS [$name] падал — автоматически перезапущен, снова работает."
      echo up > "$state_file"
      return 0
    fi
  fi

  [ "$prev" != down ] && notify "🔴 Factory OS [$name] НЕ отвечает ($url)${svc:+, автоперезапуск не помог} — нужно вмешательство."
  echo down > "$state_file"
  return 0
}

check prod        "http://localhost:3000/healthz" factory-os
check stand       "http://localhost:3100/healthz" factory-os-test
check prod-https  "https://138-249-7-204.sslip.io/healthz" -
check stand-https "https://test.138.249.7.204.sslip.io/healthz" -
