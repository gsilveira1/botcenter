import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import type { AlertService } from '../services/alert.service';
import type { QuotaService } from './quota.service';
import { RateLimitService } from './rate-limit.service';

function build(consume: () => Promise<unknown>, peek: () => Promise<unknown> = consume) {
  const metrics = new MetricsService(testEnv());
  const alerts = { notify: vi.fn(async () => undefined) };
  const service = new RateLimitService(
    { consume: vi.fn(consume), peek: vi.fn(peek) } as unknown as QuotaService,
    metrics,
    alerts as unknown as AlertService,
  );
  return { service, metrics, alerts };
}

const result = (allowed: boolean) => ({
  allowed,
  used: 3,
  limit: 3,
  remaining: allowed ? 1 : 0,
  resetAt: new Date(),
  retryAfterSeconds: 12,
});

describe('RateLimitService', () => {
  it('returns the RateLimit headers when the request is allowed', async () => {
    const { service } = build(async () => result(true));
    await expect(service.consumeKey('k', 3)).resolves.toEqual({
      headers: { 'RateLimit-Limit': '3', 'RateLimit-Remaining': '1', 'RateLimit-Reset': '12' },
    });
  });

  it('throws 429 RATE_LIMITED with Retry-After and counts the refusal', async () => {
    const { service, metrics } = build(async () => result(false));
    await expect(service.consumeKey('k', 3)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      headers: { 'Retry-After': '12', 'RateLimit-Remaining': '0' },
    });
    const metric = await metrics.rateLimitDeniedTotal.get();
    expect(metric.values).toEqual([{ labels: { scope: 'key' }, value: 1 }]);
  });

  it('fails open when Redis fails: no headers, an alert', async () => {
    const { service, alerts } = build(async () => Promise.reject(new Error('ECONNREFUSED')));
    await expect(service.consumeKey('k', 3)).resolves.toEqual({ headers: null });
    expect(alerts.notify).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'rate-limit:redis' }),
    );
  });

  it('refuses an address above the failure limit with 429 and fails open on a Redis error (SEC-10)', async () => {
    const limited = build(
      async () => result(true),
      async () => result(false),
    );
    await expect(limited.service.assertAuthFailuresBelowLimit('203.0.113.1')).rejects.toMatchObject(
      {
        code: 'RATE_LIMITED',
        headers: { 'Retry-After': '12' },
      },
    );
    const metric = await limited.metrics.rateLimitDeniedTotal.get();
    expect(metric.values).toEqual([{ labels: { scope: 'ip_auth_failures' }, value: 1 }]);

    const down = build(async () => Promise.reject(new Error('ECONNREFUSED')));
    await expect(down.service.assertAuthFailuresBelowLimit('203.0.113.1')).resolves.toBeUndefined();
    await expect(down.service.recordAuthFailure('203.0.113.1')).resolves.toBeUndefined();
    await expect(down.service.consumeConnect('203.0.113.1')).resolves.toBeUndefined();
    expect(down.alerts.notify).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'rate-limit:ip:redis' }),
    );
  });

  it('refuses the connect route above the limit of the address (SEC-10)', async () => {
    const { service } = build(async () => result(false));
    await expect(service.consumeConnect('203.0.113.1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});
