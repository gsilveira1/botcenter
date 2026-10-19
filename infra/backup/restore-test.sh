#!/usr/bin/env bash
# Monthly restore test: a backup without a tested restore does not count (architecture, section
# "Observabilidade, backup e operação").
# systemd runs it (botcenter-restore-test.timer, monthly). It can also run on a different machine
# with Docker and the same restic.env and backup.env (recommended for a full disaster drill).
#
# Steps:
#   1. Read the latest restic snapshot (tag `postgres`, host BACKUP_HOST_TAG). Fail when it is older
#      than RESTORE_MAX_SNAPSHOT_AGE_HOURS.
#   2. Restore the dumps to a temporary directory.
#   3. Start a temporary PostgreSQL 16 container (no network, 512 MB) and `pg_restore` both databases.
#   4. Sanity queries: the applied Prisma migrations (at least one), the latest migration, the row
#      counts of the main tables, and the Evolution instances and sessions.
#      RESTORE_MIN_TENANTS (default 0) is the minimum number of tenants.
#   5. Remove the container and the files, write the text file metrics, and send the heartbeat.
# A failure sends a Discord alert and exits 1.
set -euo pipefail

SCRIPT_NAME=restore-test
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

METRICS_FILE=botcenter_restore_test.prom
started_epoch="$(date +%s)"
step="start"
work_dir=""
container=""

finish() {
  local rc=$?
  if [[ -n "$container" ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || log_error "could not remove the container $container"
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf "$work_dir"
  fi
  if [[ $rc -ne 0 ]]; then
    alert "the restore test FAILED at the step '${step}' (exit code ${rc}). See: journalctl -u botcenter-restore-test.service"
    local last_success
    last_success="$(read_metric "$METRICS_FILE" botcenter_restore_test_last_success_timestamp_seconds)"
    write_metrics "$METRICS_FILE" "# HELP botcenter_restore_test_last_run_success 1 when the last restore test succeeded.
# TYPE botcenter_restore_test_last_run_success gauge
botcenter_restore_test_last_run_success 0
# HELP botcenter_restore_test_last_success_timestamp_seconds Unix time of the last successful restore test.
# TYPE botcenter_restore_test_last_success_timestamp_seconds gauge
botcenter_restore_test_last_success_timestamp_seconds ${last_success:-0}" || log_error "could not write the metrics"
  fi
  exit "$rc"
}
trap finish EXIT

step="configuration"
require_vars RESTIC_ENV_FILE BACKUP_HOST_TAG BACKUP_WORK_DIR METRICS_DIR
require_commands docker curl jq
max_age_hours="${RESTORE_MAX_SNAPSHOT_AGE_HOURS:-30}"
min_tenants="${RESTORE_MIN_TENANTS:-0}"

step="snapshot"
snapshot_json="$(restic_run snapshots --json --latest 1 --host "$BACKUP_HOST_TAG" --tag postgres)"
snapshot_id="$(jq -r 'if length == 0 then "" else .[-1].short_id end' <<<"$snapshot_json")"
snapshot_time="$(jq -r 'if length == 0 then "" else .[-1].time end' <<<"$snapshot_json")"
if [[ -z "$snapshot_id" ]]; then
  log_error "no snapshot with the tag 'postgres' for the host ${BACKUP_HOST_TAG}"
  exit 1
fi
age_hours=$((($(date +%s) - $(date -d "$snapshot_time" +%s)) / 3600))
log "latest snapshot ${snapshot_id} at ${snapshot_time} (${age_hours} h old)"
if ((age_hours > max_age_hours)); then
  log_error "the latest snapshot is ${age_hours} h old (limit ${max_age_hours} h)"
  exit 1
fi

step="restore files"
mkdir -p "$BACKUP_WORK_DIR"
work_dir="$(mktemp -d "$BACKUP_WORK_DIR/restore.XXXXXX")"
restic_run --data "$work_dir" restore "$snapshot_id" --target /data
# The snapshot keeps the path /data/<db>.dump. The temporary PostgreSQL (uid 70) reads the files.
dump_dir="$work_dir/data"
for db in "${BACKUP_DATABASES[@]}"; do
  [[ -s "$dump_dir/${db}.dump" ]] || {
    log_error "the snapshot has no ${db}.dump"
    exit 1
  }
done
chmod 755 "$work_dir" "$dump_dir"
chmod 644 "$dump_dir"/*.dump

step="start postgres"
container="botcenter-restore-test-$(date +%Y%m%d%H%M%S)"
docker run -d --name "$container" \
  --network none \
  --memory 512m \
  --user 70:70 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" \
  -v "$dump_dir:/restore:ro" \
  "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -q 2>/dev/null; then
    break
  fi
  sleep 2
done
docker exec "$container" pg_isready -U postgres -q

psql_value() {
  docker exec "$container" psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d "$1" -c "$2"
}

for db in "${BACKUP_DATABASES[@]}"; do
  step="pg_restore ${db}"
  docker exec "$container" createdb -U postgres "$db"
  docker exec "$container" pg_restore -U postgres -d "$db" --no-owner --no-privileges --exit-on-error "/restore/${db}.dump"
  log "database ${db} restored"
done

step="sanity checks"
migrations="$(psql_value botcenter "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
latest_migration="$(psql_value botcenter "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1")"
tenants="$(psql_value botcenter "SELECT count(*) FROM tenants")"
instances="$(psql_value botcenter "SELECT count(*) FROM instances")"
messages="$(psql_value botcenter "SELECT count(*) FROM messages")"
evolution_instances="$(psql_value evolution 'SELECT count(*) FROM "Instance"')"
evolution_sessions="$(psql_value evolution 'SELECT count(*) FROM "Session"')"
log "migrations=${migrations} latest=${latest_migration} tenants=${tenants} instances=${instances} messages=${messages} evolution_instances=${evolution_instances} evolution_sessions=${evolution_sessions}"

if ((migrations < 1)); then
  log_error "the restored database has no applied Prisma migration"
  exit 1
fi
if ((tenants < min_tenants)); then
  log_error "tenants=${tenants} is below RESTORE_MIN_TENANTS=${min_tenants}"
  exit 1
fi

step="report"
finished_epoch="$(date +%s)"
write_metrics "$METRICS_FILE" "# HELP botcenter_restore_test_last_run_success 1 when the last restore test succeeded.
# TYPE botcenter_restore_test_last_run_success gauge
botcenter_restore_test_last_run_success 1
# HELP botcenter_restore_test_last_success_timestamp_seconds Unix time of the last successful restore test.
# TYPE botcenter_restore_test_last_success_timestamp_seconds gauge
botcenter_restore_test_last_success_timestamp_seconds ${finished_epoch}
# HELP botcenter_restore_test_duration_seconds Duration of the last successful restore test.
# TYPE botcenter_restore_test_duration_seconds gauge
botcenter_restore_test_duration_seconds $((finished_epoch - started_epoch))"
kuma_push "${KUMA_PUSH_URL_RESTORE_TEST:-}" "restore test OK: snapshot ${snapshot_id}, ${tenants} tenants" ||
  log_error "the restore test succeeded, but the heartbeat failed"
log "restore test OK (snapshot ${snapshot_id}, latest migration ${latest_migration})"
