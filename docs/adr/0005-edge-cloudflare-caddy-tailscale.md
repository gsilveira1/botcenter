# 0005. Cloudflare, Caddy, and Tailscale at the edge

- Status: Accepted (2026-10-19)
- Source: architecture, section "Segurança"; implementation plan, section 8

## Context

The host must accept HTTPS only from Cloudflare and SSH only from the team. The ports that Docker publishes bypass ufw. The API must never expose `/internal/*` (the Evolution webhook) or `/metrics`.

## Decision

- Cloudflare proxies the API host name (SSL "Full (strict)", WAF basic). The origin uses a Cloudflare origin certificate. ACME is the documented alternative.
- Caddy is the only container with host ports. It forwards only `/v1/*` and `/health/*` to the API and answers 404 for every other path. It limits the body to 2 MiB, takes the client IP from `CF-Connecting-IP` only for Cloudflare ranges, and writes JSON access logs without query strings and without the connect token.
- `infra/host/firewall-cloudflare.sh` allows port 443 only from the current Cloudflare ranges, in the `DOCKER-USER` chain of the host and, as a second layer, in the Hetzner Cloud Firewall. A systemd timer runs it after each boot and every 6 hours. It refuses a bad list and keeps the current rules.
- SSH is only on the Tailscale interface, with keys only. The Uptime Kuma UI is on `127.0.0.1:3001` of the host (SSH tunnel).

## Consequences

- A request that does not come through Cloudflare cannot reach Caddy.
- A Cloudflare outage stops the public API. The direct access for the team stays (Tailscale).
- The firewall depends on the Cloudflare IP lists. The script checks them, and an alert reports a failed update.
