# 0003. One host with Docker Compose in phase 1

- Status: Accepted (2026-10-18)
- Source: architecture, sections "Resumo", "Baixo custo", and "Roadmap e riscos"

## Context

At the start, only PersonalLife uses the Bot Center, with a low volume. Managed PostgreSQL and Redis cost more than the server. A WhatsApp session cannot run on two hosts at the same time.

## Decision

Run every service on one Hetzner Cloud server with Docker Compose: Caddy, the API, the workers, the Evolution API, PostgreSQL 16, Redis 7, Uptime Kuma, and Grafana Alloy. Start with a CX22 (2 vCPU, 4 GB, profile `compose.prod.cx22.yml`) and move to a CX32 (4 vCPU, 8 GB) when a trigger occurs: CPU above 70 % for 15 minutes, memory above 80 %, or an `outbound` delay above 30 s. Each container has a memory limit, so one process cannot stop the host.

## Consequences

- The cost of phase 1 is about 10 to 15 US dollars each month.
- The host is a single point of failure. The mitigations: persistent queues (AOF), a daily backup with a tested restore, the daily Hetzner snapshot, and alerts. Phase 3 adds a second host and the routing of numbers to hosts (the `instance.host` column exists).
- A rescale to the CX32 stops the service for some minutes.
