# Bot Center: Implementation Plan

Source of truth for the product: `docs/Plano de Arquitetura Servidor Evolution API para Bots de WhatsApp.md` (architecture plan of 2026-10-18, written in pt-BR).
This file records how the swarm builds that architecture. Write all code, comments, commits, and documents in STE English (see `/home/gsilveira/CLAUDE.md`, section 0).

## 1. Scope

Release `v0.1.0` is phase 1 of the architecture plan: one host, Docker Compose, six containers.

The release contains:

- The Bot Center API (`ROLE=api`) and the Bot Center workers (`ROLE=worker`), with all the routes of the section "API para serviços clientes" and the section "Cadastro de números por API".
- The `WhatsAppProvider` interface and its first implementation (Evolution API v2, Baileys).
- The state machine engine for the conversations.
- The infrastructure as code: Compose files, Caddy, the host hardening script, the backup and restore scripts, the alert rules, the CI pipeline, and the k6 load test.
- The runbook (`docs/runbook.md`).

The release does not contain:

- The purchase and the provisioning of the real Hetzner, Cloudflare, R2, and Grafana Cloud accounts. The runbook gives the procedure. The HITL does these steps.
- Phase 2 and phase 3 of the roadmap (second host, routing of numbers to hosts, RabbitMQ). The plan keeps the `WhatsAppProvider` interface and the `instance.host` column, so phase 3 can add the routing.
- The WhatsApp Cloud API provider (out of phase 1, see the section "Regras").

## 2. Stack and versions (frozen)

| Area | Choice |
| --- | --- |
| Runtime | Node 24, pnpm 10, Turborepo 2, TypeScript 5.9 |
| API | NestJS 11 with `@nestjs/platform-fastify` 11, Zod 4 DTOs (`common/zod-dto.ts`), OpenAPI 3.1 from the Zod schemas |
| Database | PostgreSQL 16, Prisma 7 with `@prisma/adapter-pg`, SQL migrations |
| Queues and cache | Redis 7 (AOF on), BullMQ 5 or later, `ioredis` |
| Media | S3 API (`@aws-sdk/client-s3`): Cloudflare R2 in production, MinIO in local runs and tests |
| Provider | Evolution API image `evoapicloud/evolution-api:v2.3.7` (pinned by digest in production) |
| Logs and metrics | pino (JSON, async), `prom-client`, OpenTelemetry trace ids in the logs |
| Tests | Vitest 4, Supertest or `fastify.inject`, Testcontainers (PostgreSQL and Redis), k6 |
| Infra | Docker Compose, Caddy 2, Uptime Kuma, Grafana Alloy, restic, GitHub Actions, Renovate, Trivy, gitleaks |

Do not upgrade a major version without a note in this file.

## 3. Package map

| Path | Package | Content |
| --- | --- | --- |
| `packages/config` | `@botcenter/config` | Shared tsconfig and ESLint flat config |
| `packages/contracts` | `@botcenter/contracts` | Zod schemas of the public API, scopes, error codes, event payloads, the bot definition schema. **Frozen** after wave 0: additive edits only, with a note in the report. |
| `packages/engine` | `@botcenter/engine` | Pure state machine engine (no I/O). External calls go through an injected port. |
| `packages/whatsapp-provider` | `@botcenter/whatsapp-provider` | `WhatsAppProvider` interface, Evolution adapter (HTTP keep-alive), normalizer of Evolution webhook payloads, fake Evolution server for tests |
| `prisma/` | `@botcenter/prisma` | `schema.prisma`, `prisma.config.ts`, SQL migrations |
| `apps/api` | `@botcenter/api` | NestJS application. `src/main.ts` is the API process. `src/worker.ts` is the worker process. |
| `infra/` | (root) | Compose files, Dockerfile, Caddyfile, Postgres init, host scripts, backup scripts, Alloy config, alert rules |
| `tests/load` | `@botcenter/tests-load` | k6 scenarios |
| `.github/workflows` | (root) | CI pipeline |

## 4. Conventions

