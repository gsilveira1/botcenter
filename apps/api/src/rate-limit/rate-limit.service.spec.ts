import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import type { AlertService } from '../services/alert.service';
import type { QuotaService } from './quota.service';
import { RateLimitService } from './rate-limit.service';

function build(consume: () => Promise<unknown>) {
  const metrics = new MetricsService(testEnv());
  const alerts = { notify: vi.fn(async () => undefined) };
  const service = new RateLimitService(
    { consume: vi.fn(consume) } as unknown as QuotaService,
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
});
