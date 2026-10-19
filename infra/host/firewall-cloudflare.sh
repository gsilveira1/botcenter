#!/usr/bin/env bash
# Allows HTTPS (443, and 80 with --allow-http) only from the current Cloudflare IP ranges.
# Idempotent: each run builds the same rules from the lists. systemd runs it after each boot and
# every 6 hours (botcenter-cloudflare-firewall.timer).
#
#   sudo infra/host/firewall-cloudflare.sh                         # backends from FIREWALL_BACKENDS
#   sudo infra/host/firewall-cloudflare.sh --backends docker-user,hcloud --allow-http
#   infra/host/firewall-cloudflare.sh --dry-run                    # prints the rules, changes nothing
#
# Backends:
#   docker-user  iptables and ip6tables rules in the DOCKER-USER chain. Docker publishes the ports of
#                Caddy with its own NAT rules, and those rules bypass ufw. DOCKER-USER is the chain
#                that Docker reads first for the forwarded traffic, so the filter must be there.
#   hcloud       The Hetzner Cloud Firewall HCLOUD_FIREWALL_NAME (outside the host), applied to
#                HCLOUD_SERVER_NAME. It needs the `hcloud` CLI and HCLOUD_TOKEN.
#                Rules: 443 (and 80) from Cloudflare, UDP 41641 (Tailscale), ICMP. No SSH rule:
#                SSH is only on the Tailscale interface.
#
# The script also writes the Caddy `trusted_proxies` snippet (CADDY_SNIPPET) and reloads Caddy when
# the ranges change.
# Safety: when a list is empty, too short, or has a line that is not a CIDR, the script keeps the
# current rules, sends an alert, and exits 1.
set -euo pipefail

SCRIPT_NAME=firewall-cloudflare
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
. "$SCRIPT_DIR/../backup/lib.sh"

CF_IPS_V4_URL="${CF_IPS_V4_URL:-https://www.cloudflare.com/ips-v4}"
CF_IPS_V6_URL="${CF_IPS_V6_URL:-https://www.cloudflare.com/ips-v6}"
BACKENDS="${FIREWALL_BACKENDS:-docker-user}"
ALLOW_HTTP="${ALLOW_HTTP:-false}"
DRY_RUN=false
CHAIN=BOTCENTER-CF

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backends)
      BACKENDS="${2:?--backends needs a value}"
      shift 2
      ;;
    --allow-http)
      ALLOW_HTTP=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h | --help)
      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      log_error "unknown argument: $1"
      exit 64
      ;;
  esac
done

on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && "$DRY_RUN" != true ]]; then
    alert "the Cloudflare firewall update FAILED (exit code $rc). The previous rules stay."
  fi
}
trap on_exit EXIT

ports=(443)
if [[ "$ALLOW_HTTP" == true ]]; then
  ports=(80 443)
fi

# fetch_ranges URL FAMILY MINIMUM : prints the validated CIDR lines.
fetch_ranges() {
  local url="$1" family="$2" minimum="$3" body line count=0 pattern
  body="$(curl -fsS -m 20 --retry 3 "$url")" || {
    log_error "cannot fetch $url"
    return 1
  }
  if [[ "$family" == 4 ]]; then
    pattern='^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$'
  else
    pattern='^[0-9a-fA-F:]+:[0-9a-fA-F:]*/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$'
  fi
  while IFS= read -r line; do
    line="${line//$'\r'/}"
    [[ -z "$line" ]] && continue
    if [[ ! "$line" =~ $pattern ]]; then
      log_error "the line '$line' of $url is not an IPv${family} CIDR"
      return 1
    fi
    printf '%s\n' "$line"
    count=$((count + 1))
  done <<<"$body"
  if ((count < minimum)); then
    log_error "$url has only $count ranges (minimum $minimum)"
    return 1
  fi
}

v4="$(fetch_ranges "$CF_IPS_V4_URL" 4 10)"
v6="$(fetch_ranges "$CF_IPS_V6_URL" 6 5)"
log "Cloudflare ranges: $(wc -l <<<"$v4") IPv4, $(wc -l <<<"$v6") IPv6; ports: ${ports[*]}"

# remove_chain CMD NAME : removes every jump to the chain NAME from DOCKER-USER, then the chain.
remove_chain() {
  local cmd="$1" name="$2"
  while "$cmd" -D DOCKER-USER -j "$name" 2>/dev/null; do :; done
  if "$cmd" -n -L "$name" >/dev/null 2>&1; then
    "$cmd" -F "$name"
    "$cmd" -X "$name"
  fi
}

