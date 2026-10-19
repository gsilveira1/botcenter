import 'reflect-metadata';
import { createApiApp } from './bootstrap';
import { createShutdown } from './common/shutdown';
import { loadEnv } from './config/env';
import { createRootLogger, flushLogs, getLogger } from './logging/logger';
import { closeServer, startApiMetricsServer } from './metrics/metrics-listener';
import { MetricsService } from './metrics/metrics.service';

/**
 * Entry point of the API process: `node dist/main.js` with `ROLE=api`.
 * Container memory: set `NODE_OPTIONS=--max-old-space-size=<75 % of the limit>` in the Dockerfile or
 * Compose file (384 for the 512 MB API container).
 */
async function main(): Promise<void> {
  process.env['ROLE'] ??= 'api';
  const env = loadEnv();
  if (env.ROLE !== 'api') {
    throw new Error(`dist/main.js runs the API: ROLE must be "api", not "${env.ROLE}"`);
  }
  createRootLogger(env.LOG_LEVEL);
  const logger = getLogger('main');
  const app = await createApiApp();
  await app.listen({ port: env.PORT, host: '::' });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
  // SEC-01: /metrics is only on this listener (the `metrics` network), not on the HTTP port.
  const metricsServer = await startApiMetricsServer(
    app.get(MetricsService),
    env.API_METRICS_PORT,
    env.API_METRICS_HOST,
  );

  const shutdown = createShutdown({
    close: async () => {
      await closeServer(metricsServer);
      await app.close();
    },
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    logger,
  });
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  getLogger('main').fatal({ err: error }, 'api failed to start');
  flushLogs();
  process.exit(1);
});
