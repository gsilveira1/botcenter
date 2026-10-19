import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import type { InboundJob } from '../queues/queue-names';
import type { WorkerFactory } from '../queues/worker.factory';
import { InboundHandlerRegistry } from './inbound-handler.registry';
import { InboundWorker } from './inbound.worker';

const job = {
  id: 'job-1',
  attemptsMade: 1,
  data: {
    event: {
      kind: 'connection.updated',
      instanceName: 'inst_1',
      dedupeKey: 'd',
      occurredAt: '2026-10-19T10:00:00.000Z',
      state: 'connected',
    },
    rawEventId: 'raw-1',
    receivedAt: '2026-10-19T10:00:01.000Z',
  },
} as unknown as Job<InboundJob>;

function build() {
  const registry = new InboundHandlerRegistry();
  const workers = { create: vi.fn() };
  const metrics = new MetricsService(testEnv());
  return {
    worker: new InboundWorker(workers as unknown as WorkerFactory, registry, metrics),
    registry,
    workers,
    metrics,
  };
}

describe('InboundWorker', () => {
  it('starts the inbound consumer at bootstrap', () => {
    const { worker, workers } = build();
    worker.onApplicationBootstrap();
    expect(workers.create).toHaveBeenCalledWith('inbound', expect.any(Function));
  });

  it('sends the revived event to the handler of its kind', async () => {
    const { worker, registry } = build();
    const handle = vi.fn(async () => undefined);
    registry.register('connection.updated', { handle });
    await expect(worker.process(job)).resolves.toEqual({ handled: true });
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'connection.updated',
        occurredAt: new Date('2026-10-19T10:00:00.000Z'),
      }),
      {
        jobId: 'job-1',
        attemptsMade: 1,
        rawEventId: 'raw-1',
        receivedAt: new Date('2026-10-19T10:00:01.000Z'),
      },
    );
  });

  it('finishes a job without a handler and counts it', async () => {
    const { worker, metrics } = build();
    await expect(worker.process(job)).resolves.toEqual({ handled: false });
    expect((await metrics.inboundEventsTotal.get()).values).toEqual([
      { labels: { result: 'unhandled' }, value: 1 },
    ]);
  });

  it('refuses a second handler for the same kind', () => {
    const { registry } = build();
    registry.register('message.status', { handle: async () => undefined });
    expect(() => registry.register('message.status', { handle: async () => undefined })).toThrow(
      /already registered/,
    );
    expect(registry.kinds()).toEqual(['message.status']);
  });
});
