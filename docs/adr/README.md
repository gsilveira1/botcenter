# Architecture decision records

Short records of the main choices of the architecture (`docs/Plano de Arquitetura Servidor Evolution API para Bots de WhatsApp.md`). Each record has the status, the context, the decision, and the consequences. To change a decision, add a new record that replaces the old one. Do not edit an accepted record.

| Number | Title | Status |
| --- | --- | --- |
| [0001](0001-gateway-in-front-of-evolution.md) | A Bot Center gateway in front of the Evolution API | Accepted |
| [0002](0002-bullmq-on-redis.md) | BullMQ on Redis for the queues | Accepted |
| [0003](0003-one-host-docker-compose.md) | One host with Docker Compose in phase 1 | Accepted |
| [0004](0004-cloudflare-r2-for-media-and-backups.md) | Cloudflare R2 for media and backups | Accepted |
| [0005](0005-edge-cloudflare-caddy-tailscale.md) | Cloudflare, Caddy, and Tailscale at the edge | Accepted |
| [0006](0006-grafana-cloud-and-alloy-without-docker-socket.md) | Grafana Cloud and Alloy without the Docker socket | Accepted |
