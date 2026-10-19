import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
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

/** Jobs read from the head of each list when the caller ignores some job names. */
const HEAD_JOBS = 20;

/**
 * The time when a waiting job became ready, or `null` when it is not known. A job that went back to the
 * delayed set keeps its ready time in `data.readyAt` (the send rate limit and the send order of the
 * `outbound` queue, ARCH-10), because BullMQ keeps the creation time and sets the delay to 0 at the
 * promotion. A retry after a failure has no known ready time, so it does not count.
 */
export function readyTime(job: Job): number | null {
  const readyAt = (job.data as { readyAt?: unknown } | undefined)?.readyAt;
  if (typeof readyAt === 'number') {
    return readyAt;
  }
  if ((job.attemptsMade ?? 0) > 0) {
    return null;
  }
  return job.timestamp + (job.opts.delay ?? 0);
}

/**
 * The age in seconds of the oldest job that waits for a worker (`waiting` and `prioritized`), from the
 * time when the job became ready (`readyTime`). The operational alerts use the same value as the gauge.
 * `ignoreNames` leaves out housekeeping jobs (for example the `sweep` job of the `outbound` queue).
 * Only the first jobs of each list are read.
 */
export async function oldestWaitingDelaySeconds(
  queue: Queue,
  now = Date.now(),
  ignoreNames: readonly string[] = [],
): Promise<number> {
  // The first jobs of each list in ascending order.
  const firstJobs = (
    await queue.getJobs(['waiting', 'prioritized'], 0, HEAD_JOBS - 1, true)
  ).filter((job) => !ignoreNames.includes(job.name));
  const readyTimes = firstJobs.map(readyTime).filter((time): time is number => time !== null);
  const readyAt = Math.min(now, ...readyTimes);
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
