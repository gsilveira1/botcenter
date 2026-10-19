import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApiApp } from '../bootstrap';
import { createRootLogger, flushLogs, getLogger } from '../logging/logger';
import { buildOpenApiDocument } from '../openapi/openapi.document';
import { OPENAPI_PLACEHOLDER_ENV, serializeDocument } from '../openapi/openapi-export';

/**
 * Writes `apps/api/openapi.json`: `pnpm --filter @botcenter/api openapi`. The export needs no database and
 * no Redis (the connections are lazy). Missing variables get placeholder values, so CI can run it.
 */
async function main(): Promise<void> {
  for (const [name, value] of Object.entries(OPENAPI_PLACEHOLDER_ENV)) {
    process.env[name] ??= value;
  }
  process.env['ROLE'] = 'api';
  createRootLogger(process.env['LOG_LEVEL'] ?? 'warn');
  const app = await createApiApp();
  await app.init();
  try {
    const target = path.resolve(__dirname, '..', '..', 'openapi.json');
    writeFileSync(target, serializeDocument(buildOpenApiDocument(app)));
    process.stdout.write(`OpenAPI document written to ${target}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  getLogger('openapi').fatal({ err: error }, 'OpenAPI export failed');
  flushLogs();
  process.exit(1);
});
