#!/usr/bin/env bash
# End-to-end smoke test of the production stack on the local machine (`pnpm test:smoke`).
#
#   tests/smoke/run-smoke.sh
#   SMOKE_SKIP_BUILD=1 tests/smoke/run-smoke.sh      # use the image botcenter-api:smoke that exists
#   SMOKE_KEEP=1 tests/smoke/run-smoke.sh            # do not remove the stack at the end
#
# Steps:
#   1. Build the image from infra/docker/api.Dockerfile (tag SMOKE_IMAGE, default botcenter-api:smoke).
#   2. Make the env files with infra/scripts/gen-secrets.sh in a temporary directory, and replace the
#      CHANGE_ME values with local values (Caddy `tls internal`, MinIO in place of R2, no Discord).
#   3. Start infra/compose/compose.prod.yml plus tests/smoke/compose.smoke.yml with a unique project
#      name and random ports on 127.0.0.1. The `migrate` service runs before `api` and `worker`.
#   4. Run tests/smoke/smoke.mjs (the HTTP steps through Caddy).
#   5. Save the logs and the report in tests/smoke/results/, then remove the containers and volumes.
#
# Requirements: Docker with Compose 2.24 or later (`!override`), Node 24, openssl, and internet access
# from Docker (the real Evolution API connects to WhatsApp).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_DIR="$ROOT/tests/smoke"
SMOKE_IMAGE="${SMOKE_IMAGE:-botcenter-api:smoke}"
SMOKE_PROJECT="${SMOKE_PROJECT:-bcsmoke-$(openssl rand -hex 3)}"
RESULTS_DIR="$SMOKE_DIR/results"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/botcenter-smoke.XXXXXX")"
ENV_DIR="$WORK/env"

log() { echo "smoke: $*" >&2; }
die() {
  echo "smoke: ERROR: $*" >&2
  exit 1
}

# A free TCP port on 127.0.0.1 (the kernel chooses it).
free_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

compose() {
  docker compose -p "$SMOKE_PROJECT" \
    -f "$ROOT/infra/compose/compose.prod.yml" \
    -f "$SMOKE_DIR/compose.smoke.yml" \
    --env-file "$ENV_DIR/compose.env" "$@"
}

cleanup() {
  local code=$?
  if [[ -f "$ENV_DIR/compose.env" ]]; then
    compose logs --no-color --timestamps >"$RESULTS_DIR/smoke-$STAMP.log" 2>&1 || log "could not save the logs"
    if [[ "${SMOKE_KEEP:-}" == 1 ]]; then
      log "SMOKE_KEEP=1: the stack stays. Env files: $ENV_DIR. Remove it with:"
      log "  docker compose -p $SMOKE_PROJECT -f infra/compose/compose.prod.yml -f tests/smoke/compose.smoke.yml --env-file $ENV_DIR/compose.env down -v"
      exit "$code"
    fi
    compose down -v --remove-orphans --timeout 30 >/dev/null 2>&1 || log "WARNING: 'compose down' failed for $SMOKE_PROJECT"
  fi
  rm -rf "$WORK"
  log "logs: tests/smoke/results/smoke-$STAMP.log"
  exit "$code"
}
trap cleanup EXIT

command -v docker >/dev/null || die "docker is not installed"
command -v node >/dev/null || die "node is not installed"
docker compose version >/dev/null || die "docker compose is not installed"
mkdir -p "$RESULTS_DIR"

if [[ "${SMOKE_SKIP_BUILD:-}" != 1 ]]; then
  log "building $SMOKE_IMAGE from infra/docker/api.Dockerfile"
  docker build -q -f "$ROOT/infra/docker/api.Dockerfile" -t "$SMOKE_IMAGE" "$ROOT" >/dev/null
fi
docker image inspect "$SMOKE_IMAGE" >/dev/null 2>&1 || die "the image $SMOKE_IMAGE does not exist"

HTTP_PORT="$(free_port)"
HTTPS_PORT="$(free_port)"
DOMAIN=api.smoke.test

log "making the env files (gen-secrets.sh) in a temporary directory"
"$ROOT/infra/scripts/gen-secrets.sh" --target-dir "$ENV_DIR" >/dev/null

