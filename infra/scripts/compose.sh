#!/usr/bin/env bash
# `docker compose` for the production stack, with the right files, project, and env file.
#   sudo /opt/botcenter/infra/scripts/compose.sh ps
#   sudo /opt/botcenter/infra/scripts/compose.sh logs -f --since 10m worker
# Files: infra/compose/compose.prod.yml plus BOTCENTER_COMPOSE_EXTRA_FILES of compose.env
# (comma-separated names in infra/compose, for example compose.prod.cx22.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="${BOTCENTER_ENV_DIR:-/etc/botcenter}"
ENV_FILE="$ENV_DIR/compose.env"
[[ -r "$ENV_FILE" ]] || {
  echo "compose.sh: ERROR: cannot read $ENV_FILE (run infra/scripts/gen-secrets.sh first)" >&2
  exit 1
}
extra="$(sed -n 's/^BOTCENTER_COMPOSE_EXTRA_FILES=//p' "$ENV_FILE" | tail -1)"
files=(-f "$ROOT/infra/compose/compose.prod.yml")
IFS=',' read -r -a extra_list <<<"$extra"
for name in "${extra_list[@]}"; do
  [[ -n "$name" ]] || continue
  [[ -f "$ROOT/infra/compose/$name" ]] || {
    echo "compose.sh: ERROR: $ROOT/infra/compose/$name does not exist (BOTCENTER_COMPOSE_EXTRA_FILES)" >&2
    exit 1
  }
  files+=(-f "$ROOT/infra/compose/$name")
done
exec docker compose -p botcenter "${files[@]}" --env-file "$ENV_FILE" "$@"
