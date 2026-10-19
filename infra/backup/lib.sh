#!/usr/bin/env bash
# Shared functions of the host scripts (infra/backup and infra/host). Source it; do not run it.
# The caller sets `set -euo pipefail` and SCRIPT_NAME before it sources this file.
# shellcheck disable=SC2034 # The callers use the constants of this file.

# restic in a container: the version is pinned here, and Renovate updates the digest.
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"
# The image of the temporary PostgreSQL of the restore test: the same as compose.prod.yml.
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea}"
# The databases of the cluster (infra/postgres/init/01-databases.sh).
BACKUP_DATABASES=(botcenter evolution)

log() {
  printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-botcenter}" "$*"
}

log_error() {
  log "ERROR: $*" >&2
}

# require_vars NAME... : stops with a clear message when a variable is empty or not set.
require_vars() {
  local name missing=()
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "these variables are not set: ${missing[*]} (see infra/env/backup.env.example)"
    return 1
  fi
}

# require_commands NAME... : stops when a command is not installed.
require_commands() {
  local name
  for name in "$@"; do
    if ! command -v "$name" >/dev/null 2>&1; then
      log_error "the command '$name' is not installed (see infra/host/bootstrap.sh)"
      return 1
    fi
  done
}

# json_escape TEXT : prints TEXT as the content of a JSON string (no jq: an alert must work without it).
json_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\n'/\\n}"
  text="${text//$'\r'/\\r}"
  text="${text//$'\t'/\\t}"
  printf '%s' "$text" | tr -d '\000-\037'
}

# alert MESSAGE : sends a message to the Discord operations channel. A failed post is logged,
# but it does not hide the original failure.
alert() {
  local message="[botcenter ${BACKUP_HOST_TAG:-$(hostname)}] ${SCRIPT_NAME:-script}: $1"
  log_error "$1"
  if [[ -z "${ALERT_DISCORD_WEBHOOK_URL:-}" || "${ALERT_DISCORD_WEBHOOK_URL}" == "CHANGE_ME" ]]; then
    log_error "ALERT_DISCORD_WEBHOOK_URL is not set: the alert went to the log only"
    return 0
  fi
  local payload
  payload="{\"content\":\"$(json_escape "${message:0:1900}")\"}"
  if ! curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$ALERT_DISCORD_WEBHOOK_URL" >/dev/null; then
    log_error "the post to ALERT_DISCORD_WEBHOOK_URL failed"
  fi
}

# kuma_push URL MESSAGE : heartbeat of an Uptime Kuma push monitor. An empty URL does nothing.
kuma_push() {
  local url="$1" message="$2"
  if [[ -z "$url" ]]; then
    return 0
  fi
  if ! curl -fsS -m 10 -G --data-urlencode "status=up" --data-urlencode "msg=${message}" "$url" >/dev/null; then
    log_error "the Uptime Kuma push failed ($url)"
    return 1
  fi
}

# write_metrics FILE_NAME CONTENT : writes a Prometheus text file for Alloy (atomic rename).
write_metrics() {
  local dir="${METRICS_DIR:-/var/lib/botcenter/metrics}" name="$1" content="$2" tmp
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.${name}.XXXXXX")"
  printf '%s\n' "$content" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$dir/$name"
}

# read_metric FILE_NAME METRIC : prints the value of a metric from a text file, or nothing.
read_metric() {
  local file="${METRICS_DIR:-/var/lib/botcenter/metrics}/$1"
  if [[ -f "$file" ]]; then
    awk -v m="$2" '$1 == m { print $2 }' "$file"
  fi
}

# compose_container SERVICE : prints the id of the running container of a Compose service.
compose_container() {
  local service="$1" project="${BOTCENTER_COMPOSE_PROJECT:-botcenter}" ids
  ids="$(docker ps -q \
    --filter "label=com.docker.compose.project=${project}" \
    --filter "label=com.docker.compose.service=${service}")"
  if [[ -z "$ids" ]]; then
    log_error "no running container for the service '${service}' of the Compose project '${project}'"
    return 1
  fi
  if [[ "$(wc -l <<<"$ids")" -ne 1 ]]; then
    log_error "more than one container for the service '${service}'"
    return 1
  fi
  printf '%s\n' "$ids"
}

# restic_run [--data DIR] ARGS... : runs restic in a container with the repository env file.
# The container runs with the uid of the caller (root under systemd) and no capability.
# DIR (optional) is mounted at /data (read-write). The cache is RESTIC_HOST_CACHE_DIR on the host.
restic_run() {
  local data_dir=""
  if [[ "${1:-}" == "--data" ]]; then
    data_dir="$2"
    shift 2
  fi
  local cache_dir="${RESTIC_HOST_CACHE_DIR:-/var/cache/botcenter-restic}"
  mkdir -p "$cache_dir"
  local args=(
    run --rm -i
    --network "${RESTIC_DOCKER_NETWORK:-bridge}"
    --env-file "${RESTIC_ENV_FILE:?RESTIC_ENV_FILE is not set}"
    --user "$(id -u):$(id -g)"
    --cap-drop ALL
    --security-opt no-new-privileges:true
    -e RESTIC_CACHE_DIR=/cache
    -v "${cache_dir}:/cache"
  )
  if [[ -n "$data_dir" ]]; then
    args+=(-v "${data_dir}:/data")
  fi
  docker "${args[@]}" "$RESTIC_IMAGE" "$@"
}

# disk_usage_percent PATH : prints the used space of the file system of PATH, in percent.
disk_usage_percent() {
  df -P "$1" | awk 'NR == 2 { gsub("%", "", $5); print $5 }'
}
