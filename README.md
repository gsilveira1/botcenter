# Bot Center

Bot Center is a gateway and a bot engine in front of the Evolution API (WhatsApp).
Client products use a versioned REST API (`/v1`) with scoped API keys and receive signed webhooks.

- Architecture (pt-BR): `docs/Plano de Arquitetura Servidor Evolution API para Bots de WhatsApp.md`
- Build plan and decisions (STE): `docs/implementation-plan.md`
- Operations (host, deploy, backups, incidents): `docs/runbook.md`

## Requirements

- Node 24 (`.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for the integration tests and the infrastructure tests)

## Repository map

| Path                 | Package                  | Content                                                                                                      |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `packages/config`    | `@botcenter/config`      | Shared tsconfig and ESLint flat config                                                                       |
| `packages/contracts` | `@botcenter/contracts`   | Zod schemas of the public API, error codes, events, bot definitions, webhook signatures                      |
| `prisma/`            | `@botcenter/prisma`      | Prisma schema, SQL migrations, Prisma CLI (see `prisma/README.md`)                                           |
| `apps/api`           | `@botcenter/api`         | NestJS API (`ROLE=api`) and workers (`ROLE=worker`), see `apps/api/README.md`                                |
| `infra/`             | none                     | Production and development stack: Compose, Caddy, Alloy, alert rules, host and backup scripts, env templates |
| `tests/infra`        | `@botcenter/tests-infra` | Tests of `infra/`: Compose invariants, env templates, host scripts, Caddy, Redis users, promtool, firewall   |
| `tests/load`         | none                     | k6 load tests and a fake Evolution API (see `tests/load/README.md`)                                          |
| `tests/smoke`        | none                     | End-to-end smoke test of the full stack, when it exists on the branch                                        |

`infra/` in detail:

| Path                  | Content                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `infra/compose`       | `compose.prod.yml` (one host), `compose.prod.cx22.yml` (4 GB profile), `compose.dev.yml`       |
| `infra/env`           | One template for each env file of `/etc/botcenter` (`infra/scripts/gen-secrets.sh` fills them) |
| `infra/caddy`         | Caddyfile (edge proxy), Cloudflare ranges, Cloudflare origin pull CA                           |
| `infra/observability` | Alloy config, Prometheus alert rules and their promtool tests, Grafana dashboard               |
| `infra/host`          | Host bootstrap, firewall (Cloudflare and Evolution egress), Evolution retention, systemd units |
| `infra/backup`        | Backup, restore test, and disk check scripts with their systemd units                          |
| `infra/scripts`       | `compose.sh`, `deploy.sh`, `gen-secrets.sh`                                                    |
| `infra/docker`        | The image of the API, the workers, and the migrations                                          |

## Commands

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test          # unit tests, also tests/infra (Compose, env templates, host scripts)
pnpm build
pnpm test:int      # needs Docker: PostgreSQL, Redis, MinIO, Caddy, promtool, iptables, Alloy
pnpm gate          # lint, typecheck, test, build, and test:int, in sequence
pnpm format        # write the Prettier format
pnpm format:check
```

Local stack for development (`127.0.0.1` only):

```sh
docker compose -f infra/compose/compose.dev.yml up -d
pnpm build
pnpm db:migrate
pnpm --filter @botcenter/api start          # the API (ROLE=api)
pnpm --filter @botcenter/api start:worker   # the workers (ROLE=worker)
```

Production: see `docs/runbook.md` (procedures "Prepare the host", "First deploy", and "Deploy a release").

## Configuration

Keep the configuration in environment variables. `.env.example` lists the variables for a local run. `infra/env/api.env.example` lists every variable of `apps/api/src/config/env.ts` for production; a test of `tests/infra` fails when a variable is missing.
