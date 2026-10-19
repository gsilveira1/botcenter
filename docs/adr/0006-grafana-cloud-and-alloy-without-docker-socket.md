# 0006. Grafana Cloud and Alloy without the Docker socket

- Status: Accepted (2026-10-19)
- Source: architecture, section "Observabilidade, backup e operação"; implementation plan, section 8

## Context

The architecture asks for metrics, logs, and alerts at no cost, and for no container with access to the Docker socket. A container with the socket can control the host.

## Decision

- Grafana Cloud (Free plan) stores the metrics and the logs and sends the alerts to Discord. The alert rules are in `infra/observability/prometheus/alerts.yml`, with promtool unit tests.
- Grafana Alloy runs in a container without the Docker socket. It reads the JSON log files of the containers (`/var/lib/docker/containers`, read-only). The json-file log driver adds the Compose service label to each line (`labels` option), so Alloy knows the service without the Docker API.
- Alloy scrapes the API, the workers, the host (built-in node exporter), and the text file metrics of the backup scripts.
- Uptime Kuma on the host checks `/health/ready` and gets a heartbeat from the backup (push monitor).

## Consequences

- Alloy runs as root without capabilities, with read-only host paths.
- A container that does not belong to the Compose project has no service label; Alloy drops its lines.
- If Alloy or Grafana Cloud fails, the alert `MetricsAbsent` fires, and the local disk check and Uptime Kuma still send alerts.
