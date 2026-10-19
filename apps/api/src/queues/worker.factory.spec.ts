import { DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import type { AlertService } from '../services/alert.service';
import { RetryLaterError } from './retry-later';
import { WorkerFactory, isDelayedError } from './worker.factory';

type Run = (queue: string, job: Job, processor: (job: Job) => Promise<unknown>) => Promise<unknown>;

function build() {
  const metrics = new MetricsService(testEnv());
  const factory = new WorkerFactory(testEnv(), metrics, {} as AlertService);
  const run = (factory as unknown as { run: Run }).run.bind(factory);
  return { metrics, run };
}

async function count(metrics: MetricsService, result: string): Promise<number> {
  const values = (await metrics.jobsTotal.get()).values;
  return values.find((value) => value.labels['result'] === result)?.value ?? 0;
}

describe('WorkerFactory', () => {
  it('moves a job back to the delayed set on RetryLaterError, without a failed attempt', async () => {
    const { metrics, run } = build();
    const moveToDelayed = vi.fn(async () => undefined);
    const job = { id: 'j1', name: 'n', data: {}, attemptsMade: 0, token: 'tok', moveToDelayed };
    const before = Date.now();
    await expect(
      run('inbound', job as unknown as Job, async () => {
        throw new RetryLaterError(1_000, 'lock busy');
      }),
    ).rejects.toBeInstanceOf(DelayedError);
    const [timestamp, token] = moveToDelayed.mock.calls[0] as unknown as [number, string];
    expect(timestamp).toBeGreaterThanOrEqual(before + 1_000);
    expect(token).toBe('tok');
    expect(await count(metrics, 'delayed')).toBe(1);
    expect(await count(metrics, 'failed')).toBe(0);
  });

  it('counts a normal error as failed', async () => {
    const { metrics, run } = build();
    const job = { id: 'j2', name: 'n', data: {}, attemptsMade: 0 };
    await expect(
      run('inbound', job as unknown as Job, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count(metrics, 'failed')).toBe(1);
  });
});

describe('isDelayedError', () => {
  it('knows the BullMQ delay error by class and by name', () => {
    expect(isDelayedError(new DelayedError())).toBe(true);
    const copy = new Error('moved');
    copy.name = 'DelayedError';
    expect(isDelayedError(copy)).toBe(true);
    expect(isDelayedError(new Error('other'))).toBe(false);
    expect(isDelayedError(undefined)).toBe(false);
  });
});
