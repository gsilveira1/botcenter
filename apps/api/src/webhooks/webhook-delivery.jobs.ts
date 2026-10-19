import { Injectable } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import { getLogger } from '../logging/logger';
import { QueuesService } from '../queues/queues.service';
import { AlertService } from '../services/alert.service';

/**
 * The two delivery tables of the `webhooks` queue: `webhook_deliveries` (job name `deliver`, job id
 * `wh-...`) and `bot_webhook_calls` (job name `bot-call`, job id `bc-...`). The job data has the same
 * shape (`WebhookJob`): `deliveryId` is the row id of the table.
 */
export type DeliveryKind = 'subscription' | 'bot_call';

export const DELIVERY_JOB_NAMES: Record<DeliveryKind, string> = {
  subscription: 'deliver',
  bot_call: 'bot-call',
};

const JOB_ID_PREFIXES: Record<DeliveryKind, string> = { subscription: 'wh', bot_call: 'bc' };

/** The part of a delivery row that a job needs. */
export interface DeliveryJobRef {
  id: string;
  tenantId: string;
  nextAttemptAt: Date | null;
}

/**
 * The processor throws only for an infrastructure error (PostgreSQL down). The queue then retries the
 * job. A failed HTTP attempt is not a job error: the processor stores it and adds the next job itself.
 */
const JOB_OPTIONS: JobsOptions = { attempts: 5, backoff: { type: 'exponential', delay: 5_000 } };

/**
 * The job id of one scheduled attempt: `wh-<deliveryId>-<nextAttemptAt in ms>` (`bc-` for a bot call).
 * It is deterministic, so the dispatcher, the retry, and the sweep cannot add the same attempt two times.
 * A new schedule (a retry, a redelivery, or a lease that ended) gives a new id. A BullMQ id cannot
 * contain `:`.
 */
export function deliveryJobId(ref: DeliveryJobRef, kind: DeliveryKind = 'subscription'): string {
  return `${JOB_ID_PREFIXES[kind]}-${ref.id}-${ref.nextAttemptAt?.getTime() ?? 0}`;
}

/** Adds the `webhooks` jobs of the deliveries and of the bot calls. Only the delivery services use it. */
@Injectable()
export class WebhookDeliveryJobs {
  private readonly logger = getLogger('webhooks');

  constructor(
    private readonly queues: QueuesService,
    private readonly alerts: AlertService,
  ) {}

  /**
   * Adds one job for each delivery, delayed to its `nextAttemptAt`. When Redis fails, the rows stay
   * `pending` or `failed` in PostgreSQL and the sweep (`sweep-webhook-deliveries`) adds the jobs later,
   * so this method logs and alerts but does not throw. Returns the number of jobs added.
   */
  async enqueue(
    refs: readonly DeliveryJobRef[],
    now = Date.now(),
    kind: DeliveryKind = 'subscription',
  ): Promise<number> {
    if (refs.length === 0) {
      return 0;
    }
    try {
      await this.queues.get('webhooks').addBulk(
        refs.map((ref) => ({
          name: DELIVERY_JOB_NAMES[kind],
          data: { tenantId: ref.tenantId, deliveryId: ref.id },
          opts: {
            ...JOB_OPTIONS,
            jobId: deliveryJobId(ref, kind),
            delay: Math.max(0, (ref.nextAttemptAt?.getTime() ?? now) - now),
          },
        })),
      );
      return refs.length;
    } catch (error) {
      // Any Redis or BullMQ error: the rows are safe in PostgreSQL and the sweep adds the jobs later.
      this.logger.error(
        { err: error, deliveries: refs.length, kind },
        'webhook jobs not added; the sweep adds them later',
      );
      await this.alerts.notify({
        severity: 'warning',
        title: 'Webhook jobs not added to the queue',
        details: { deliveries: refs.length, kind, error: (error as Error).name },
        dedupeKey: 'webhooks:enqueue',
      });
      return 0;
    }
  }

  /**
   * The sweep: makes sure that each overdue delivery has a live job. A job that is missing, or that
   * ended (completed or failed) without a new schedule, is added again. Returns the number of jobs added.
   */
  async ensure(
    refs: readonly DeliveryJobRef[],
    kind: DeliveryKind = 'subscription',
  ): Promise<number> {
    const queue = this.queues.get('webhooks');
    const checks = await Promise.all(
      refs.map(async (ref) => {
        const job = await queue.getJob(deliveryJobId(ref, kind));
        if (!job) {
          return ref;
        }
        const state = await job.getState();
        if (state !== 'completed' && state !== 'failed') {
          return null;
        }
        await job.remove();
        return ref;
      }),
    );
    return this.enqueue(
      checks.filter((ref): ref is DeliveryJobRef => ref !== null),
      Date.now(),
      kind,
    );
  }
}
