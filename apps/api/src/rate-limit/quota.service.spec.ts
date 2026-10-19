import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { QuotaService } from './quota.service';

describe('QuotaService', () => {
  it('uses a UTC day window key and computes the reset time', async () => {
    const evalMock = vi.fn(async () => [1, 4]);
    const service = new QuotaService({ eval: evalMock } as unknown as Redis);
    const now = new Date('2026-10-19T23:59:30.000Z');
    const result = await service.consume({
      name: 'messages-per-day',
      subject: 't-1',
      window: 'day',
      limit: 10,
      now,
    });
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'bc:quota:messages-per-day:t-1:2026-10-19',
      '1',
      '10',
      String(30_000 + 60_000),
    );
    expect(result).toEqual({
      allowed: true,
      used: 4,
      limit: 10,
      remaining: 6,
      resetAt: new Date('2026-10-20T00:00:00.000Z'),
      retryAfterSeconds: 30,
    });
  });

  it('uses a minute window key and reports a refusal', async () => {
    const service = new QuotaService({ eval: vi.fn(async () => [0, 5]) } as unknown as Redis);
    const now = new Date('2026-10-19T10:00:59.500Z');
    const result = await service.consume({
      name: 'api-key',
      subject: 'k',
      window: 'minute',
      limit: 5,
      amount: 2,
      now,
    });
    expect(result).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1 });
  });
});
