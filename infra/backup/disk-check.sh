#!/usr/bin/env bash
# Disk usage alert (architecture: "disco acima de 80%"). systemd runs it every 15 minutes
# (botcenter-disk-check.timer). Grafana Cloud has the same alert (alerts.yml, HostDiskUsageHigh);
# this script is the local fallback when Alloy or Grafana Cloud does not work.
# One alert when the usage goes above DISK_ALERT_PERCENT, then one each DISK_ALERT_REPEAT_HOURS.
# It also writes the disk metrics of the host for Alloy (botcenter_host_disk.prom in METRICS_DIR):
# Alloy has no mount of the host root (SEC-07), so its node exporter has no filesystem collector.
set -euo pipefail

SCRIPT_NAME=disk-check
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

require_commands df curl
threshold="${DISK_ALERT_PERCENT:-80}"
repeat_seconds=$((${DISK_ALERT_REPEAT_HOURS:-6} * 3600))
state_dir="${STATE_DIR:-/var/lib/botcenter/state}"
mkdir -p "$state_dir"

# write_disk_metrics : the size and the free space (for a non-root user, as `df`) of / and /var/lib/docker.
write_disk_metrics() {
  local content path size avail
  content="# HELP botcenter_host_filesystem_size_bytes Size of the file system of the mount point.
# TYPE botcenter_host_filesystem_size_bytes gauge
# HELP botcenter_host_filesystem_avail_bytes Free space of the file system for a non-root user.
# TYPE botcenter_host_filesystem_avail_bytes gauge"
  for path in / /var/lib/docker; do
    [[ -d "$path" ]] || continue
    read -r size avail < <(df -P -B1 "$path" | awk 'NR == 2 { print $2, $4 }')
    content+=$'\n'"botcenter_host_filesystem_size_bytes{mountpoint=\"${path}\"} ${size}"
    content+=$'\n'"botcenter_host_filesystem_avail_bytes{mountpoint=\"${path}\"} ${avail}"
  done
  write_metrics botcenter_host_disk.prom "$content"
}

rc=0
if ! write_disk_metrics; then
  log_error "could not write the disk metrics"
  rc=1
fi
for path in / /var/lib/docker; do
  [[ -d "$path" ]] || continue
  used="$(disk_usage_percent "$path")"
  state_file="$state_dir/disk-alert-$(tr '/' '_' <<<"$path")"
  if ((used >= threshold)); then
    now="$(date +%s)"
    last="$(cat "$state_file" 2>/dev/null || echo 0)"
    if ((now - last >= repeat_seconds)); then
      alert "disk usage of ${path} is ${used}% (threshold ${threshold}%). See docs/runbook.md, procedure 'Disk full'."
      echo "$now" >"$state_file"
    else
      log "disk usage of ${path} is ${used}% (alert already sent)"
    fi
    rc=1
  else
    if [[ -f "$state_file" ]]; then
      log "disk usage of ${path} is back to ${used}%"
      rm -f "$state_file"
    fi
  fi
done
exit "$rc"
