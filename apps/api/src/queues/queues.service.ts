import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { DefaultJobOptions, Job, JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';
import { closeRedis, createRedisConnection } from '../redis/redis';
import { QUEUE_NAMES } from './queue-names';
import type { JobPayloads, QueueName } from './queue-names';

/**
 * Default options of each queue. A slice can override them for one job (`add(..., options)`).
 * Completed jobs stay 1 h (at most 1000), failed jobs stay 7 days for the operators.
 */
export const DEFAULT_JOB_OPTIONS: Record<QueueName, DefaultJobOptions> = {
  outbound: { attempts: 5, backoff: { type: 'exponential', delay: 2_000 } },
  inbound: { attempts: 5, backoff: { type: 'exponential', delay: 1_000 } },
  webhooks: { attempts: 1 },
  timers: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
  maintenance: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
  // A scheduler adds the next run after one minute: a retry is not necessary.
  instances: { attempts: 1 },
};

const RETENTION: DefaultJobOptions = {
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

/**
 * The BullMQ producers. A queue opens its Redis connection at the first use, so the API starts (and the
 * OpenAPI export runs) without Redis. Both processes use this service to add jobs; only the worker process
 * consumes them (`WorkerFactory`).
 */
@Injectable()
export class QueuesService implements OnApplicationShutdown {
  private readonly logger = getLogger('queues');
  private readonly queues = new Map<QueueName, Queue>();
  private connection: Redis | undefined;

  constructor(@Inject(ENV) private readonly env: AppEnv) {}

  get<N extends QueueName>(name: N): Queue<JobPayloads[N]> {
    let queue = this.queues.get(name);
    if (!queue) {
      this.connection ??= createRedisConnection(
        this.env.REDIS_URL,
        'queue',
        `${this.env.ROLE}-queues`,
      );
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: { ...RETENTION, ...DEFAULT_JOB_OPTIONS[name] },
      });
      queue.on('error', (error: Error) => {
        this.logger.error({ err: error, queue: name }, 'queue error');
      });
      this.queues.set(name, queue);
    }
    return queue as unknown as Queue<JobPayloads[N]>;
  }

  /** Adds one job. `jobId` makes the add idempotent: BullMQ ignores a second job with the same id. */
  async add<N extends QueueName>(
    name: N,
    jobName: string,
    payload: JobPayloads[N],
    options?: JobsOptions,
  ): Promise<Job<JobPayloads[N]>> {
    const queue = this.get(name) as unknown as Queue;
    return (await queue.add(jobName, payload, options)) as Job<JobPayloads[N]>;
  }

  names(): readonly QueueName[] {
    return QUEUE_NAMES;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.queues.values()].map(async (queue) => {
        try {
          await queue.close();
        } catch (error) {
          this.logger.warn({ err: error, queue: queue.name }, 'queue close failed');
        }
      }),
    );
    this.queues.clear();
    if (this.connection) {
      await closeRedis(this.connection);
      this.connection = undefined;
    }
  }
}
