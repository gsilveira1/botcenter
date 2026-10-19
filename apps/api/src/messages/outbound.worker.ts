import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { getLogger } from '../logging/logger';
import type { OutboundJob, OutboundSweepJob } from '../queues/queue-names';
import { QueuesService } from '../queues/queues.service';
import { WorkerFactory } from '../queues/worker.factory';
import { AlertService } from '../services/alert.service';
import {
  OUTBOUND_SWEEP_EVERY_MS,
  OUTBOUND_SWEEP_JOB,
  OUTBOUND_SWEEP_SCHEDULER,
} from './outbound-job';
import { OutboundSender } from './outbound-sender';
import { OutboundSweep } from './outbound-sweep';
import { outboundBackoff } from './retry-policy';

/**
 * The consumer of the `outbound` queue: `send` jobs go to `OutboundSender`, the repeatable `sweep` job
 * goes to `OutboundSweep`. The queue uses the custom backoff of `retry-policy.ts`.
 */
@Injectable()
export class OutboundWorker implements OnApplicationBootstrap {
  private readonly logger = getLogger('outbound-worker');

  constructor(
    private readonly workers: WorkerFactory,
    private readonly queues: QueuesService,
    private readonly sender: OutboundSender,
    private readonly sweep: OutboundSweep,
    private readonly alerts: AlertService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.workers.create('outbound', (job) => this.process(job), {
      worker: { settings: { backoffStrategy: outboundBackoff } },
    });
    await this.scheduleSweep();
  }

  process(job: Job<OutboundJob | OutboundSweepJob>): Promise<unknown> {
    if (job.name === OUTBOUND_SWEEP_JOB) {
      return this.sweep.run();
    }
    return this.sender.process(job as Job<OutboundJob>);
  }

  /** Idempotent: every worker process upserts the same scheduler. */
  private async scheduleSweep(): Promise<void> {
    try {
      await this.queues
        .get('outbound')
        .upsertJobScheduler(
          OUTBOUND_SWEEP_SCHEDULER,
          { every: OUTBOUND_SWEEP_EVERY_MS },
          { name: OUTBOUND_SWEEP_JOB, data: { task: 'sweep' } },
        );
    } catch (error) {
      this.logger.error(
        { err: error },
        'outbound sweep not scheduled; lost enqueues are not repaired',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Outbound sweep not scheduled',
        dedupeKey: 'outbound:sweep-schedule',
      });
    }
  }
}
