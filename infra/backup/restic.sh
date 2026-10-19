#!/usr/bin/env bash
# Runs a restic command against the backup repository (the same container and env file as backup.sh).
#   sudo bash -c 'set -a; . /etc/botcenter/backup.env; set +a; /opt/botcenter/infra/backup/restic.sh snapshots'
#   ... restic.sh init                     # once, before the first backup
#   ... restic.sh check --read-data-subset=10%
#   ... restic.sh --data /root/restore restore latest --tag postgres --target /data
set -euo pipefail

SCRIPT_NAME=restic
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

require_vars RESTIC_ENV_FILE
require_commands docker
if [[ $# -eq 0 ]]; then
  log_error "give a restic command, for example: snapshots"
  exit 64
fi
restic_run "$@"
