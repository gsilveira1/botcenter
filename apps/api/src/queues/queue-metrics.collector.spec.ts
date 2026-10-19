import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SharedStateMetricsCollector } from './queue-metrics.collector';
import type { QueuesService } from './queues.service';

describe('SharedStateMetricsCollector', () => {
  it('sets the queue sizes, the age of the oldest ready job, and the instances by status', async () => {
    const metrics = new MetricsService(testEnv());
    const now = 1_000_000;
    const queue = {
      getJobCounts: vi.fn(async () => ({
        waiting: 3,
        active: 1,
        delayed: 2,
        failed: 0,
        prioritized: 1,
      })),
      getJobs: vi.fn(async () => [
        { timestamp: now - 40_000, opts: { delay: 10_000 } },
        { timestamp: now - 20_000, opts: {} },
      ]),
    };
    const queues = { names: () => ['outbound'], get: () => queue } as unknown as QueuesService;
    const prisma = {
      instance: { groupBy: vi.fn(async () => [{ status: 'connected', _count: { _all: 2 } }]) },
    } as unknown as PrismaService;
    const collector = new SharedStateMetricsCollector(metrics, queues, prisma);
    await collector.collectQueues(now);
    await collector.collectInstances();
    const text = await metrics.registry.metrics();
    expect(text).toContain('botcenter_queue_size{queue="outbound",state="waiting",role="api"} 3');
    expect(text).toContain('botcenter_queue_delay_seconds{queue="outbound",role="api"} 30');
    expect(text).toContain('botcenter_instances{status="connected",role="api"} 2');
    expect(text).toContain('botcenter_instances{status="logged_out",role="api"} 0');
  });
});
