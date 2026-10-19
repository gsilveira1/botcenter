import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Prisma 7 configuration. Two callers load this file:
 * - the `@botcenter/prisma` package (development and CI: `pnpm --filter @botcenter/prisma migrate`);
 * - the API image, where `prisma` can be a runtime dependency of `apps/api` and not of this package.
 * The import of `prisma/config` resolves from this directory first and from `apps/api` as a fallback.
 * Migrations use `DATABASE_URL_MIGRATE` (the table owner). The API uses `DATABASE_URL`.
 * Without a URL, the config uses a placeholder URL. `generate`, `validate`, and `migrate diff --from-empty`
 * work with it, and `migrate deploy` fails on the connection. Prisma 7 needs a datasource URL even for an
 * offline `migrate diff`: without one, it prints nothing and exits with 0.
 */
const here = __dirname;

type DefineConfig = (input: Record<string, unknown>) => unknown;

function loadDefineConfig(): DefineConfig {
  const candidates = [
    path.join(here, 'package.json'),
    path.join(here, '..', 'apps', 'api', 'package.json'),
  ];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return (createRequire(candidate)('prisma/config') as { defineConfig: DefineConfig })
        .defineConfig;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Cannot resolve prisma/config.\n${failures.join('\n')}`);
}

const PLACEHOLDER_URL = 'postgresql://unset:unset@localhost:5432/unset';
const url = process.env['DATABASE_URL_MIGRATE'] || process.env['DATABASE_URL'] || PLACEHOLDER_URL;

export default loadDefineConfig()({
  schema: path.join(here, 'schema.prisma'),
  migrations: {
    path: path.join(here, 'migrations'),
  },
  datasource: { url },
});
