import { ProviderError } from '@botcenter/whatsapp-provider';
import type { ProviderEvent, ProviderWebhookNormalizer } from '@botcenter/whatsapp-provider';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueuesService } from '../queues/queues.service';
import type { AlertService } from '../services/alert.service';
import { InboundIngestService, inboundJobId, withoutNul } from './inbound-ingest.service';

const event: ProviderEvent = {
  kind: 'message.status',
  instanceName: 'inst_1',
  dedupeKey: 'evo:status:1',
  occurredAt: new Date('2026-10-19T10:00:00Z'),
  providerMessageId: 'p1',
  status: 'read',
};

function build(
  options: {
    normalize?: () => { events: ProviderEvent[]; ignored: number };
    setResult?: string | null;
    addError?: Error;
    rawError?: Error;
  } = {},
) {
  const normalizer: ProviderWebhookNormalizer = {
    normalize: options.normalize ?? (() => ({ events: [event], ignored: 0 })),
  };
  const prisma = {
    instance: { findUnique: vi.fn(async () => ({ id: 'i-1' })) },
    rawEvent: {
      create: vi.fn(async () =>
        options.rawError ? Promise.reject(options.rawError) : { id: 'raw-1' },
      ),
    },
  };
  const redis = {
    set: vi.fn(async () => (options.setResult === undefined ? 'OK' : options.setResult)),
    del: vi.fn(async () => 1),
  };
  const queues = {
    add: vi.fn(async () => (options.addError ? Promise.reject(options.addError) : {})),
  };
  const alerts = { notify: vi.fn(async () => undefined) };
  const service = new InboundIngestService(
    normalizer,
    prisma as unknown as PrismaService,
    redis as unknown as Redis,
    queues as unknown as QueuesService,
    new MetricsService(testEnv()),
    alerts as unknown as AlertService,
  );
  return { service, prisma, redis, queues, alerts };
}

describe('InboundIngestService', () => {
  it('stores the raw body, sets the dedupe key, and enqueues with a hashed job id', async () => {
    const { service, prisma, redis, queues } = build();
    await expect(service.ingest({ raw: true })).resolves.toEqual({
      received: 1,
      enqueued: 1,
      duplicates: 0,
      ignored: 0,
    });
    expect(prisma.rawEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ instanceId: 'i-1', eventType: 'message.status' }),
      }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      'bc:dedupe:inbound:evo:status:1',
      '1',
      'EX',
      86_400,
      'NX',
    );
    expect(queues.add).toHaveBeenCalledWith(
      'inbound',
      'message.status',
      expect.objectContaining({
        rawEventId: 'raw-1',
        event: expect.objectContaining({ occurredAt: '2026-10-19T10:00:00.000Z' }),
      }),
      { jobId: inboundJobId('evo:status:1') },
    );
    expect(inboundJobId('evo:status:1')).toMatch(/^in-[0-9a-f]{64}$/);
  });

  it('counts a duplicate and does not enqueue it', async () => {
    const { service, queues } = build({ setResult: null });
    await expect(service.ingest({})).resolves.toMatchObject({ enqueued: 0, duplicates: 1 });
    expect(queues.add).not.toHaveBeenCalled();
  });

  it('frees the dedupe key, alerts, and throws 500 when the queue fails (the provider retries)', async () => {
    const { service, redis, alerts } = build({ addError: new Error('redis down') });
    await expect(service.ingest({})).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(redis.del).toHaveBeenCalledWith('bc:dedupe:inbound:evo:status:1');
    expect(alerts.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('throws 500 without an enqueue when the raw event store fails (the provider retries)', async () => {
    const { service, queues, redis, alerts } = build({ rawError: new Error('db down') });
    await expect(service.ingest({})).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });
    expect(queues.add).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(alerts.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('throws 400 for a rejected body and keeps it; other normalizer errors pass through', async () => {
    const rejected = build({
      normalize: () => {
        throw new ProviderError('rejected', 'unknown');
      },
    });
    await expect(rejected.service.ingest({})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });
    expect(rejected.prisma.rawEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'rejected' }) }),
    );
    const rejectedNoDb = build({
      rawError: new Error('db down'),
      normalize: () => {
        throw new ProviderError('rejected', 'unknown');
      },
    });
    await expect(rejectedNoDb.service.ingest({})).rejects.toMatchObject({ status: 400 });
    const broken = build({
      normalize: () => {
        throw new TypeError('bug');
      },
    });
    await expect(broken.service.ingest({})).rejects.toThrow('bug');
  });

  it('stores an all-ignored body with the type "ignored"', async () => {
    const { service, prisma } = build({ normalize: () => ({ events: [], ignored: 2 }) });
    await expect(service.ingest({})).resolves.toMatchObject({ received: 0, ignored: 2 });
    expect(prisma.rawEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'ignored', instanceId: null }),
      }),
    );
  });

  it('withoutNul removes U+0000 and keeps a literal backslash text', () => {
    expect(withoutNul({ a: 'x\u0000y', b: ['\u0000'] })).toEqual({ a: 'xy', b: [''] });
    expect(withoutNul({ a: '\\u0000' })).toEqual({ a: '\\u0000' });
    expect(withoutNul({ a: '\\\u0000' })).toEqual({ a: '\\' });
    expect(withoutNul(undefined)).toBeNull();
  });
});