- **Imports between workspace packages** use the package name (`@botcenter/contracts`).
- **Errors**: every API error is RFC 9457 Problem Details (`application/problem+json`) with `type`, `title`, `status`, `detail`, and a stable `code` from `ErrorCode` in contracts. Do not hide an error. Log the technical detail, continue with reduced function, and send an alert through `AlertService` (Discord webhook) when the error affects the operation.
- **Authentication**: a client sends `Authorization: Bearer bc_live_<id>_<secret>`. The database keeps only `sha256(pepper + secret)`. The guard reads the key from a Redis cache (TTL 60 s). A revocation deletes the cache entry at once.
- **Authorization**: every route has `@RequireScope(...)`, `@ConnectToken()`, `@Internal()`, or `@Public()`. The global guard denies a route without one. A key with an instance list can use only those instances.
- **Tenancy**: every tenant table has `tenantId`. Every query filters by `tenantId` in the repository layer. A resource of a different tenant gives `404` on reads and `403` on `POST /v1/messages` (the plan says 403). Integration tests prove the isolation for each resource.
- **Idempotency**: every `POST`, `PUT`, and `DELETE` under `/v1` accepts `Idempotency-Key`. The key lives 24 h in the table `idempotency_keys` (scope: tenant + key). The same key with the same body hash returns the stored response. The same key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- **Rate limits**: per key (Redis fixed window) and per instance (Lua token bucket). A `429` has `RateLimit-Limit`, `RateLimit-Remaining`, and `Retry-After`.
- **Pagination**: every list uses an opaque cursor (`?cursor=&limit=`), with `next_cursor` in the response.
- **JSON field names** in the public API are `snake_case`. Prisma models use `@@map` snake_case table names and camelCase columns.
- **Queues**: `outbound`, `inbound`, `webhooks`, `timers`, `maintenance`. Queue names and job payload types live in `apps/api/src/queues/queue-names.ts`.
- **Outbox**: a state change and its events are written in one transaction (`outbox_events`). The dispatcher moves the rows to the `webhooks` queue.
- **Logs**: no message content. Phone numbers are masked (`5511*****4321`). Each line has `request_id`, `tenant_id`, and `instance_id` when they exist.
- **Evolution**: only the provider package knows the Evolution URLs and payloads. The rest of the code uses `WhatsAppProvider` and the normalized `ProviderEvent` union.
- **Tests**: Vitest everywhere. Integration tests start PostgreSQL and Redis with Testcontainers and never use a fixed port. No test needs a real WhatsApp number. Tests use the fake Evolution server.
- **Commits**: Conventional Commits in STE English. One feature, one commit. Branch names: `feature/<slice>`.

## 5. Data model (summary)

`tenants` (quotas: `maxInstances`, `maxMessagesPerDay`, `retentionDays`, `webhookUrl`, `webhookSecret`), `api_keys` (prefix, hash, scopes, instance list, `revokedAt`, `lastUsedAt`), `instances` (`externalRef`, `providerName` = `inst_<uuid>`, `status`, `phone` masked, `consentAt`, `host`, `rateLimitPerMinute`), `connect_tokens` (hash, method, `expiresAt`, `usedAt`), `messages` (`direction`, `status`, `type`, `to`, payload, `providerMessageId`, `priority`, `failureReason`), `bots` and `bot_versions` (definition JSON, version number), `conversations` (instance + contact unique, bot version, state, variables, `version` for optimistic locks, `handoff`), `conversation_transitions`, `raw_events` (7-day retention), `outbox_events`, `webhook_subscriptions`, `webhook_deliveries` (status, attempts, `nextAttemptAt`, `dead`), `idempotency_keys`, `audit_logs` (insert only: a trigger refuses `UPDATE` and `DELETE`), `media_objects`.

Indexes: `(instanceId, contactId)` on conversations, `(status, createdAt)` on messages, `(tenantId, externalRef)` on instances.

## 6. Build waves

Each wave runs its agents in parallel. Each agent works in its own git worktree under `/home/gsilveira/projects/botCenter-wt/<branch>` on a `feature/*` branch cut from `develop`. The orchestrator merges each branch into `develop` with `--no-ff` and runs the gate.

### Wave 0 (orchestrator)

Monorepo root, `@botcenter/config`, `@botcenter/contracts`, the complete `prisma/schema.prisma` with the first migration, this plan.

