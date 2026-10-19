#!/usr/bin/env bash
# Hardens a new Ubuntu 24.04 host for Bot Center and installs the tools. Idempotent: run it again
# after a change; it changes only what is different.
#
#   sudo TAILSCALE_AUTHKEY=tskey-auth-... ADMIN_USER=ops infra/host/bootstrap.sh
#
# Steps (docs/runbook.md, procedure "Prepare the host"):
#   1. Packages: Docker Engine and the Compose plugin (Docker apt repository), Tailscale (Tailscale apt
#      repository), ufw, fail2ban, unattended-upgrades, jq, curl, git, ipset.
#   2. Automatic security updates (unattended-upgrades, no automatic reboot).
#   3. Docker daemon: json-file logs with rotation, live-restore, no-new-privileges by default.
#   4. Kernel: vm.overcommit_memory=1 (Redis AOF rewrite), swappiness 10, a swap file (SWAP_SIZE), and
#      br_netfilter with net.bridge.bridge-nf-call-iptables=1 (the Evolution egress rules, SEC-01).
#   5. Tailscale: `tailscale up` with TAILSCALE_AUTHKEY when the host is not logged in.
#   6. SSH: keys only, no password, no keyboard-interactive login, root only with a key
#      (or no root login when ADMIN_USER has a key). ufw allows SSH only on tailscale0.
#   7. ufw: deny all inbound traffic except on tailscale0 and UDP 41641 (Tailscale). The HTTPS
#      rules for Cloudflare are in the DOCKER-USER chain (infra/host/firewall-cloudflare.sh), because
#      the ports that Docker publishes bypass ufw.
#   8. fail2ban for sshd. Directories /etc/botcenter (700), /var/lib/botcenter, /var/cache/botcenter-restic.
#   9. The systemd units of infra/backup/systemd and infra/host/systemd (when BOTCENTER_DIR exists).
#
# WARNING: step 6 and step 7 close SSH on the public interface. The script stops before them when
# Tailscale is not connected, so you do not lose access. Keep the Hetzner web console as a fallback.
set -euo pipefail

BOTCENTER_DIR="${BOTCENTER_DIR:-/opt/botcenter}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
ADMIN_USER="${ADMIN_USER:-}"
TAILSCALE_AUTHKEY="${TAILSCALE_AUTHKEY:-}"
TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-botcenter-prod-1}"

log() { printf '%s bootstrap: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  printf 'bootstrap: ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || die "run this script as root (sudo)"
# shellcheck source=/dev/null # A file of the host.
. /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || die "this script supports Ubuntu 24.04 only (found ${PRETTY_NAME:-unknown})"
export DEBIAN_FRONTEND=noninteractive

# write_if_changed PATH MODE : writes stdin to PATH when the content is different. Prints "changed".
write_if_changed() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 0
  fi
  install -D -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  echo changed
}

# --- 1. Packages ---------------------------------------------------------------------------------
log "packages"
install -d -m 0755 /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
fi
write_if_changed /etc/apt/sources.list.d/docker.list 0644 >/dev/null <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable
EOF
if [[ ! -f /usr/share/keyrings/tailscale-archive-keyring.gpg ]]; then
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
fi
write_if_changed /etc/apt/sources.list.d/tailscale.list 0644 >/dev/null <<EOF
deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu ${VERSION_CODENAME} main
EOF
apt-get update -q
apt-get install -y -q \
  ca-certificates curl git jq ipset ufw fail2ban unattended-upgrades apt-listchanges \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  tailscale

