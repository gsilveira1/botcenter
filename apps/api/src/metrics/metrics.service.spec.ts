import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from './metrics.service';
import { createWorkerReadiness } from '../health/worker-readiness';
import { closeServer, startWorkerMetricsServer } from './worker-metrics.server';

const FIXED_NAMES = [
  'botcenter_instances',
  'botcenter_queue_delay_seconds',
  'botcenter_queue_size',
  'botcenter_messages_total',
  'botcenter_webhook_deliveries_total',
  'botcenter_rate_limit_denied_total',
  'http_request_duration_seconds',
];

describe('MetricsService', () => {
  it('registers the metric names that the alert rules use, with the role label', async () => {
    const metrics = new MetricsService(testEnv({ ROLE: 'worker' }));
    metrics.messagesTotal.inc({ status: 'sent' });
    const text = await metrics.render();
    for (const name of FIXED_NAMES) {
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(text).toContain('botcenter_messages_total{status="sent",role="worker"} 1');
  });

  it('returns the same metric for the same name', () => {
    const metrics = new MetricsService(testEnv());
    const first = metrics.counter({
      name: 'botcenter_test_total',
      help: 'test',
      labelNames: ['a'],
    });
    expect(metrics.counter({ name: 'botcenter_test_total', help: 'test', labelNames: ['a'] })).toBe(
      first,
    );
  });

  it('runs the collectors before a scrape; a failed collector does not stop the scrape', async () => {
    const metrics = new MetricsService(testEnv());
    metrics.addCollector(async () => {
      metrics.queueSize.set({ queue: 'outbound', state: 'waiting' }, 4);
    });
    metrics.addCollector(async () => Promise.reject(new Error('redis down')));
    expect(await metrics.render()).toContain(
      'botcenter_queue_size{queue="outbound",state="waiting",role="api"} 4',
    );
  });
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => (body += chunk.toString()));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    call.on('error', reject);
    call.end();
  });
}

describe('worker metrics listener', () => {
  it('serves /metrics and /health/live and nothing else', async () => {
    const server = await startWorkerMetricsServer(
      new MetricsService(testEnv({ ROLE: 'worker' })),
      0,
      '127.0.0.1',
    );
    const { port } = server.address() as AddressInfo;
    try {
      expect((await get(port, '/metrics')).body).toContain('botcenter_jobs_total');
      expect(await get(port, '/health/live')).toEqual({ status: 200, body: '{"status":"ok"}' });
      expect((await get(port, '/other')).status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });
});

describe('worker readiness (ARCH-17)', () => {
  it('answers /health/ready with 503 and sets botcenter_worker_ready 0 when Redis is down', async () => {
    let redisUp = false;
    const readiness = createWorkerReadiness(
      { $queryRaw: async () => [1] },
      {
        ping: async () => {
          if (!redisUp) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
          return 'PONG';
        },
      },
    );
    const metrics = new MetricsService(testEnv({ ROLE: 'worker' }));
    const server = await startWorkerMetricsServer(metrics, 0, '127.0.0.1', readiness);
    const { port } = server.address() as AddressInfo;
    try {
      const down = await get(port, '/health/ready');
      expect(down.status).toBe(503);
      expect(JSON.parse(down.body)).toMatchObject({
        status: 'unavailable',
        checks: { database: { status: 'up' }, redis: { status: 'down', error: 'ECONNREFUSED' } },
      });
      expect((await get(port, '/metrics')).body).toContain('botcenter_worker_ready{role="worker"} 0');

      redisUp = true;
      expect((await get(port, '/health/ready')).status).toBe(200);
      expect((await get(port, '/metrics')).body).toContain('botcenter_worker_ready{role="worker"} 1');
      // Liveness stays independent of the dependencies.
      expect((await get(port, '/health/live')).status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });
});
