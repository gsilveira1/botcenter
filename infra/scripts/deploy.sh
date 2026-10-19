#!/usr/bin/env bash
# Deploys a release on the production host. The release workflow prints the command:
#   sudo /opt/botcenter/infra/scripts/deploy.sh v0.1.0 ghcr.io/<owner>/botcenter-api:v0.1.0@sha256:<digest>
#
# Steps:
#   1. Check out the tag in /opt/botcenter (the Compose files, the Caddyfile, and the scripts of the release).
#   2. Write the image (tag AND digest) to compose.env. The previous value goes to compose.env.previous.
#   3. `pull`, then the one-shot `migrate` service, then `up -d` (api and worker wait for migrate).
#   4. Wait until api and worker are healthy and /health/ready answers 200.
# A failure sends a Discord alert and prints the rollback command (the previous image).
# WARNING: a rollback does not revert a database migration. Migrations must be backward compatible
# (add columns and tables; remove them only in a later release).
set -euo pipefail

SCRIPT_NAME=deploy
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=infra/backup/lib.sh
. "$ROOT/infra/backup/lib.sh"

ENV_DIR="${BOTCENTER_ENV_DIR:-/etc/botcenter}"
ENV_FILE="$ENV_DIR/compose.env"
COMPOSE="$SCRIPT_DIR/compose.sh"
if [[ -r "$ENV_DIR/backup.env" ]]; then
  # The Discord webhook and the host tag for the alerts.
  set -a
  # shellcheck source=/dev/null
  . "$ENV_DIR/backup.env"
  set +a
fi

[[ $# -eq 2 ]] || {
  log_error "usage: deploy.sh <git tag> <image@sha256:digest>"
  exit 64
}
tag="$1"
image="$2"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || {
  log_error "the tag '$tag' is not a release tag (vX.Y.Z)"
  exit 64
}
[[ "$image" =~ ^[a-z0-9./_-]+:[0-9A-Za-z._-]+@sha256:[0-9a-f]{64}$ ]] || {
  log_error "the image must have a tag and a digest (name:tag@sha256:...)"
  exit 64
}
require_commands git docker curl jq
previous="$(sed -n 's/^BOTCENTER_IMAGE=//p' "$ENV_FILE" | tail -1)"

on_exit() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    alert "the deploy of ${tag} FAILED (exit code ${rc}). Rollback: sudo $SCRIPT_DIR/deploy.sh <previous tag> ${previous:-<previous image>}"
  fi
}
trap on_exit EXIT

log "check out ${tag} in ${ROOT}"
git -C "$ROOT" fetch --tags --quiet origin
git -C "$ROOT" -c advice.detachedHead=false checkout --quiet "refs/tags/${tag}"

log "image ${image} (previous: ${previous:-none})"
cp -p "$ENV_FILE" "$ENV_FILE.previous"
if grep -q '^BOTCENTER_IMAGE=' "$ENV_FILE"; then
  sed -i "s#^BOTCENTER_IMAGE=.*#BOTCENTER_IMAGE=${image}#" "$ENV_FILE"
else
  echo "BOTCENTER_IMAGE=${image}" >>"$ENV_FILE"
fi

"$COMPOSE" config --quiet
"$COMPOSE" pull --quiet
log "database migrations"
"$COMPOSE" run --rm --no-deps migrate
log "start the stack"
"$COMPOSE" up -d --remove-orphans

log "wait for the health checks"
healthy=false
for _ in $(seq 1 40); do
  states="$("$COMPOSE" ps --format json api worker | jq -rs 'map("\(.Service)=\(.Health // .State)") | join(" ")')"
  if "$COMPOSE" ps --format json api worker | jq -es 'length == 2 and all(.[]; .Health == "healthy")' >/dev/null; then
    healthy=true
    break
  fi
  sleep 3
done
[[ "$healthy" == true ]] || {
  log_error "api and worker are not healthy: ${states}"
  exit 1
}
"$COMPOSE" exec -T api wget -q -O /dev/null http://127.0.0.1:3000/health/ready
log "deploy of ${tag} OK"
