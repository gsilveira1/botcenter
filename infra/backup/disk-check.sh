#!/usr/bin/env bash
# Disk usage alert (architecture: "disco acima de 80%"). systemd runs it every 15 minutes
# (botcenter-disk-check.timer). Grafana Cloud has the same alert (alerts.yml, HostDiskUsageHigh);
# this script is the local fallback when Alloy or Grafana Cloud does not work.
# One alert when the usage goes above DISK_ALERT_PERCENT, then one each DISK_ALERT_REPEAT_HOURS.
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

rc=0
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