### Wave 1: foundation

| Branch | Scope |
| --- | --- |
| `feature/api-core` | `apps/api` skeleton: Fastify bootstrap, env schema, pino, request id, Problem Details filter, Zod pipe, global guard (API keys, scopes, instance list, key cache, revocation), idempotency interceptor, rate limit per key, cursor pagination, health (`/health/live`, `/health/ready`), `/metrics` (internal only), `AuditService`, `TenantsService` (quotas), `OutboxService`, `AlertService` (Discord), BullMQ module with the queue names, `worker.ts` with graceful shutdown, `InboundHandlerRegistry`, the internal Evolution webhook (`POST /internal/evolution/webhook`: secret check, normalize, dedupe for 24 h in Redis, enqueue), admin CLI scripts (create tenant, create key, revoke key, rotate key), OpenAPI export, integration test harness |
| `feature/engine` | `packages/engine`: validation of a bot definition, transition evaluation (text, button, regex, external call through a port), actions (send message, call webhook, set variable, handoff), state timeouts, property tests |
| `feature/provider` | `packages/whatsapp-provider`: interface, Evolution adapter (create, connect with QR or pairing code, state, logout, delete, send text, media, buttons, list, presence, media download), normalizer of `messages.upsert`, `messages.update`, `connection.update`, `qrcode.updated`, fake Evolution server, contract tests with recorded payloads |
| `feature/infra` | `infra/`: `compose.dev.yml` (Postgres, Redis, Evolution, MinIO), `compose.prod.yml` (Caddy, API, worker, Evolution, Postgres, Redis, Uptime Kuma, Alloy) with memory limits, `read_only`, `no-new-privileges`, no `ports:` for internal services; Dockerfile (non-root), Caddyfile (only `/v1/*` and `/health/*`), Postgres init (two databases, two roles), host hardening script (firewall for Cloudflare IPs, SSH by Tailscale, `unattended-upgrades`, fail2ban), restic backup and restore-test scripts, Alloy config, alert rules, CI workflows, Renovate config, `tests/load` k6 scenario, `docs/runbook.md` |

### Wave 2: features

| Branch | Scope |
| --- | --- |
| `feature/instances` | `POST/GET/DELETE /v1/instances`, `GET /v1/instances?external_ref=`, `POST /v1/instances/{id}/connect` (connect token, 10 min, one use), `GET /v1/connect/{token}/events` (SSE through Redis pub/sub), handlers for `connection.update` and `qrcode.updated`, lifecycle states, quota `maxInstances`, consent audit, `instance.status` events |
| `feature/messages` | `POST /v1/messages` (text, media, buttons, list), `GET /v1/messages/{id}`, `POST /v1/media` (pre-signed upload), outbound worker (Lua token bucket per instance, delay when no token, priority, retries on specific errors only), handler for `messages.update` (`delivered`, `read`), daily quota, `message.status` events, typing delay for bot replies |
| `feature/conversations` | `PUT /v1/bots/{id}`, `GET /v1/conversations/{id}`, `POST /v1/conversations/{id}/handoff`, handler for `message.received` (lock per conversation, load state with Redis hot cache and Postgres fallback, apply the engine, write state, transitions, and outbox in one transaction), `timers` queue with deterministic job ids, inbound media to S3, `message.received` and `conversation.transitioned` events |
| `feature/webhooks` | `POST/GET/DELETE /v1/webhooks`, outbox dispatcher, delivery worker (HMAC-SHA256 of `timestamp.body`, `Webhook-Signature`, `Webhook-Timestamp`, retries at 1 min, 5 min, 30 min, 2 h, 6 h, then dead letter), `GET /v1/webhooks/deliveries`, `POST /v1/webhooks/deliveries/{id}/redeliver`, SSRF guard (HTTPS only in production, no private IP ranges), `maintenance` queue (raw events 7 days, messages per `retentionDays`, idempotency keys, connect tokens), alerts (instance disconnected for more than 2 min, outbound delay above 30 s, failure rate above 5 % in 10 min) |

Rules for wave 2 agents:

