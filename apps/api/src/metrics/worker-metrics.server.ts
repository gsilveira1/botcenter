import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ReadinessProbe } from '../health/worker-readiness';
import { getLogger } from '../logging/logger';
import type { MetricsService } from './metrics.service';

/**
 * The internal HTTP listener of the worker process (`WORKER_METRICS_PORT`, default 9464):
 * `GET /metrics` (Prometheus text), `GET /health/live`, and, with a readiness probe, `GET /health/ready`
 * (PostgreSQL and Redis; 503 when one check fails). The probe also sets the gauge
 * `botcenter_worker_ready` (1 or 0) before each scrape. The worker container publishes no port, so only
 * the Docker network (Grafana Alloy, Compose health check) reaches it.
 */
export async function startWorkerMetricsServer(
  metrics: MetricsService,
  port: number,
  host = '::',
  readiness?: ReadinessProbe,
): Promise<Server> {
  const logger = getLogger('worker-metrics');
  if (readiness) {
    const ready = metrics.gauge({
      name: 'botcenter_worker_ready',
      help: '1 when the worker process reaches PostgreSQL and Redis, else 0',
    });
    metrics.addCollector(async () => {
      ready.set((await readiness()).status === 'ok' ? 1 : 0);
    });
  }
  const routes: Record<string, (response: ServerResponse) => Promise<void>> = {
    '/health/live': async (response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    },
    '/metrics': async (response) => {
      const body = await metrics.render();
      response.writeHead(200, { 'content-type': metrics.contentType }).end(body);
    },
  };
  if (readiness) {
    routes['/health/ready'] = async (response) => {
      const report = await readiness();
      if (report.status !== 'ok') {
        logger.warn({ checks: report.checks }, 'worker readiness check failed');
      }
      response
        .writeHead(report.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify(report));
    };
  }
  return listen(routes, port, host, 'worker metrics listening');
}

/**
 * Starts a `node:http` listener with GET routes only. A route that throws gets 500 and an error log.
 * Other methods get 405, other paths 404.
 */
export async function listen(
  routes: Record<string, (response: ServerResponse) => Promise<void>>,
  port: number,
  host: string,
  message: string,
): Promise<Server> {
  const logger = getLogger('metrics-listener');
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    const route = routes[path];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    route(response).catch((error: unknown) => {
      logger.error({ err: error, path }, 'internal listener route failed');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port, host }, message);
  return server;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
