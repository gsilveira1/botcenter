import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createShutdown } from './common/shutdown';
import { loadEnv } from './config/env';
import { PinoNestLogger, createRootLogger, flushLogs, getLogger } from './logging/logger';
import { MetricsService } from './metrics/metrics.service';
import { closeServer, startWorkerMetricsServer } from './metrics/worker-metrics.server';
import { WorkerModule } from './worker.module';

/**
 * Entry point of the worker process: `node dist/worker.js` with `ROLE=worker`. It starts a Nest
 * application context (no HTTP server) with the queue consumers and the internal metrics listener.
 * Graceful shutdown: SIGTERM closes the metrics listener, then `app.close()` closes the workers (BullMQ
 * waits for the current jobs; the other jobs stay in the queue), the queues, Redis, and PostgreSQL.
 * Container memory: `NODE_OPTIONS=--max-old-space-size=768` for the 1 GB worker container.
 */
async function main(): Promise<void> {
  process.env['ROLE'] ??= 'worker';
  const env = loadEnv();
  if (env.ROLE !== 'worker') {
    throw new Error(`dist/worker.js runs the workers: ROLE must be "worker", not "${env.ROLE}"`);
  }
  createRootLogger(env.LOG_LEVEL);
  const logger = getLogger('worker');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new PinoNestLogger(),
    abortOnError: false,
  });
  const server = await startWorkerMetricsServer(app.get(MetricsService), env.WORKER_METRICS_PORT);
  logger.info({ env: env.NODE_ENV }, 'worker started');

  const shutdown = createShutdown({
    close: async () => {
      await closeServer(server);
      await app.close();
    },
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    logger,
  });
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  getLogger('worker').fatal({ err: error }, 'worker failed to start');
  flushLogs();
  process.exit(1);
});
