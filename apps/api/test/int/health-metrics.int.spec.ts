import { ProviderError } from '@botcenter/whatsapp-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    h.provider.pingError = new ProviderError('unavailable', 'down');
    try {
      const response = await h.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: 'unavailable',
        checks: { database: { status: 'up' }, provider: { status: 'down', error: 'unavailable' } },
      });
    } finally {
      h.provider.pingError = undefined;
    }
  });
});

describe('GET /metrics', () => {
  it('answers a private address with the Prometheus text and the fixed metric names', async () => {
    await h
      .get(QueuesService)
      .add('outbound', 'send', { tenantId: 't', messageId: 'm', instanceId: 'i' });
    await h.inject({ method: 'GET', url: '/health/live' });
    const response = await h.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const text = response.body;
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

  it('refuses a public client address with 404', async () => {
    const response = await h.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-forwarded-for': '203.0.113.50' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('does not trust a private address that a public client puts in X-Forwarded-For', async () => {
    const response = await h.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-forwarded-for': '10.0.0.5, 203.0.113.50' },
    });
    expect(response.statusCode).toBe(404);
  });
});
