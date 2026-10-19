# Bot Center

Bot Center is a gateway and a bot engine in front of the Evolution API (WhatsApp).
Client products use a versioned REST API (`/v1`) with scoped API keys and receive signed webhooks.

- Architecture (pt-BR): `docs/Plano de Arquitetura Servidor Evolution API para Bots de WhatsApp.md`
- Build plan and decisions (STE): `docs/implementation-plan.md`

## Requirements

- Node 24 (`.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for the integration tests)

## Packages

| Path                 | Package                | Content                                                                                 |
| -------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `packages/config`    | `@botcenter/config`    | Shared tsconfig and ESLint flat config                                                  |
| `packages/contracts` | `@botcenter/contracts` | Zod schemas of the public API, error codes, events, bot definitions, webhook signatures |
| `prisma/`            | `@botcenter/prisma`    | Prisma schema, SQL migrations, Prisma CLI (see `prisma/README.md`)                      |
| `apps/api`           | `@botcenter/api`       | NestJS API (`ROLE=api`) and workers (`ROLE=worker`), see `apps/api/README.md`           |

## Commands

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:int      # needs Docker
pnpm gate          # all the checks above, in sequence
pnpm format        # write the Prettier format
```

## Configuration

Keep the configuration in environment variables. `.env.example` lists the variables and their use.