# Replaces the value of NAME in an env file. The values here contain no `|` and no `&`.
set_env() {
  local file="$ENV_DIR/$1" name="$2" value="$3"
  grep -q "^$name=" "$file" || die "$1 has no variable $name"
  sed -i "s|^$name=.*|$name=$value|" "$file"
}
MINIO_PASSWORD="$(openssl rand -hex 24)"
set_env caddy.env BOTCENTER_DOMAIN "$DOMAIN"
set_env caddy.env CADDY_TLS internal
set_env api.env PUBLIC_BASE_URL "https://$DOMAIN:$HTTPS_PORT"
set_env api.env S3_ENDPOINT http://minio:9000
set_env api.env S3_ACCESS_KEY_ID botcenter-smoke
set_env api.env S3_SECRET_ACCESS_KEY "$MINIO_PASSWORD"
# Empty: AlertService writes the alert to the log at `error` (no Discord in a local run).
set_env api.env ALERT_DISCORD_WEBHOOK_URL ''
set_env compose.env BOTCENTER_IMAGE "$SMOKE_IMAGE"
set_env compose.env BOTCENTER_ENV_DIR "$ENV_DIR"
set_env compose.env BOTCENTER_ENVIRONMENT smoke
set_env compose.env CADDY_CLOUDFLARE_IPS_FILE "$ROOT/infra/caddy/cloudflare-ips.caddy"
set_env compose.env BOTCENTER_COMPOSE_EXTRA_FILES ''
cat >>"$ENV_DIR/compose.env" <<EOF
SMOKE_PROJECT=$SMOKE_PROJECT
SMOKE_DIR=$SMOKE_DIR
SMOKE_HTTP_PORT=$HTTP_PORT
SMOKE_HTTPS_PORT=$HTTPS_PORT
EOF
printf 'MINIO_ROOT_USER=botcenter-smoke\nMINIO_ROOT_PASSWORD=%s\n' "$MINIO_PASSWORD" >"$ENV_DIR/minio.env"
chmod 600 "$ENV_DIR/minio.env"
if grep -l '^[^#].*CHANGE_ME' "$ENV_DIR/api.env" "$ENV_DIR/caddy.env" "$ENV_DIR/compose.env" >/dev/null; then
  die "a CHANGE_ME value stays in the env files of the smoke stack"
fi

compose config -q || die "the Compose files are not valid"

log "starting project $SMOKE_PROJECT (HTTPS on 127.0.0.1:$HTTPS_PORT)"
compose up -d caddy api worker receiver >"$WORK/up.log" 2>&1 || {
  cat "$WORK/up.log" >&2
  die "'compose up' failed"
}

# Waits until the health check of a service is `healthy` (or a one-shot service exits).
wait_healthy() {
  local service="$1" timeout="$2" id state
  id="$(compose ps -q "$service")"
  [[ -n "$id" ]] || die "no container for $service"
  for ((i = 0; i < timeout; i += 2)); do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
    [[ "$state" == healthy ]] && return 0
    [[ "$state" == exited || "$state" == dead ]] && die "$service stopped (state $state)"
    sleep 2
  done
  die "$service is not healthy after ${timeout} s (state $state)"
}
for service in postgres redis api worker caddy; do
  wait_healthy "$service" 180
done
wait_healthy evolution 240

migrate_id="$(compose ps -a -q migrate)"
MIGRATE_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$migrate_id")"
[[ "$MIGRATE_EXIT" == 0 ]] || die "migrate exited with $MIGRATE_EXIT"
log "migrate exited with 0; every service is healthy"

compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/caddy-root.crt" >/dev/null

log "running the HTTP steps (smoke.mjs)"
SMOKE_COMPOSE_ARGS="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- \
  -p "$SMOKE_PROJECT" -f "$ROOT/infra/compose/compose.prod.yml" -f "$SMOKE_DIR/compose.smoke.yml" \
  --env-file "$ENV_DIR/compose.env")" \
  SMOKE_HTTPS_PORT="$HTTPS_PORT" \
  SMOKE_HTTP_PORT="$HTTP_PORT" \
  SMOKE_DOMAIN="$DOMAIN" \
  SMOKE_CA_FILE="$WORK/caddy-root.crt" \
  SMOKE_ENV_DIR="$ENV_DIR" \
  SMOKE_MIGRATE_EXIT="$MIGRATE_EXIT" \
  SMOKE_REPORT="$RESULTS_DIR/smoke-$STAMP.json" \
  node "$SMOKE_DIR/smoke.mjs"