- Do not edit `apps/api/src/app.module.ts` or `apps/api/src/worker.module.ts`. Export your module. Put the registration instructions in your final report.
- `prisma/schema.prisma` is complete after wave 0. If you need a column, add an additive migration named `<timestamp>_<slice>_<change>` and say so in your report.
- Use the contracts as they are. If a contract is wrong, fix it additively and say so in your report.

### Wave 3: integration, review, release

The orchestrator wires the modules, runs the full gate, runs a Compose smoke test with the real Evolution container (create an instance and receive a QR code), runs the k6 test against the fake provider, runs the adversarial review (architecture, security), fixes the HIGH and MEDIUM findings, updates the docs, merges `develop` into `main`, and tags `v0.1.0`.

## 7. Quality gate

```
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:int
```

## 8. Decisions made during implementation

- 2026-10-18: Scheduled maintenance jobs use BullMQ job schedulers in the `maintenance` queue, not pg-boss. Reason: one queue system, and the Redis already exists.
- 2026-10-18: Tenant isolation is in the application layer (repository filters and integration tests), not Row Level Security. Reason: the API has one product tenant at the start, and the plan asks only for a filter by `tenant_id`.
- 2026-10-18: Tenants and API keys are managed with admin CLI scripts in `apps/api/src/scripts`. There is no admin HTTP route in `v0.1.0`.
- 2026-10-19 (foundation): The tooling copies `personal-crm`: pnpm 10.33.0, Turborepo 2.11, TypeScript 5.9.3, Zod 4.6.7, Vitest 4.1.12, Prisma 7.10.1, ESLint 9 flat config in `@botcenter/config`. Prettier does not format `docs/` (the tables of the plan cause merge conflicts).
- 2026-10-19 (foundation): `prisma/` is the workspace package `@botcenter/prisma` (tooling, not a library). The generated client goes to `apps/api/src/generated/prisma` (CommonJS, git ignores it). The `build` script of the package runs `prisma generate`, so `apps/api` must declare `"@botcenter/prisma": "workspace:*"` (devDependency) to get the client through the `^build` dependency of Turborepo. `apps/api` imports it with a relative path (`../generated/prisma/client`) and uses `@prisma/adapter-pg`.
- 2026-10-19 (foundation): `prisma.config.ts` uses `DATABASE_URL_MIGRATE`, then `DATABASE_URL`, then a placeholder URL. Reason: Prisma 7 prints nothing and exits with 0 for an offline `migrate diff` without a datasource URL.
- 2026-10-19 (foundation): The schema uses the Prisma preview feature `partialIndexes`. `instances` has a partial unique index on `(tenantId, externalRef)` where `deletedAt IS NULL` (one active instance for each owner; a delete is a soft delete). `outbox_events` has a partial index on `createdAt` where `dispatchedAt IS NULL`.
- 2026-10-19 (foundation): Prisma enum values are the lowercase values of the contracts (`logged_out`, `pairing_code`), so the API does not map them. The direction enums use `inbound` and `outbound`. `MessageStatus` in the database also has `received` (inbound rows). Event types are `String` columns (a Prisma enum value cannot contain a dot); the contracts validate them.
- 2026-10-19 (foundation): `messages` has one `contact` column (the recipient of an outbound message or the sender of an inbound message) in place of `to` and `from`. The index is `(instanceId, contact)`.
- 2026-10-19 (foundation): The tenant webhook fields of section 5 (`webhookUrl`, `webhookSecret`) are not in the schema. `webhook_subscriptions` replaces them. `tenants` has `rateLimitPerMinute` (default limit of an API key) and `instanceRateLimitPerMinute` (default send limit of a new instance). `api_keys.rateLimitPerMinute` is `null` for the tenant default.
- 2026-10-19 (foundation): Every tenant table has `tenantId`, child tables included (`bot_versions`, `conversation_transitions`, `connect_tokens`, `webhook_deliveries`). `audit_logs` has no foreign key to `tenants`. `raw_events` has no `tenantId`. The ids use `@default(uuid(7))`: the Prisma client makes the id, so a raw SQL insert must give it.
- 2026-10-19 (foundation): `audit_logs` is insert only. The first migration has a hand-written function and two triggers that refuse `UPDATE`, `DELETE`, and `TRUNCATE`. `webhook_deliveries` has a unique key `(subscriptionId, eventId)`, so the fan-out of the dispatcher is idempotent.
- 2026-10-19 (foundation): Contracts. Problem Details `type` is `urn:botcenter:problem:<code in kebab case>` (no public documentation domain yet). `ERROR_HTTP_STATUS` maps each `ErrorCode` to its status: `QUOTA_EXCEEDED` is 429, `INSTANCE_NOT_CONNECTED` is 409, `CONNECT_TOKEN_INVALID` is 401, `BOT_DEFINITION_INVALID` and `WEBHOOK_URL_FORBIDDEN` are 422. `ProblemDetails` has an optional `request_id`.
- 2026-10-19 (foundation): Contracts. Every URL in a request (webhook, media `url`, `external` condition, `call_webhook`) must be HTTPS without user information (`HttpsUrl`). Reason: it is easy to relax a frozen rule later and hard to tighten it. The SSRF guard of the API still checks private ranges. Integration tests of the webhook delivery need an HTTPS receiver or rows that the test writes directly.
- 2026-10-19 (foundation): Contracts. The bot definition is strict (an unknown key is an error) and gets defaults on parse (`on_enter: []`, `actions: []`, `final: false`, `case_sensitive: false`, `flags: ""`, `timeout_ms: 3000`, `variables: {}`). Store the parsed output. Extra rules: a `variable` condition and a `set_variable` action use only declared variables; a transition after an `any` condition is an error; a final state has no transitions and no timeout. The `external` condition reads the response with a JSON Pointer (RFC 6901). The engine must run client regular expressions with a time limit.
- 2026-10-19 (foundation): Contracts. Webhook secrets are `whsec_` plus 32 random bytes in base64url. The full string is the HMAC key. `verifyWebhook` returns `{ valid, reason }` and accepts several `v1=` values in one header (secret rotation). The retry delays (`WEBHOOK_RETRY_DELAYS_SECONDS`) and `WEBHOOK_MAX_ATTEMPTS` (6) are in the contracts. A delivery response also has `webhook_id`. A conversation response also has `created_at`. A transition has `trigger` (`start`, `message`, `timeout`); `from_state` is `null` for `start`.
- 2026-10-19 (infra): Compose networks. `edge` (Caddy, `api`, Uptime Kuma), `internal` with `internal: true` (`api`, `worker`, Evolution, PostgreSQL, Redis, Alloy, `migrate`), and `egress` (internet access without inbound ports: `worker` for the client webhooks and R2, Evolution for WhatsApp, Alloy for Grafana Cloud). Reason: an `internal` network has no route to the internet, but these three services need one.
- 2026-10-19 (infra): Evolution v2.3.7 flags (`infra/compose/evolution.flags.env`, shared by dev and prod). The image loads its `.env.example` for each unset variable, so the file sets every flag. `DATABASE_SAVE_DATA_INSTANCE=true` and `DATABASE_SAVE_DATA_NEW_MESSAGE=true` (sessions; media download, `quoted`, and the Baileys retries); all other save flags are off. `CORS_ORIGIN=*` is necessary: the CORS check refuses a request without an `Origin` header (status 500). `TZ=UTC`, `LOG_LEVEL=ERROR,WARN,INFO`, schema `public`. The health check is `GET /instance/fetchInstances` without the key (401), because `GET /` calls web.whatsapp.com.
- 2026-10-19 (infra): Evolution never deletes its `"Message"` rows (message content). The host timer `botcenter-evolution-retention` (`infra/host/evolution-retention.sh`) deletes the rows with `"messageTimestamp"` (Unix seconds) older than 7 days, in batches, with a Discord alert on failure.
- 2026-10-19 (infra): The Evolution container runs as root with a writable root file system, because its entrypoint runs the Prisma migrations and `prisma generate` at each start. It has no capability, no port, and no route from the internet. Every other service has `read_only: true`. Caddy runs as uid 1000 with only `NET_BIND_SERVICE` (the binary has a file capability; with `cap_drop: [ALL]` alone, the exec fails). PostgreSQL runs as uid 70 and Redis as uid 999.
- 2026-10-19 (infra): Secrets. One env file for each service in `/etc/botcenter` (mode 600), made by `infra/scripts/gen-secrets.sh` from `infra/env/*.env.example`. Passwords, keys, and the webhook secret are 32 random bytes in hex (no URL encoding); `DATA_ENCRYPTION_KEY` is base64. Only `migrate.env` has the owner role (`DATABASE_URL_MIGRATE`); the API and the workers never get it. Redis has a password (`--requirepass`). The env names are the names of `apps/api/src/config/env.ts`.
- 2026-10-19 (infra): Image. One image for `api`, `worker`, and `migrate`: `botcenter-entrypoint` starts `dist/main.js` or `dist/worker.js` by `ROLE`, or runs the given command. The runtime image has pnpm (for `pnpm --filter @botcenter/api db:migrate`), openssl (Prisma schema engine), and tini. The build stage has python3, make, and g++ for native modules (`re2`). Node is 24.22.0 (Alpine 3.24, pinned by digest); `.nvmrc` is `24.22.0` and `engines.node` is `>=24.15.0`.
- 2026-10-19 (infra): Edge. Caddy forwards only `/v1/*` and `/health/*`; it sends one client IP in `X-Forwarded-For` and `X-Real-IP` (from `CF-Connecting-IP` for Cloudflare ranges only), and keeps an upstream connection for 60 s (below `KEEP_ALIVE_TIMEOUT_MS=65000`). The Cloudflare ranges for `trusted_proxies` are a snippet that `firewall-cloudflare.sh` updates. The Uptime Kuma UI is on `127.0.0.1:3001` of the host through Caddy, so Caddy stays the only service with ports.
- 2026-10-19 (infra): Firewall. Docker publishes ports with NAT rules that bypass ufw, so the Cloudflare filter is in the `DOCKER-USER` chain (backend `docker-user`). The Hetzner Cloud Firewall (backend `hcloud`) is the second layer. ufw only closes the host ports (SSH only on `tailscale0`). unattended-upgrades does not reboot the host (a reboot stops every WhatsApp session); the runbook has a weekly check.
- 2026-10-19 (infra): Backups. `pg_dump -Fc -Z0` of `botcenter` and `evolution` to a temporary file, then `pg_restore --list` as a check, then one restic snapshot (tag `postgres`) in the `restic/restic` container with the uid of the caller. restic compresses and deduplicates. The restore test runs monthly on the production host in a temporary PostgreSQL container (no network, 512 MB); the runbook also allows a run on an other machine. The scripts write text file metrics that Alloy reads (`botcenter_backup_*`, `botcenter_restore_test_*`).
- 2026-10-19 (infra): Logs. The json-file log driver adds the labels `com.docker.compose.service` and `com.docker.compose.project` to each line, so Alloy reads the log files without the Docker socket (root without capabilities, read-only mounts). Alloy masks phone numbers in the Evolution lines.
- 2026-10-19 (infra): The host scripts send their alerts to `ALERT_DISCORD_WEBHOOK_URL` (the same name as the API) without jq, so an alert works when an optional tool is missing.
- 2026-10-19 (infra): The CX22 start host uses the override `compose.prod.cx22.yml` (sum of the limits 3.4 GB, 2 GB swap). `BOTCENTER_COMPOSE_EXTRA_FILES` in `compose.env` selects it. `infra/scripts/compose.sh` and `infra/scripts/deploy.sh` use it, so the runbook commands are the same on the CX22 and the CX32.
- 2026-10-19 (infra): CI runs gitleaks and Trivy as containers pinned by digest, not as actions: the gitleaks action needs a license for an organization, and a container image by digest is a smaller supply chain risk. Every action is pinned by commit SHA. The deploy is a manual `workflow_dispatch` job (environment `production`, Tailscale OAuth client, SSH to `deploy.sh`).
- 2026-10-19 (infra): New workspace package `@botcenter/tests-infra` (`tests/infra`). Its unit tests check the Compose invariants, the Evolution flags, the Caddyfile, the alert metric names, the env templates, and the host scripts with fake commands. Its integration tests start PostgreSQL with the init script and the real migrations, and Caddy with a fake upstream. The gate runs them (`pnpm test`, `pnpm test:int`).
