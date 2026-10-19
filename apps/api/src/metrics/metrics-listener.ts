import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { getLogger } from '../logging/logger';
import type { MetricsService } from './metrics.service';

/** A GET route of an internal listener. */
export type ListenerRoute = (response: ServerResponse) => Promise<void>;

/** The Prometheus text of the process. */
export function metricsRoute(metrics: MetricsService): ListenerRoute {
  return async (response) => {
    const body = await metrics.render();
    response.writeHead(200, { 'content-type': metrics.contentType }).end(body);
  };
}

/**
 * Starts a `node:http` listener with GET routes only. A route that throws gets 500 and an error log.
 * Other methods get 405, other paths 404.
 */
export async function listen(
  routes: Record<string, ListenerRoute>,
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

/**
 * The metrics listener of the API process (`API_METRICS_PORT`, default 9465): `GET /metrics` only.
 * Compose binds it to the address of the API on the `metrics` network, which only Grafana Alloy
 * reaches (SEC-01). The HTTP port of the API (3000) has no `/metrics` route.
 */
export function startApiMetricsServer(
  metrics: MetricsService,
  port: number,
  host = '::',
): Promise<Server> {
  return listen({ '/metrics': metricsRoute(metrics) }, port, host, 'api metrics listening');
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
