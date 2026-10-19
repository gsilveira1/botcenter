#!/usr/bin/env bash
# Daily backup of PostgreSQL (databases `botcenter` and `evolution`) to restic on Cloudflare R2.
# systemd runs it (botcenter-backup.timer, daily). To run it by hand:
#   sudo systemctl start botcenter-backup.service      # or, with the env file loaded:
#   sudo bash -c 'set -a; . /etc/botcenter/backup.env; set +a; /opt/botcenter/infra/backup/backup.sh'
#
# Steps:
#   1. Disk check: an alert above DISK_ALERT_PERCENT (the backup continues).
#   2. `pg_dump -Fc -Z0` of each database to BACKUP_WORK_DIR (restic compresses and deduplicates).
#   3. `pg_restore --list` of each dump: a damaged dump stops the backup before the upload.
#   4. `restic backup` (one snapshot, tag `postgres`; restic encrypts before the upload).
#   5. `restic forget --keep-daily 7 --keep-weekly 4 --prune`.
#   6. On BACKUP_CHECK_WEEKDAY: `restic check --read-data-subset=10%`.
#   7. Text file metrics for Alloy and a heartbeat to the Uptime Kuma push monitor.
# A failure at any step sends a Discord alert, writes botcenter_backup_last_run_success 0, and exits 1.
# The WhatsApp sessions live in the `evolution` database, so this backup also keeps the connections.
set -euo pipefail

SCRIPT_NAME=backup
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

METRICS_FILE=botcenter_backup.prom
started_epoch="$(date +%s)"
step="start"
work_dir=""

finish() {
  local rc=$?
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf "$work_dir"
  fi
  if [[ $rc -ne 0 ]]; then
    alert "the backup FAILED at the step '${step}' (exit code ${rc}). See: journalctl -u botcenter-backup.service"
    local last_success
    last_success="$(read_metric "$METRICS_FILE" botcenter_backup_last_success_timestamp_seconds)"
    write_metrics "$METRICS_FILE" "# HELP botcenter_backup_last_run_success 1 when the last backup run succeeded.
# TYPE botcenter_backup_last_run_success gauge
botcenter_backup_last_run_success 0
# HELP botcenter_backup_last_success_timestamp_seconds Unix time of the last successful backup.
# TYPE botcenter_backup_last_success_timestamp_seconds gauge
botcenter_backup_last_success_timestamp_seconds ${last_success:-0}" || log_error "could not write the metrics"
  fi
  exit "$rc"
}
trap finish EXIT

step="configuration"
require_vars RESTIC_ENV_FILE BACKUP_HOST_TAG BACKUP_WORK_DIR METRICS_DIR
require_commands docker curl jq
[[ -r "$RESTIC_ENV_FILE" ]] || {
  log_error "cannot read RESTIC_ENV_FILE ($RESTIC_ENV_FILE)"
  exit 1
}

step="disk check"
threshold="${DISK_ALERT_PERCENT:-80}"
for path in / "$BACKUP_WORK_DIR"; do
  mkdir -p "$BACKUP_WORK_DIR"
  used="$(disk_usage_percent "$path")"
  if ((used >= threshold)); then
    alert "disk usage of ${path} is ${used}% (threshold ${threshold}%). The backup continues."
  fi
done

step="dump"
postgres_id="$(compose_container postgres)"
umask 077
work_dir="$(mktemp -d "$BACKUP_WORK_DIR/run.XXXXXX")"
sizes=""
for db in "${BACKUP_DATABASES[@]}"; do
  log "pg_dump of the database ${db}"
  docker exec "$postgres_id" pg_dump -U postgres -d "$db" --format=custom --compress=0 >"$work_dir/${db}.dump"
  step="verify ${db}"
  docker exec -i "$postgres_id" pg_restore --list <"$work_dir/${db}.dump" >/dev/null
  size="$(stat -c %s "$work_dir/${db}.dump")"
  if ((size < 1024)); then
    log_error "the dump of ${db} has only ${size} bytes"
    exit 1
  fi
  sizes+="botcenter_backup_dump_size_bytes{database=\"${db}\"} ${size}"$'\n'
  log "dump of ${db}: ${size} bytes"
  step="dump"
done

step="restic backup"
log "restic backup (host ${BACKUP_HOST_TAG}, tag postgres)"
restic_run --data "$work_dir" backup --host "$BACKUP_HOST_TAG" --tag postgres --no-scan /data

step="restic forget"
restic_run forget --host "$BACKUP_HOST_TAG" --tag postgres --keep-daily 7 --keep-weekly 4 --prune

if [[ "$(date +%u)" == "${BACKUP_CHECK_WEEKDAY:-7}" ]]; then
  step="restic check"
  log "weekly restic check (10 % of the data)"
  restic_run check --read-data-subset=10%
fi

step="report"
finished_epoch="$(date +%s)"
write_metrics "$METRICS_FILE" "# HELP botcenter_backup_last_run_success 1 when the last backup run succeeded.
# TYPE botcenter_backup_last_run_success gauge
botcenter_backup_last_run_success 1
# HELP botcenter_backup_last_success_timestamp_seconds Unix time of the last successful backup.
# TYPE botcenter_backup_last_success_timestamp_seconds gauge
botcenter_backup_last_success_timestamp_seconds ${finished_epoch}
# HELP botcenter_backup_duration_seconds Duration of the last successful backup.
# TYPE botcenter_backup_duration_seconds gauge
botcenter_backup_duration_seconds $((finished_epoch - started_epoch))
# HELP botcenter_backup_dump_size_bytes Size of each database dump of the last successful backup.
# TYPE botcenter_backup_dump_size_bytes gauge
${sizes%$'\n'}"
kuma_push "${KUMA_PUSH_URL_BACKUP:-}" "backup OK in $((finished_epoch - started_epoch)) s" ||
  log_error "the backup succeeded, but the heartbeat failed"
log "backup OK in $((finished_epoch - started_epoch)) s"
