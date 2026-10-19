import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from './queues.service';

const SIZE_STATES = ['waiting', 'active', 'delayed', 'failed', 'prioritized'] as const;
const INSTANCE_STATUSES = [
  'created',
  'connecting',
  'connected',
  'disconnected',
  'logged_out',
] as const;

/**
 * The age in seconds of the oldest job that waits for a worker (`waiting` and `prioritized`). A delayed
 * job is ready at timestamp + delay. The operational alerts use the same value as the gauge.
 */
export async function oldestWaitingDelaySeconds(queue: Queue, now = Date.now()): Promise<number> {
  // The first job of each list in ascending order.
  const firstJobs = await queue.getJobs(['waiting', 'prioritized'], 0, 0, true);
  const readyAt = Math.min(now, ...firstJobs.map((job) => job.timestamp + (job.opts.delay ?? 0)));
  return Math.max(0, (now - readyAt) / 1000);
}

/**
 * Sets the gauges that come from shared state (queue sizes and delays in Redis, instances by status in
 * PostgreSQL) at each scrape. Only the API process registers it, so the values are not counted two times.
 */
@Injectable()
export class SharedStateMetricsCollector implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly queues: QueuesService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.metrics.addCollector(() => this.collectQueues());
    this.metrics.addCollector(() => this.collectInstances());
  }

  async collectQueues(now = Date.now()): Promise<void> {
    await Promise.all(
      this.queues.names().map(async (name) => {
        const queue = this.queues.get(name);
        const counts = await queue.getJobCounts(...SIZE_STATES);
        for (const state of SIZE_STATES) {
          this.metrics.queueSize.set({ queue: name, state }, counts[state] ?? 0);
        }
        this.metrics.queueDelay.set({ queue: name }, await oldestWaitingDelaySeconds(queue, now));
      }),
    );
  }

  async collectInstances(): Promise<void> {
    const groups = await this.prisma.instance.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    for (const status of INSTANCE_STATUSES) {
      const group = groups.find((item) => item.status === status);
      this.metrics.instances.set({ status }, group?._count._all ?? 0);
    }
  }
}
