import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Counter } from 'prom-client';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import type { MaintenanceJob } from '../queues/queue-names';
import { QueuesService } from '../queues/queues.service';
import { UnrecoverableError, WorkerFactory } from '../queues/worker.factory';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import type { MaintenanceTaskResult } from './maintenance-task.registry';

/**
 * The consumer of the `maintenance` queue and the owner of its job schedulers (one scheduler for each
 * registered task; the scheduler id is the task name). At start it also removes the schedulers of tasks
 * that no longer exist. A failed run retries with the queue backoff (3 attempts); the last failure goes
 * to `AlertService` through `WorkerFactory` (one alert for each task in the dedupe window).
 */
@Injectable()
export class MaintenanceWorker implements OnApplicationBootstrap {
  private readonly logger = getLogger('maintenance');
  private readonly runs: Counter<'task' | 'result'>;

  constructor(
    private readonly workers: WorkerFactory,
    private readonly queues: QueuesService,
    private readonly registry: MaintenanceTaskRegistry,
    metrics: MetricsService,
  ) {
    this.runs = metrics.counter({
      name: 'botcenter_maintenance_runs_total',
      help: 'Runs of the maintenance tasks by result',
      labelNames: ['task', 'result'],
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    this.workers.create('maintenance', (job: Job<MaintenanceJob>) => this.process(job.data));
    await this.upsertSchedulers();
  }

  async process(data: MaintenanceJob, now = new Date()): Promise<MaintenanceTaskResult> {
    const task = this.registry.get(data.task);
    if (!task) {
      throw new UnrecoverableError(`Unknown maintenance task: ${data.task}`);
    }
    try {
      const result = await task.run(now);
      this.runs.inc({ task: task.name, result: 'completed' });
      this.logger.info({ task: task.name, ...result }, 'maintenance task completed');
      return result;
    } catch (error) {
      this.runs.inc({ task: task.name, result: 'failed' });
      throw error;
    }
  }

  private async upsertSchedulers(): Promise<void> {
    const queue = this.queues.get('maintenance');
    const tasks = this.registry.list();
    for (const task of tasks) {
      await queue.upsertJobScheduler(
        task.name,
        { every: task.everyMs },
        { name: task.name, data: { task: task.name } },
      );
    }
    const known = new Set<string>(tasks.map((task) => task.name));
    const schedulers = await queue.getJobSchedulers();
    for (const scheduler of schedulers) {
      if (!known.has(scheduler.key)) {
        await queue.removeJobScheduler(scheduler.key);
        this.logger.info({ scheduler: scheduler.key }, 'stale maintenance scheduler removed');
      }
    }
    this.logger.info({ tasks: tasks.map((task) => task.name) }, 'maintenance schedulers ready');
  }
}
