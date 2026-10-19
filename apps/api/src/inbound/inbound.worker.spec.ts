import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import type { InboundJob } from '../queues/queue-names';
import { DEFAULT_JOB_OPTIONS } from '../queues/queues.service';
import type { QueuesService } from '../queues/queues.service';
import type { WorkerFactory } from '../queues/worker.factory';
import type { AlertService } from '../services/alert.service';
import { UnrecoverableError } from '../queues/worker.factory';
import { InboundHandlerRegistry } from './inbound-handler.registry';
import { INBOUND_SWEEP_JOB, INBOUND_SWEEP_SCHEDULER, InboundWorker } from './inbound.worker';

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
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const consumer = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
  };
  const workers = { create: vi.fn(() => consumer) };
  const queue = { upsertJobScheduler: vi.fn(async () => ({})) };
  const queues = { get: vi.fn(() => queue) };
  const metrics = new MetricsService(testEnv());
  return {
    worker: new InboundWorker(
      workers as unknown as WorkerFactory,
      registry,
      metrics,
      queues as unknown as QueuesService,
      { notify: vi.fn(async () => undefined) } as unknown as AlertService,
    ),
    registry,
    workers,
    metrics,
    queue,
    listeners,
  };
}

describe('InboundWorker', () => {
  it('starts the inbound consumer at bootstrap', async () => {
    const { worker, workers } = build();
    await worker.onApplicationBootstrap();
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

describe('InboundWorker: no lost inbound event (ARCH-01)', () => {
  it('gives an inbound job a retry budget of at least 30 minutes', () => {
    const { attempts, backoff } = DEFAULT_JOB_OPTIONS.inbound;
    expect(backoff).toMatchObject({ type: 'exponential' });
    const delay = (backoff as { delay: number }).delay;
    let total = 0;
    for (let retry = 1; retry < (attempts ?? 1); retry += 1) {
      total += delay * 2 ** (retry - 1);
    }
    expect(total).toBeGreaterThanOrEqual(30 * 60_000);
    // The first retries stay fast: a short restart of PostgreSQL ends in seconds.
    expect(delay).toBeLessThanOrEqual(2_000);
  });

  it('upserts the sweep-inbound job scheduler in the inbound queue at bootstrap', async () => {
    const { worker, queue } = build();
    await worker.onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      INBOUND_SWEEP_SCHEDULER,
      { every: 60_000 },
      {
        name: INBOUND_SWEEP_JOB,
        data: { task: 'sweep-inbound' },
        opts: { attempts: 1 },
      },
    );
  });

  it('runs every registered sweep task for a sweep job, also after one task failed', async () => {
    const { worker, registry } = build();
    const first = { name: 'first', run: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const second = { name: 'second', run: vi.fn(async () => ({ drained: 2 })) };
    registry.registerSweep(first);
    registry.registerSweep(second);
    const sweep = { name: INBOUND_SWEEP_JOB, data: { task: 'sweep-inbound' } } as unknown as Job;
    await expect(worker.process(sweep)).rejects.toThrow(/first/);
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second.run).toHaveBeenCalledTimes(1);
  });

  it('counts an inbound event that failed its last attempt (alert rule input)', async () => {
    const { worker, metrics, listeners } = build();
    await worker.onApplicationBootstrap();
    const failed = listeners.get('failed')!;
    failed(
      { ...job, name: 'connection.updated', attemptsMade: 3, opts: { attempts: 11 } },
      new Error('x'),
    );
    failed(
      { ...job, name: 'connection.updated', attemptsMade: 11, opts: { attempts: 11 } },
      new Error('x'),
    );
    failed(
      { ...job, name: 'connection.updated', attemptsMade: 1, opts: {} },
      new UnrecoverableError('y'),
    );
    failed(
      { name: INBOUND_SWEEP_JOB, attemptsMade: 1, opts: { attempts: 1 }, data: {} },
      new Error('z'),
    );
    expect((await metrics.inboundEventsTotal.get()).values).toEqual([
      { labels: { result: 'failed' }, value: 2 },
    ]);
  });
});
