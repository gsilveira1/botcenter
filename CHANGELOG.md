# Changelog

## v0.1.0 (2026-10-19)

First release: phase 1 of the architecture plan (`docs/Plano de Arquitetura Servidor Evolution API para Bots de WhatsApp.md`). One host with Docker Compose. The Evolution API stays on the private network, and only the Bot Center gets traffic from outside.

### Added

- Bot Center API (`ROLE=api`) and worker (`ROLE=worker`): NestJS 11 with Fastify, PostgreSQL 16 with Prisma 7, Redis 7 with BullMQ.
- API keys with scopes, instance lists, a hash with pepper, immediate revocation, and limits for each key. Admin CLI for tenants, keys, raw event replay, and the webhook resync of the instances.
- `POST/GET/DELETE /v1/instances`, `POST /v1/instances/{id}/connect`, and the connect stream `GET /v1/connect/{token}/events` (QR code or pairing code, one-use token, CORS allow list).
- `POST /v1/messages` (text, media, buttons, list) with the answer 202, `GET /v1/messages/{id}`, `POST /v1/media`, `GET /v1/media/{id}`. A token bucket and a warm-up for each instance, the send order for each contact, retries for specific errors only, and a daily quota.
- Bots: `PUT/GET /v1/bots/{id}` with versioned state machine definitions, a signing secret for each bot, and `POST /v1/bots/{id}/rotate-secret`. The pure engine `@botcenter/engine` (RE2 regular expressions, timeouts, templates).
- Conversations: `GET /v1/conversations/{id}`, `POST /v1/conversations/{id}/handoff`, a lock for each conversation, optimistic versions, the outbox pattern, timers with deterministic job ids, and the text menu for buttons and lists.
- Webhooks: `POST/GET/DELETE /v1/webhooks`, secret rotation, HMAC-SHA256 signatures, retries (1 min to 6 h), a dead letter state, `GET /v1/webhooks/deliveries`, and the redelivery route. An SSRF guard for every client URL.
- LGPD purges (raw events 7 days, messages, conversations, media, deliveries, and the Evolution `Message` table), and an audit table that accepts inserts only.
- Infrastructure: Compose files for development and production, Caddy with Cloudflare origin pulls, firewall scripts, restic backups with a monthly restore test, Grafana Alloy, Prometheus alert rules, the Redis exporter, a CI pipeline with Trivy, CodeQL, and gitleaks, and Renovate.
- Tests: unit tests, integration tests with Testcontainers, an integration test with the real Evolution v2.3.7 image, a smoke test of the production stack (`pnpm test:smoke`), and k6 scenarios (`tests/load/RESULTS.md`).
- Documents: `docs/runbook.md`, `docs/adr/`, `docs/implementation-plan.md`, and the review `docs/reviews/2026-10-19-v0.1.0-adversarial-review.md`.

### Known limits

See section 5 of the review.
