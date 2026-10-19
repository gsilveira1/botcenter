import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { getLogger } from '../logging/logger';
import type { MetricsService } from './metrics.service';

/**
 * The internal HTTP listener of the worker process (`WORKER_METRICS_PORT`, default 9464):
 * `GET /metrics` (Prometheus text) and `GET /health/live`. The worker container publishes no port, so
 * only the Docker network (Grafana Alloy, Compose health check) reaches it.
 */
export async function startWorkerMetricsServer(
  metrics: MetricsService,
  port: number,
  host = '::',
): Promise<Server> {
  const logger = getLogger('worker-metrics');
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (path === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (path !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    metrics
      .render()
      .then((body) => {
        response.writeHead(200, { 'content-type': metrics.contentType }).end(body);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'metrics render failed');
        response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port }, 'worker metrics listening');
  return server;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