# --- Backend: docker-user -----------------------------------------------------------------------
# Rules of the chain BOTCENTER-CF (rebuilt on each run), jumped to from DOCKER-USER:
#   - RETURN for established connections and for the traffic that does not come in on the public
#     interface (the containers, Tailscale);
#   - RETURN for the Cloudflare ranges on the allowed ports;
#   - DROP for the allowed ports from any other source.
# The ports are the ports in the container (after Docker's NAT): Caddy listens on 80 and 443.
apply_docker_user() {
  local cmd="$1" ranges="$2" iface cidr port
  iface="${PUBLIC_INTERFACE:-$(ip -o route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1)}')}"
  if [[ -z "$iface" ]]; then
    log_error "cannot find the public interface (set PUBLIC_INTERFACE)"
    return 1
  fi
  local rules=()
  rules+=("-A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN")
  rules+=("-A $CHAIN ! -i $iface -j RETURN")
  for port in "${ports[@]}"; do
    while IFS= read -r cidr; do
      rules+=("-A $CHAIN -s $cidr -p tcp -m conntrack --ctorigdstport $port -j RETURN")
    done <<<"$ranges"
    rules+=("-A $CHAIN -p tcp -m conntrack --ctorigdstport $port -j DROP")
  done
  rules+=("-A $CHAIN -j RETURN")

  if [[ "$DRY_RUN" == true ]]; then
    printf '%s %s\n' "$cmd" "-N $CHAIN" "$cmd" "-F $CHAIN"
    printf "$cmd %s\n" "${rules[@]}"
    printf '%s %s\n' "$cmd" "-I DOCKER-USER 1 -j $CHAIN"
    return 0
  fi
  if ! "$cmd" -n -L DOCKER-USER >/dev/null 2>&1; then
    log_error "$cmd has no DOCKER-USER chain. Start Docker first."
    return 1
  fi
  # Build the rules in a new chain, jump to it, remove the old chain, then rename the new chain.
  # The traffic never passes an empty or a half-built chain.
  local new="${CHAIN}-NEW" rule
  remove_chain "$cmd" "$new"
  "$cmd" -N "$new"
  for rule in "${rules[@]}"; do
    # shellcheck disable=SC2086 # The rule is a list of iptables arguments.
    "$cmd" ${rule/-A $CHAIN /-A $new }
  done
  "$cmd" -I DOCKER-USER 1 -j "$new"
  remove_chain "$cmd" "$CHAIN"
  "$cmd" -E "$new" "$CHAIN"
  log "$cmd: chain $CHAIN has ${#rules[@]} rules (public interface $iface)"
}

# --- Backend: hcloud ----------------------------------------------------------------------------
apply_hcloud() {
  require_commands jq
  if [[ "$DRY_RUN" != true ]]; then
    require_vars HCLOUD_TOKEN HCLOUD_FIREWALL_NAME HCLOUD_SERVER_NAME
    require_commands hcloud
  fi
  local rules_file port
  rules_file="$(mktemp)"
  # shellcheck disable=SC2064 # The path is fixed now.
  trap "rm -f '$rules_file'" RETURN
  {
    local all
    all="$(jq -R . <<<"$v4"$'\n'"$v6" | jq -s .)"
    jq -n --argjson ips "$all" --arg ports "${ports[*]}" '
      [($ports | split(" ")[]) as $p
        | {direction: "in", protocol: "tcp", port: $p, source_ips: $ips,
           description: "HTTPS from Cloudflare only"}]
      + [{direction: "in", protocol: "udp", port: "41641", source_ips: ["0.0.0.0/0", "::/0"],
          description: "Tailscale direct connections"},
         {direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"],
          description: "ICMP"}]'
  } >"$rules_file"
  if [[ "$DRY_RUN" == true ]]; then
    cat "$rules_file"
    return 0
  fi
  if ! hcloud firewall describe "$HCLOUD_FIREWALL_NAME" >/dev/null 2>&1; then
    hcloud firewall create --name "$HCLOUD_FIREWALL_NAME" >/dev/null
    log "hcloud: created the firewall $HCLOUD_FIREWALL_NAME"
  fi
  hcloud firewall replace-rules "$HCLOUD_FIREWALL_NAME" --rules-file "$rules_file" >/dev/null
  local server_id
  server_id="$(hcloud server describe "$HCLOUD_SERVER_NAME" -o json | jq -r .id)"
  if ! hcloud firewall describe "$HCLOUD_FIREWALL_NAME" -o json |
    jq -e --argjson id "$server_id" \
      '[.applied_to[]? | select(.type == "server" and .server.id == $id)] | length > 0' >/dev/null; then
    hcloud firewall apply-to-resource "$HCLOUD_FIREWALL_NAME" --type server --server "$HCLOUD_SERVER_NAME" >/dev/null
    log "hcloud: applied $HCLOUD_FIREWALL_NAME to $HCLOUD_SERVER_NAME"
  fi
  log "hcloud: $HCLOUD_FIREWALL_NAME has the current Cloudflare rules (ports ${ports[*]})"
}

# --- Caddy trusted proxies ----------------------------------------------------------------------
update_caddy_snippet() {
  local target="${CADDY_SNIPPET:-}" content
  [[ -n "$target" ]] || return 0
  content="# Written by infra/host/firewall-cloudflare.sh. Do not edit.
trusted_proxies static $(tr '\n' ' ' <<<"$v4"$'\n'"$v6" | sed 's/ *$//')"
  if [[ "$DRY_RUN" == true ]]; then
    printf '%s\n' "$content"
    return 0
  fi
  if [[ -f "$target" ]] && [[ "$(<"$target")" == "$content" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  # Write in place (no rename): a bind mount of one file keeps the old inode after a rename.
  printf '%s\n' "$content" >"$target"
  chmod 644 "$target"
  log "Caddy snippet updated: $target"
  local caddy_id
  if caddy_id="$(compose_container caddy 2>/dev/null)"; then
    docker exec "$caddy_id" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    log "Caddy reloaded"
  else
    log "Caddy is not running; it reads the snippet at the next start"
  fi
}

IFS=',' read -r -a backend_list <<<"$BACKENDS"
for backend in "${backend_list[@]}"; do
  case "$backend" in
    docker-user)
      [[ "$DRY_RUN" == true ]] || require_commands iptables ip6tables ip
      apply_docker_user iptables "$v4"
      apply_docker_user ip6tables "$v6"
      ;;
    hcloud) apply_hcloud ;;
    *)
      log_error "unknown backend: $backend (docker-user or hcloud)"
      exit 64
      ;;
  esac
done
update_caddy_snippet
log "done"