# --- 2. Automatic security updates ---------------------------------------------------------------
log "unattended-upgrades"
write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 0644 >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# No automatic reboot: a reboot stops every WhatsApp session for some minutes. The runbook has the
# procedure "Reboot the host" (check /var/run/reboot-required each week).
write_if_changed /etc/apt/apt.conf.d/52botcenter-unattended 0644 >/dev/null <<'EOF'
Unattended-Upgrade::Allowed-Origins {
  "${distro_id}:${distro_codename}-security";
  "${distro_id}ESMApps:${distro_codename}-apps-security";
  "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades.service >/dev/null

# --- 3. Docker daemon ----------------------------------------------------------------------------
log "docker daemon"
if [[ "$(write_if_changed /etc/docker/daemon.json 0644 <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true,
  "no-new-privileges": true,
  "userland-proxy": false
}
EOF
)" == changed ]]; then
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

# --- 4. Kernel and swap --------------------------------------------------------------------------
log "sysctl and swap"
# The DOCKER-USER rules of the Evolution container (chain BOTCENTER-EVO) see the traffic between two
# containers of one bridge network only with br_netfilter and bridge-nf-call-iptables=1.
write_if_changed /etc/modules-load.d/botcenter.conf 0644 >/dev/null <<'EOF'
br_netfilter
EOF
modprobe br_netfilter
if [[ "$(write_if_changed /etc/sysctl.d/90-botcenter.conf 0644 <<'EOF'
# Redis: the AOF rewrite forks; without overcommit the fork can fail under memory pressure.
vm.overcommit_memory = 1
vm.swappiness = 10
# The DOCKER-USER rules apply to the traffic inside a bridge network (infra/host/firewall-cloudflare.sh).
net.bridge.bridge-nf-call-iptables = 1
EOF
)" == changed ]]; then
  sysctl --system >/dev/null
fi
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab

# --- 5. Tailscale --------------------------------------------------------------------------------
log "tailscale"
systemctl enable --now tailscaled >/dev/null
if ! tailscale status >/dev/null 2>&1; then
  if [[ -n "$TAILSCALE_AUTHKEY" ]]; then
    tailscale up --authkey "$TAILSCALE_AUTHKEY" --hostname "$TAILSCALE_HOSTNAME" --ssh=false
  fi
fi
tailscale_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [[ -z "$tailscale_ip" ]]; then
  die "Tailscale is not connected. Run again with TAILSCALE_AUTHKEY=... (the SSH and firewall steps did not run, so the public SSH stays open)."
fi
log "tailscale IP: $tailscale_ip"

# --- 6. SSH --------------------------------------------------------------------------------------
log "ssh"
root_login="prohibit-password"
if [[ -n "$ADMIN_USER" ]]; then
  if ! id "$ADMIN_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash --groups sudo "$ADMIN_USER"
  fi
  admin_home="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
  if [[ ! -s "$admin_home/.ssh/authorized_keys" && -s /root/.ssh/authorized_keys ]]; then
    install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$admin_home/.ssh"
    install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" /root/.ssh/authorized_keys "$admin_home/.ssh/authorized_keys"
  fi
  if [[ -s "$admin_home/.ssh/authorized_keys" ]]; then
    root_login="no"
  fi
fi
if [[ "$(write_if_changed /etc/ssh/sshd_config.d/10-botcenter.conf 0644 <<EOF
# Bot Center (infra/host/bootstrap.sh): keys only. ufw allows port 22 only on tailscale0.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
PermitRootLogin ${root_login}
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
)" == changed ]]; then
  sshd -t
  systemctl reload ssh
fi

# --- 7. ufw --------------------------------------------------------------------------------------
log "ufw"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow in on tailscale0 comment 'Tailscale: SSH and Uptime Kuma tunnel' >/dev/null
ufw allow 41641/udp comment 'Tailscale direct connections' >/dev/null
# Remove the generic SSH rules of a cloud image, if they exist.
ufw delete allow OpenSSH >/dev/null 2>&1 || true
ufw delete allow 22/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null

# --- 8. fail2ban and directories -----------------------------------------------------------------
log "fail2ban and directories"
if [[ "$(write_if_changed /etc/fail2ban/jail.d/botcenter.local 0644 <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
)" == changed ]]; then
  systemctl restart fail2ban
fi
systemctl enable --now fail2ban >/dev/null
install -d -m 0700 /etc/botcenter /etc/botcenter/certs
install -d -m 0755 /etc/botcenter/caddy /var/lib/botcenter /var/lib/botcenter/metrics
install -d -m 0700 /var/lib/botcenter/backup-work /var/lib/botcenter/state /var/cache/botcenter-restic

# --- 9. systemd units ----------------------------------------------------------------------------
if [[ -d "$BOTCENTER_DIR/infra" ]]; then
  log "systemd units from $BOTCENTER_DIR/infra"
  changed_units=false
  for unit in "$BOTCENTER_DIR"/infra/backup/systemd/*.{service,timer} "$BOTCENTER_DIR"/infra/host/systemd/*.{service,timer}; do
    [[ -f "$unit" ]] || continue
    target="/etc/systemd/system/$(basename "$unit")"
    if [[ "$(write_if_changed "$target" 0644 <"$unit")" == changed ]]; then
      changed_units=true
    fi
  done
  if [[ "$changed_units" == true ]]; then
    systemctl daemon-reload
  fi
  log "enable the timers after the env files exist: docs/runbook.md, procedure 'First deploy'"
else
  log "skip the systemd units: $BOTCENTER_DIR/infra does not exist (clone the repository first)"
fi

log "done. Reboot when /var/run/reboot-required exists."
