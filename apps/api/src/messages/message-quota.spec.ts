import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { AppError } from '../common/errors/app-error';
import { MetricsService } from '../metrics/metrics.service';
import { MessageQuota } from './message-quota';

function setup(consume: ReturnType<typeof vi.fn>) {
  const quotas = { consume, refund: vi.fn(async () => {}) };
  const tenants = { get: vi.fn(async () => ({ id: 't-1', maxMessagesPerDay: 2 })) };
  const alerts = { notify: vi.fn(async () => {}) };
  const quota = new MessageQuota(
    quotas as never,
    tenants as never,
    new MetricsService(testEnv()),
    alerts as never,
  );
  return { quota, quotas, alerts };
}

describe('MessageQuota', () => {
  it('uses the daily window with the tenant limit and gives a refund function', async () => {
    const s = setup(vi.fn(async () => ({ allowed: true })));
    const refund = await s.quota.consume('t-1');
    expect(s.quotas.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'messages-per-day',
        subject: 't-1',
        window: 'day',
        limit: 2,
      }),
    );
    await refund();
    expect(s.quotas.refund).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'messages-per-day', subject: 't-1', window: 'day' }),
    );
  });

  it('refuses with 429 QUOTA_EXCEEDED and Retry-After until the next UTC midnight', async () => {
    const s = setup(vi.fn(async () => ({ allowed: false, limit: 2, retryAfterSeconds: 3600 })));
    const error = await s.quota.consume('t-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('QUOTA_EXCEEDED');
    expect((error as AppError).headers).toEqual({ 'Retry-After': '3600' });
  });

  it('fails open with an alert when Redis fails', async () => {
    const s = setup(vi.fn(async () => Promise.reject(new Error('redis down'))));
    await expect(s.quota.consume('t-1')).resolves.toBeTypeOf('function');
    expect(s.alerts.notify).toHaveBeenCalledOnce();
  });
});
