import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import pino from 'pino';
import { AdminCliModule } from '../admin/admin.module';
import { AdminService } from '../admin/admin.service';
import { loadEnv } from '../config/env';
import { PinoNestLogger, createRootLogger, flushLogs, getLogger } from '../logging/logger';
import { ADMIN_USAGE, runAdminCli } from './admin-cli';

/**
 * Admin CLI. Run it in the API container, for example:
 *   docker compose exec api node dist/scripts/admin.js key:create --tenant personallife --name backend --scopes messages:send
 * The pnpm scripts `admin:*` of `@botcenter/api` call it.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help')) {
    // The usage needs no environment and no connection.
    process.stderr.write(`${ADMIN_USAGE}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  const env = loadEnv();
  // stdout carries the JSON result only: the logs go to stderr.
  createRootLogger(
    env.LOG_LEVEL === 'info' ? 'warn' : env.LOG_LEVEL,
    pino.destination({ dest: 2, sync: true }),
  );
  const app = await NestFactory.createApplicationContext(AdminCliModule, {
    logger: new PinoNestLogger(),
    abortOnError: false,
  });
  try {
    return await runAdminCli(argv, app.get(AdminService), {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    });
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    flushLogs();
    process.exit(code);
  })
  .catch((error: unknown) => {
    getLogger('admin').fatal({ err: error }, 'admin command failed');
    flushLogs();
    process.exit(1);
  });
