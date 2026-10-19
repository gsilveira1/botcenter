import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { getLogger } from '../logging/logger';
import type { InstancesJob } from '../queues/queue-names';
import { QueuesService } from '../queues/queues.service';
import { WorkerFactory } from '../queues/worker.factory';
import { AlertService } from '../services/alert.service';
import { ConnectionMonitorService } from './connection-monitor.service';
import type { IncidentCheckResult, ReconcileResult } from './connection-monitor.service';

/** The job schedulers of the `instances` queue: a job id has no `:` (BullMQ rule). */
export const INSTANCES_SCHEDULES = [
  { id: 'instances-monitor-connections', every: 60_000, task: 'monitor-connections' },
  { id: 'instances-reconcile-connections', every: 5 * 60_000, task: 'reconcile-connections' },
] as const satisfies readonly { id: string; every: number; task: InstancesJob['task'] }[];

/**
 * The consumer of the `instances` queue (worker process). At start, it writes the job schedulers (an
 * idempotent upsert: each worker process writes the same schedulers). BullMQ gives each scheduled job
 * to one worker only.
 */
@Injectable()
export class InstancesJobsWorker implements OnApplicationBootstrap {
  private readonly logger = getLogger('instances-jobs');

  constructor(
    private readonly workers: WorkerFactory,
    private readonly queues: QueuesService,
    private readonly monitor: ConnectionMonitorService,
    private readonly alerts: AlertService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.workers.create('instances', (job) => this.process(job));
    await this.schedule();
  }

  async process(job: Job<InstancesJob>): Promise<IncidentCheckResult | ReconcileResult> {
    switch (job.data.task) {
      case 'monitor-connections':
        return this.monitor.checkIncidents();
      case 'reconcile-connections':
        return this.monitor.reconcile();
    }
  }

  /** A failure does not stop the worker: the schedulers of an earlier start stay in Redis. */
  private async schedule(): Promise<void> {
    const queue = this.queues.get('instances');
    try {
      for (const schedule of INSTANCES_SCHEDULES) {
        await queue.upsertJobScheduler(
          schedule.id,
          { every: schedule.every },
          { name: schedule.task, data: { task: schedule.task } },
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'instances job schedulers not written');
      await this.alerts.notify({
        severity: 'critical',
        title: 'Connection monitor not scheduled',
        details: { error: error instanceof Error ? error.name : 'unknown' },
        dedupeKey: 'instances:schedule',
      });
    }
  }
}
