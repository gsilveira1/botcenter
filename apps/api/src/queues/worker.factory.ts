import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { UnrecoverableError, Worker } from 'bullmq';
import type { Job, WorkerOptions } from 'bullmq';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { runWithLogContext } from '../logging/log-context';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { closeRedis, createRedisConnection } from '../redis/redis';
import { AlertService } from '../services/alert.service';
import { CONCURRENCY_ENV } from './queue-names';
import { DEFAULT_JOB_OPTIONS } from './queues.service';
import type { JobPayloads, QueueName } from './queue-names';

export { UnrecoverableError };

/** The function that processes one job. Throw to retry (with backoff); throw `UnrecoverableError` to fail at once. */
export type JobProcessor<N extends QueueName> = (job: Job<JobPayloads[N]>) => Promise<unknown>;

export interface CreateWorkerOptions {
  /** Default: the `WORKER_CONCURRENCY_<QUEUE>` environment variable. */
  concurrency?: number;
  /** Extra BullMQ options (for example `limiter`). */
  worker?: Omit<WorkerOptions, 'connection' | 'concurrency' | 'autorun'>;
}

/**
 * Creates the BullMQ consumers of the worker process. Each job runs with a log context
 * (`queue`, `job_id`, and `tenant_id` / `instance_id` when the payload has them), a duration metric, and a
 * result counter. A job that fails its last attempt is logged at `error` and goes to `AlertService`.
 * `onModuleDestroy` closes the workers: BullMQ waits for the current jobs and leaves the other jobs in
 * the queue (graceful shutdown).
 *
 * Use it only in the worker process (in a provider of a `*WorkerModule`, in `onApplicationBootstrap`).
 */
@Injectable()
export class WorkerFactory implements OnModuleDestroy {
  private readonly logger = getLogger('workers');
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertService,
  ) {}

  create<N extends QueueName>(
    queue: N,
    processor: JobProcessor<N>,
    options: CreateWorkerOptions = {},
  ): Worker {
    const concurrency =
      options.concurrency ?? (this.env[CONCURRENCY_ENV[queue] as keyof AppEnv] as number);
    const connection = createRedisConnection(this.env.REDIS_URL, 'worker', `worker-${queue}`);
    const worker = new Worker<JobPayloads[N]>(queue, (job) => this.run(queue, job, processor), {
      ...options.worker,
      connection,
      concurrency,
      autorun: true,
    });
    worker.on('error', (error: Error) => {
      this.logger.error({ err: error, queue }, 'worker error');
    });
    worker.on('failed', (job, error) => {
      void this.onFailed(queue, job, error);
    });
    worker.on('closed', () => {
      void closeRedis(connection);
    });
    this.workers.push(worker);
    this.logger.info({ queue, concurrency }, 'worker started');
    return worker;
  }

  async onModuleDestroy(): Promise<void> {
    const workers = this.workers.splice(0);
    await Promise.all(
      workers.map(async (worker) => {
        try {
          await worker.close();
          this.logger.info({ queue: worker.name }, 'worker stopped');
        } catch (error) {
          this.logger.error({ err: error, queue: worker.name }, 'worker close failed');
        }
      }),
    );
  }

  private async run<N extends QueueName>(
    queue: N,
    job: Job<JobPayloads[N]>,
    processor: JobProcessor<N>,
  ): Promise<unknown> {
    const data = job.data as unknown as Record<string, unknown>;
    const context = {
      queue,
      job_id: job.id,
      tenant_id: typeof data['tenantId'] === 'string' ? data['tenantId'] : undefined,
      instance_id: typeof data['instanceId'] === 'string' ? data['instanceId'] : undefined,
    };
    return runWithLogContext(context, async () => {
      const stop = this.metrics.jobDuration.startTimer({ queue });
      try {
        const result = await processor(job);
        this.metrics.jobsTotal.inc({ queue, result: 'completed' });
        return result;
      } catch (error) {
        this.metrics.jobsTotal.inc({ queue, result: 'failed' });
        this.logger.warn(
          { err: error, attempt: job.attemptsMade + 1, job_name: job.name },
          'job attempt failed',
        );
        throw error;
      } finally {
        stop();
      }
    });
  }

  private async onFailed<N extends QueueName>(
    queue: N,
    job: Job | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      this.logger.error({ err: error, queue }, 'job failed without job data');
      return;
    }
    const attempts = job.opts.attempts ?? DEFAULT_JOB_OPTIONS[queue].attempts ?? 1;
    const final = error instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!final) {
      return;
    }
    this.logger.error(
      { err: error, queue, job_id: job.id, job_name: job.name, attempts: job.attemptsMade },
      'job failed after its last attempt',
    );
    await this.alerts.notify({
      severity: 'warning',
      title: `Job failed in queue ${queue}`,
      details: { queue, job_name: job.name, job_id: job.id ?? null, error: error.name },
      dedupeKey: `job-failed:${queue}:${job.name}`,
    });
  }
}
