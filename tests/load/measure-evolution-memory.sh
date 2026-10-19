#!/usr/bin/env bash
# Samples the memory of the Evolution container and its number of connected instances (CSV).
# Use it on a test host with real test numbers (the fake server has no Baileys session):
#   EVOLUTION_CONTAINER=botcenter-evolution-1 EVOLUTION_API_KEY=... ./measure-evolution-memory.sh 60 30
# Arguments: the interval in seconds (default 60) and the number of samples (default 30).
# Output columns: time, connected instances, all instances, memory in MiB, MiB per connected instance.
set -euo pipefail

interval="${1:-60}"
samples="${2:-30}"
container="${EVOLUTION_CONTAINER:-botcenter-evolution-1}"
: "${EVOLUTION_API_KEY:?EVOLUTION_API_KEY is required (the global key of the Evolution container)}"
command -v jq >/dev/null || {
  echo "measure: jq is not installed" >&2
  exit 1
}

echo "time,connected,instances,memory_mib,mib_per_connected"
for ((i = 0; i < samples; i++)); do
  # The request runs in the container: the Evolution API has no port on the host.
  instances="$(docker exec -e K="$EVOLUTION_API_KEY" "$container" node -e '
    fetch("http://127.0.0.1:8080/instance/fetchInstances", { headers: { apikey: process.env.K } })
      .then(async (r) => { if (!r.ok) throw new Error("HTTP " + r.status); process.stdout.write(await r.text()); })
      .catch((e) => { console.error(String(e)); process.exit(1); });')"
  connected="$(jq '[.[] | select(.connectionStatus == "open")] | length' <<<"$instances")"
  total="$(jq 'length' <<<"$instances")"
  bytes="$(docker stats --no-stream --format '{{.MemUsage}}' "$container" | awk '{print $1}' | sed 's/B$//' | numfmt --from=auto)"
  mib=$((bytes / 1048576))
  per="n/a"
  if ((connected > 0)); then
    per=$((mib / connected))
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),${connected},${total},${mib},${per}"
  if ((i + 1 < samples)); then
    sleep "$interval"
  fi
done
