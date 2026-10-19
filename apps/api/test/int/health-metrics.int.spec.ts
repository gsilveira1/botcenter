import { ProviderError } from '@botcenter/whatsapp-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetricsService } from '../../src/metrics/metrics.service';
import { QueuesService } from '../../src/queues/queues.service';
import { TestHarness } from '../support/harness';

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start();
});

afterAll(async () => {
  await h?.close();
});

describe('health', () => {
  it('GET /health/live answers without a dependency', async () => {
    const response = await h.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports each check and answers 200 when all are up', async () => {
    const response = await h.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up' }, redis: { status: 'up' }, provider: { status: 'up' } },
    });
  });

  it('GET /health/ready answers 503 when the provider does not answer', async () => {
    h.provider.failNext('ping', new ProviderError('unavailable', 'down'));
    const response = await h.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'up' }, provider: { status: 'down', error: 'unavailable' } },
    });
  });
});

describe('metrics (SEC-01)', () => {
  it('has no /metrics route on the HTTP port of the API, also for a private address', async () => {
    // The API serves /metrics on a separate listener (API_METRICS_PORT) on the `metrics` network only,
    // so a redirect through the Evolution API cannot read it on port 3000.
    const response = await h.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(404);
  });

  it('renders the Prometheus text with the fixed metric names', async () => {
    await h
      .get(QueuesService)
      .add('outbound', 'send', { tenantId: 't', messageId: 'm', instanceId: 'i' });
    await h.inject({ method: 'GET', url: '/health/live' });
    const text = await h.get(MetricsService).render();
    for (const name of [
      'http_request_duration_seconds_bucket',
      'botcenter_queue_size{',
      'botcenter_queue_delay_seconds{',
      'botcenter_instances{',
      'process_cpu_user_seconds_total',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/botcenter_queue_size\{queue="outbound",state="waiting",role="api"\} 1/);
    expect(text).toContain('route="/health/live"');
  });
});
