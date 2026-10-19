#!/usr/bin/env bash
# Runs a k6 scenario of this directory in the grafana/k6 container (no local k6 install).
#   BASE_URL=http://host.docker.internal:3000 API_KEY=bc_live_... INSTANCE_ID=<uuid> ./run-k6.sh send-messages.js
# Every variable of lib/config.js goes to k6 (-e NAME=value) when it is set.
# The summary goes to results/<scenario>-<time>.json.
set -euo pipefail

K6_IMAGE="${K6_IMAGE:-grafana/k6:1.8.2@sha256:bd6ae8607c0a05d0dc0dc3f5753c464b0929baf083ef0f20b7eed845a3d9e6b4}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scenario="${1:?give a scenario: send-messages.js or message-status.js}"
shift
[[ -f "$DIR/$scenario" ]] || {
  echo "run-k6: $DIR/$scenario does not exist" >&2
  exit 64
}
mkdir -p "$DIR/results"
summary="results/${scenario%.js}-$(date -u +%Y%m%dT%H%M%SZ).json"

env_args=()
for name in BASE_URL API_KEY INSTANCE_ID TO RATE DURATION VUS MAX_VUS SEED_MESSAGES RUN_ID; do
  if [[ -n "${!name:-}" ]]; then
    env_args+=(-e "${name}=${!name}")
  fi
done

docker run --rm -i \
  --add-host host.docker.internal:host-gateway \
  --user "$(id -u):$(id -g)" \
  -v "$DIR:/scripts" -w /scripts \
  "$K6_IMAGE" run "${env_args[@]}" --summary-export "/scripts/$summary" "$@" "/scripts/$scenario"
echo "run-k6: summary in tests/load/$summary"
