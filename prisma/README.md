# @botcenter/prisma

This package owns the Prisma schema, the SQL migrations, and the Prisma CLI of Bot Center.
It is a tooling package, not a library. The API imports only the generated client.

## Generated client

- `pnpm --filter @botcenter/prisma generate` writes the client to `apps/api/src/generated/prisma` (git ignores it).
- The `build` script of this package also runs `prisma generate`. Thus, a package that depends on `@botcenter/prisma` gets a current client from the `^build` dependency of Turborepo.
- The client is CommonJS (`moduleFormat = "cjs"`), for the NestJS API. Import it from `apps/api/src/...` with a relative path, for example `import { PrismaClient, Prisma } from '../generated/prisma/client';`.
- Prisma 7 needs a driver adapter at runtime: `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })` with `@prisma/adapter-pg`.
- The ids use `@default(uuid(7))`. The Prisma client makes the id, not the database. A raw SQL insert must give the `id`.

## Environment

| Variable               | Use                                                                       |
| ---------------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL_MIGRATE` | Connection of the table owner. The migrate commands use it first.         |
| `DATABASE_URL`         | Fallback for the migrate commands when `DATABASE_URL_MIGRATE` is not set. |

Without a URL, `prisma.config.ts` uses a placeholder URL (`postgresql://unset:unset@localhost:5432/unset`).
Prisma 7 needs a datasource URL even for an offline `migrate diff`. Without one, it prints nothing and exits with 0.

## Commands

Run the commands from the repository root.

```sh
pnpm --filter @botcenter/prisma generate        # generate the client
pnpm --filter @botcenter/prisma validate        # validate schema.prisma
pnpm --filter @botcenter/prisma migrate         # apply the migrations (prisma migrate deploy)
pnpm --filter @botcenter/prisma migrate:status  # show the status of the migrations
pnpm --filter @botcenter/prisma test            # unit tests (no database)
pnpm --filter @botcenter/prisma test:int        # apply the migrations to PostgreSQL 16 (Testcontainers) and check the drift
```

## Add a migration

Wave 2 slices add migrations. Do not edit a migration that is on `develop`.

1. Change `schema.prisma`.
2. Start a throwaway PostgreSQL 16 and apply the current migrations:

   ```sh
   docker run -d --rm --name bc-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1::5432 postgres:16-alpine
   export DATABASE_URL_MIGRATE="postgresql://postgres:pw@127.0.0.1:$(docker port bc-pg 5432 | head -1 | cut -d: -f2)/postgres"
   pnpm --filter @botcenter/prisma migrate
   ```

3. Write the difference to a new migration. The name is `<timestamp>_<slice>_<change>`:

   ```sh
   cd prisma
   mkdir migrations/20261020120000_messages_add_column
   npx prisma migrate diff --config prisma.config.ts --from-config-datasource \
     --to-schema schema.prisma --script > migrations/20261020120000_messages_add_column/migration.sql
   ```

4. Make sure that the file is not empty. Then stop the container: `docker stop bc-pg`.
5. Run `pnpm --filter @botcenter/prisma test:int`. The drift test fails if the migrations and `schema.prisma` differ.

## Hand-written SQL

The first migration (`20261019000000_init`) has a hand-written block after the generated SQL:
the function `audit_logs_refuse_change` and two triggers. They refuse `UPDATE`, `DELETE`, and `TRUNCATE` on `audit_logs`.

## Preview feature

The schema uses the preview feature `partialIndexes`, so that `schema.prisma` declares the two partial indexes:

- `instances_tenantId_externalRef_active_key`: one active instance (`deletedAt IS NULL`) for each `(tenantId, externalRef)`.
- `outbox_events_pending_idx`: the rows of the outbox that are not dispatched.
