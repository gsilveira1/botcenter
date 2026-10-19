#!/usr/bin/env bash
# Makes the env files of the production host from infra/env/*.env.example.
#
#   sudo infra/scripts/gen-secrets.sh                 # writes /etc/botcenter/*.env
#   infra/scripts/gen-secrets.sh --target-dir DIR     # writes DIR/*.env (tests, a second host)
#   infra/scripts/gen-secrets.sh --force              # WARNING: replaces every file and every secret
#
# Each `__NAME__` token gets one value, the same in every file (for example REDIS_PASSWORD in
# api.env, evolution.env, and redis.env). Each value is 32 random bytes:
#   hex (64 characters)  passwords, API keys, the webhook secret, the pepper (no URL encoding needed)
#   base64               DATA_ENCRYPTION_KEY (the API decodes 32 bytes for AES-256-GCM)
# The files get mode 600 and the directory gets mode 700. The script never prints a secret.
# `CHANGE_ME` values (domain, R2 keys, Grafana Cloud, Discord) stay; the script lists them at the end.
#
# Idempotent: when all the target files exist, the script changes nothing. When only some exist,
# it stops, because new secrets would not match the old ones. Use --force only for a new host.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${TEMPLATE_DIR:-${SCRIPT_DIR}/../env}"
TARGET_DIR=/etc/botcenter
FORCE=false

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "gen-secrets: ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-dir)
      [[ $# -ge 2 ]] || die "--target-dir needs a value"
      TARGET_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

command -v openssl >/dev/null 2>&1 || die "openssl is not installed"
[[ -d "$TEMPLATE_DIR" ]] || die "template directory not found: $TEMPLATE_DIR"

shopt -s nullglob
templates=("$TEMPLATE_DIR"/*.env.example)
shopt -u nullglob
[[ ${#templates[@]} -gt 0 ]] || die "no *.env.example file in $TEMPLATE_DIR"

existing=()
missing=()
for template in "${templates[@]}"; do
  name="$(basename "$template" .example)"
  if [[ -e "$TARGET_DIR/$name" ]]; then
    existing+=("$name")
  else
    missing+=("$name")
  fi
done

if [[ "$FORCE" != true ]]; then
  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "gen-secrets: all ${#existing[@]} files exist in $TARGET_DIR. Nothing to do."
    exit 0
  fi
  if [[ ${#existing[@]} -gt 0 ]]; then
    die "some files exist (${existing[*]}) and some do not (${missing[*]}) in $TARGET_DIR. New secrets would not match the old ones. Add the missing files by hand from $TEMPLATE_DIR, or use --force on a new host."
  fi
fi

hex32() { openssl rand -hex 32; }
base64_32() { openssl rand -base64 32 | tr -d '\n'; }

declare -A secrets=(
  [POSTGRES_PASSWORD]="$(hex32)"
  [BOTCENTER_OWNER_PASSWORD]="$(hex32)"
  [BOTCENTER_APP_PASSWORD]="$(hex32)"
  [EVOLUTION_DB_PASSWORD]="$(hex32)"
  [REDIS_PASSWORD]="$(hex32)"
  [EVOLUTION_API_KEY]="$(hex32)"
  [EVOLUTION_WEBHOOK_SECRET]="$(hex32)"
  [API_KEY_PEPPER]="$(hex32)"
  [DATA_ENCRYPTION_KEY]="$(base64_32)"
  [RESTIC_PASSWORD]="$(hex32)"
)

umask 077
mkdir -p "$TARGET_DIR" "$TARGET_DIR/certs" "$TARGET_DIR/caddy"
chmod 700 "$TARGET_DIR" "$TARGET_DIR/certs"
# Caddy (uid 1000) reads the snippet of the Cloudflare ranges through a bind mount.
chmod 755 "$TARGET_DIR/caddy"

for template in "${templates[@]}"; do
  name="$(basename "$template" .example)"
  target="$TARGET_DIR/$name"
  tmp="$(mktemp "$TARGET_DIR/.${name}.XXXXXX")"
  content="$(<"$template")"
  for key in "${!secrets[@]}"; do
    content="${content//__${key}__/${secrets[$key]}}"
  done
  if [[ "$content" =~ __[A-Z0-9_]+__ ]]; then
    rm -f "$tmp"
    die "$name has a token without a generator: ${BASH_REMATCH[0]}"
  fi
  printf '%s\n' "$content" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$target"
  echo "gen-secrets: wrote $target (mode 600)"
done

pending="$(grep -l 'CHANGE_ME' "$TARGET_DIR"/*.env || true)"
if [[ -n "$pending" ]]; then
  echo "gen-secrets: edit the CHANGE_ME values in these files before the first deploy:"
  while IFS= read -r file; do
    echo "  - $file: $(grep -c 'CHANGE_ME' "$file") value(s)"
  done <<<"$pending"
fi
echo "gen-secrets: WARNING: keep a copy of RESTIC_PASSWORD outside the host (password manager)."
