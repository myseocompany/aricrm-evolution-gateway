#!/usr/bin/env bash
set -euo pipefail

STACK_DIR="${STACK_DIR:-/opt/aricrm-gateway}"
ENV_FILE="${ENV_FILE:-${STACK_DIR}/.env}"

if [[ ! -r "$ENV_FILE" ]]; then
  logger -t aricrm-gateway-monitor "configuration unreadable: ${ENV_FILE}"
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

pending_limit="${PENDING_AGE_ALERT_SECONDS:-300}"
dlq_limit="${DLQ_ALERT_COUNT:-1}"
disk_limit="${DISK_ALERT_PERCENT:-80}"
compose=(docker compose --project-directory "$STACK_DIR")

query() {
  "${compose[@]}" exec -T postgres psql -U gateway -d gateway -Atqc "$1"
}

pending_age="$(query "SELECT COALESCE(floor(EXTRACT(epoch FROM now() - min(created_at) FILTER (WHERE state = 'pending'))), 0)::bigint FROM webhook_events;")"
dead_count="$(query "SELECT count(*) FROM webhook_events WHERE state = 'dead';")"
disk_percent="$(df -P /var/lib/docker | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')"

alert() {
  local kind="$1" detail="$2"
  logger -t aricrm-gateway-monitor "${kind}: ${detail}"
  if [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
    curl --fail --silent --show-error --max-time 10 \
      -H 'content-type: application/json' \
      --data "{\"service\":\"aricrm-webhook-gateway\",\"alert\":\"${kind}\",\"detail\":\"${detail}\"}" \
      "$ALERT_WEBHOOK_URL" >/dev/null || logger -t aricrm-gateway-monitor "alert_delivery_failed: ${kind}"
  fi
}

if (( pending_age >= pending_limit )); then alert pending_age "${pending_age}s >= ${pending_limit}s"; fi
if (( dead_count >= dlq_limit )); then alert dlq "${dead_count} >= ${dlq_limit}"; fi
if (( disk_percent >= disk_limit )); then alert disk "${disk_percent}% >= ${disk_limit}%"; fi
