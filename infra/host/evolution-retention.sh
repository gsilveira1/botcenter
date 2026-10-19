#!/usr/bin/env bash
# Deletes the Evolution `Message` rows older than EVOLUTION_MESSAGE_RETENTION_DAYS (default 7).
# The Evolution API keeps the new messages (DATABASE_SAVE_DATA_NEW_MESSAGE=true, for the Baileys
# retries) but has no retention. The architecture keeps raw payloads for 7 days (LGPD).
# systemd runs it daily (botcenter-evolution-retention.timer). `MessageUpdate` rows go by cascade.
set -euo pipefail

SCRIPT_NAME=evolution-retention
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
. "$SCRIPT_DIR/../backup/lib.sh"

on_exit() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    alert "the retention of the Evolution messages FAILED (exit code $rc)"
  fi
}
trap on_exit EXIT

require_commands docker curl jq
days="${EVOLUTION_MESSAGE_RETENTION_DAYS:-7}"
schema="${EVOLUTION_DB_SCHEMA:-evolution_api}"
batch="${EVOLUTION_RETENTION_BATCH:-5000}"
[[ "$days" =~ ^[0-9]+$ && "$batch" =~ ^[0-9]+$ && "$schema" =~ ^[a-z_]+$ ]] || {
  log_error "EVOLUTION_MESSAGE_RETENTION_DAYS, EVOLUTION_RETENTION_BATCH, or EVOLUTION_DB_SCHEMA is not valid"
  exit 64
}
postgres_id="$(compose_container postgres)"

total=0
while :; do
  deleted="$(docker exec "$postgres_id" psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d evolution -c "
    WITH old AS (
      SELECT id FROM ${schema}.\"Message\"
      WHERE \"messageTimestamp\" < extract(epoch FROM now() - interval '${days} days')::int
      LIMIT ${batch}
    ), gone AS (
      DELETE FROM ${schema}.\"Message\" m USING old WHERE m.id = old.id RETURNING 1
    )
    SELECT count(*) FROM gone")"
  total=$((total + deleted))
  ((deleted >= batch)) || break
done
log "deleted ${total} Evolution message rows older than ${days} days"
