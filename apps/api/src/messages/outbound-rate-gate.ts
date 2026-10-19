import { Inject, Injectable } from '@nestjs/common';
import { DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import type { OutboundJob } from '../queues/queue-names';
import { InstanceLimitsCache } from './instance-limits.cache';
import type { InstanceRate } from './instance-limits.cache';
import { JOB_PRIORITY } from './outbound-job';
import { InstanceTokenBucket } from './token-bucket';
import { bucketLimits, warmUpFactor } from './warm-up';
import type { BucketLimits } from './warm-up';

/** The token of a send job: the limits that the job used, so that it can give the token back. */
export interface SendToken {
  instanceId: string;
  limits: BucketLimits;
}

/**
 * The send rate limit of each instance, before any read of the message row (ARCH-10):
 * 1. Read the rate of the instance from `InstanceLimitsCache` (one database read every 30 s).
 * 2. Take a token. A bulk job without a token gets its own place in the line of the bucket, so the jobs
 *    of a backlog wake one at a time. A reply waits only for the next token.
 * 3. Without a token, keep the ready time in the job data (`readyAt`, for the queue delay metric), move
 *    the job back to the delayed set, and throw `DelayedError` (not a failure, not an attempt).
 */
@Injectable()
export class OutboundRateGate {
  private readonly logger = getLogger('outbound-rate');

  constructor(
    private readonly bucket: InstanceTokenBucket,
    private readonly rates: InstanceLimitsCache,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  /** The bucket limits of an instance today (rate of the instance and warm-up). */
  limitsFor(rate: InstanceRate, now = new Date()): BucketLimits {
    const factor = warmUpFactor(rate.firstConnectedAt, now, {
      days: this.env.OUTBOUND_WARMUP_DAYS,
      startPercent: this.env.OUTBOUND_WARMUP_START_PERCENT,
    });
    return bucketLimits(rate.rateLimitPerMinute, this.env.OUTBOUND_BUCKET_BURST, factor);
  }

  /**
   * Takes a send token, or moves the job back to the delayed set and throws `DelayedError`.
   * Returns `null` for an unknown instance: the load of the message then ends the job.
   */
  async take(job: Job<OutboundJob>): Promise<SendToken | null> {
    const { tenantId, instanceId } = job.data;
    const rate = await this.rates.get(tenantId, instanceId);
    if (!rate) {
      return null;
    }
    const limits = this.limitsFor(rate);
    const spread = job.opts.priority !== JOB_PRIORITY.reply;
    const token = await this.bucket.take(instanceId, limits, { spread });
    if (token.allowed) {
      return { instanceId, limits };
    }
    this.metrics.rateLimitDeniedTotal.inc({ scope: 'instance' });
    this.logger.debug({ wait_ms: token.waitMs }, 'no send token; the job waits');
    const readyAt = Date.now() + token.waitMs;
    await keepReadyAt(job, readyAt);
    await job.moveToDelayed(readyAt, job.token);
    throw new DelayedError();
  }

  /** Gives back a token that the job did not use. Never throws: a lost token only slows the instance. */
  async refund(token: SendToken | null): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await this.bucket.refund(token.instanceId, token.limits);
    } catch (error) {
      this.logger.warn({ err: error }, 'send token not given back');
    }
  }
}

/**
 * Keeps the time when a waiting job is ready again in its data (`readyAt`). The queue delay metric reads
 * it, because BullMQ keeps the creation time of the job. A failure only makes the metric less exact.
 */
export async function keepReadyAt(
  job: Job<OutboundJob>,
  readyAt: number,
  extra: Partial<OutboundJob> = {},
): Promise<void> {
  try {
    await job.updateData({ ...job.data, ...extra, readyAt });
  } catch (error) {
    getLogger('outbound-rate').warn({ err: error }, 'ready time not kept in the job');
  }
}
