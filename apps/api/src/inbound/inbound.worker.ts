import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { ProviderEvent } from '@botcenter/whatsapp-provider';
import type { Job } from 'bullmq';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { AlertService } from '../services/alert.service';
import type { InboundJob, InboundSweepJob } from '../queues/queue-names';
import { DEFAULT_JOB_OPTIONS, QueuesService } from '../queues/queues.service';
import { UnrecoverableError, WorkerFactory } from '../queues/worker.factory';
import { InboundHandlerRegistry } from './inbound-handler.registry';

/** The job name and the scheduler id of the repair job of the inbound path (ARCH-01). */
export const INBOUND_SWEEP_JOB = 'sweep-inbound';
export const INBOUND_SWEEP_SCHEDULER = 'sweep-inbound';
export const INBOUND_SWEEP_EVERY_MS = 60_000;

export function reviveEvent(serialized: InboundJob['event']): ProviderEvent {
  return { ...serialized, occurredAt: new Date(serialized.occurredAt) } as ProviderEvent;
}

function isSweep(job: Job<InboundJob | InboundSweepJob>): job is Job<InboundSweepJob> {
  return job.name === INBOUND_SWEEP_JOB;
}

/**
 * The consumer of the `inbound` queue. It sends each event to the handler of its kind. An event without a
 * handler is logged at `warn`, counted (`botcenter_inbound_events_total{result="unhandled"}`), and the job
 * ends. The order of the events of one conversation is the work of the handler (lock per conversation).
 *
 * No lost event (ARCH-01): an event job retries for about 34 minutes (`DEFAULT_JOB_OPTIONS.inbound`). The
 * `sweep-inbound` job (a job scheduler in this queue, every minute) runs the repair tasks of the other
 * slices. An event job that fails its last attempt is counted
 * (`botcenter_inbound_events_total{result="failed"}`) and logged with its `raw_events` row, so an
 * operator can replay it. The alert rule reads `botcenter_queue_size{queue="inbound",state="failed"}`.
 */
@Injectable()
export class InboundWorker implements OnApplicationBootstrap {
  private readonly logger = getLogger('inbound-worker');

  constructor(
    private readonly workers: WorkerFactory,
    private readonly registry: InboundHandlerRegistry,
    private readonly metrics: MetricsService,
    private readonly queues: QueuesService,
    private readonly alerts: AlertService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Bootstrap runs after every `onModuleInit`, so all the handlers are registered here.
    this.logger.info(
      { kinds: this.registry.kinds(), sweeps: this.registry.sweeps().map((task) => task.name) },
      'inbound handlers registered',
    );
    const worker = this.workers.create('inbound', (job) => this.process(job));
    worker.on('failed', (job: Job | undefined, error: Error) => this.onFailed(job, error));
    await this.scheduleSweep();
  }

  async process(job: Job<InboundJob | InboundSweepJob>): Promise<unknown> {
    if (isSweep(job)) {
      return this.sweep(new Date());
    }
    const data = job.data as InboundJob;
    const event = reviveEvent(data.event);
    const handler = this.registry.get(event.kind);
    if (!handler) {
      this.logger.warn(
        { kind: event.kind },
        'no inbound handler for this event kind; the job ends',
      );
      this.metrics.inboundEventsTotal.inc({ result: 'unhandled' });
      return { handled: false };
    }
    await handler.handle(event as never, {
      jobId: job.id ?? '',
      attemptsMade: job.attemptsMade,
      rawEventId: data.rawEventId,
      receivedAt: new Date(data.receivedAt),
    });
    return { handled: true };
  }

  /** Runs every task. A failed task does not stop the others; the job fails after the last task. */
  private async sweep(now: Date): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    const failed: string[] = [];
    for (const task of this.registry.sweeps()) {
      try {
        results[task.name] = await task.run(now);
      } catch (error) {
        failed.push(task.name);
        this.logger.error({ err: error, task: task.name }, 'inbound sweep task failed');
      }
    }
    if (failed.length > 0) {
      throw new Error(`Inbound sweep tasks failed: ${failed.join(', ')}`);
    }
    return results;
  }

  /** The hook of the alert rule: count each event job that failed its last attempt. */
  private onFailed(job: Job | undefined, error: Error): void {
    if (!job || job.name === INBOUND_SWEEP_JOB) {
      return;
    }
    const attempts = job.opts.attempts ?? DEFAULT_JOB_OPTIONS.inbound.attempts ?? 1;
    if (!(error instanceof UnrecoverableError) && job.attemptsMade < attempts) {
      return;
    }
    this.metrics.inboundEventsTotal.inc({ result: 'failed' });
    const data = job.data as Partial<InboundJob>;
    this.logger.error(
      {
        err: error,
        job_id: job.id,
        kind: job.name,
        raw_event_id: data.rawEventId ?? null,
        attempts: job.attemptsMade,
      },
      'inbound event failed after its last attempt; replay its raw event',
    );
  }

  /** Idempotent: every worker process upserts the same scheduler. */
  private async scheduleSweep(): Promise<void> {
    try {
      await this.queues
        .get('inbound')
        .upsertJobScheduler(
          INBOUND_SWEEP_SCHEDULER,
          { every: INBOUND_SWEEP_EVERY_MS },
          { name: INBOUND_SWEEP_JOB, data: { task: 'sweep-inbound' }, opts: { attempts: 1 } },
        );
    } catch (error) {
      // The worker still processes the events; only the repair of lost work stops.
      this.logger.error(
        { err: error },
        'inbound sweep not scheduled; lost inbound work is not repaired',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Inbound sweep not scheduled',
        dedupeKey: 'inbound:sweep-schedule',
      });
    }
  }
}
