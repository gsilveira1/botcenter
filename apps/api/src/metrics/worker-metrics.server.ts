import type { Server } from 'node:http';
import type { ReadinessProbe } from '../health/worker-readiness';
import { getLogger } from '../logging/logger';
import { listen, metricsRoute } from './metrics-listener';
import type { ListenerRoute } from './metrics-listener';
import type { MetricsService } from './metrics.service';

export { closeServer } from './metrics-listener';

/**
 * The internal HTTP listener of the worker process (`WORKER_METRICS_PORT`, default 9464):
 * `GET /metrics` (Prometheus text), `GET /health/live`, and, with a readiness probe, `GET /health/ready`
 * (PostgreSQL and Redis; 503 when one check fails). The probe also sets the gauge
 * `botcenter_worker_ready` (1 or 0) before each scrape. The worker container publishes no port, so only
 * the `metrics` network (Grafana Alloy, Compose health check) reaches it (`WORKER_METRICS_HOST`).
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
  const routes: Record<string, ListenerRoute> = {
    '/health/live': async (response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    },
    '/metrics': metricsRoute(metrics),
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
