import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ExternalHttpClient } from '../external-http/external-http.client';
import type { WebhookSubscription } from '../generated/prisma/client';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { ExternalHttpError } from '../ports/external-http.port';
import { PrismaService } from '../prisma/prisma.service';
import type { WebhookJob } from '../queues/queue-names';
import { WorkerFactory } from '../queues/worker.factory';
import { AlertService } from '../services/alert.service';
import { SecretBoxError } from '../services/secret-box';
import {
  DELIVERY_MAX_RESPONSE_BYTES,
  WEBHOOK_DELETED_ERROR,
  WEBHOOK_DELIVERY_SETTINGS,
  afterAttempt,
  buildSignedRequest,
  resultOfStatus,
} from './webhook-delivery.policy';
import type {
  AttemptResult,
  DeliveryUpdate,
  WebhookDeliverySettings,
} from './webhook-delivery.policy';
import { WebhookDeliveryJobs } from './webhook-delivery.jobs';
import { WebhookSecrets } from './webhook-secrets';

/**
 * A claimed attempt holds the row for this time (`nextAttemptAt` moves forward). When the worker stops
 * during the call, the lease ends and the sweep adds a new job. It is longer than the request time limit.
 */
export const DELIVERY_LEASE_MS = 60_000;
/** A job can start a little before `nextAttemptAt` (clock difference between the processes). */
const CLOCK_TOLERANCE_MS = 1_000;

export type DeliveryOutcome = 'skipped' | 'stopped' | DeliveryUpdate['status'];

type ClaimedDelivery = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
};

/**
 * The consumer of the `webhooks` queue: one job is one attempt of one delivery. It claims the row with
 * a lease (an atomic update, so two jobs of the same delivery cannot send two times at once), signs the
 * envelope, and sends it through the external HTTP client (SSRF guard, time limit, no redirects).
 * A 2xx answer is `succeeded`; another answer or an error schedules the next retry, and the last failure
 * is `dead`. The `webhooks` queue has its own workers, so a slow receiver never blocks another queue.
 */
@Injectable()
export class WebhookDeliveryWorker implements OnApplicationBootstrap {
  private readonly logger = getLogger('webhooks');

  constructor(
    private readonly workers: WorkerFactory,
    private readonly prisma: PrismaService,
    private readonly http: ExternalHttpClient,
    private readonly secrets: WebhookSecrets,
    private readonly jobs: WebhookDeliveryJobs,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertService,
    @Inject(WEBHOOK_DELIVERY_SETTINGS) private readonly settings: WebhookDeliverySettings,
  ) {}

  onApplicationBootstrap(): void {
    this.workers.create('webhooks', (job: Job<WebhookJob>) => this.deliver(job.data));
  }

  async deliver(data: WebhookJob, now = new Date()): Promise<DeliveryOutcome> {
    const delivery = await this.claim(data, now);
    if (!delivery) {
      return 'skipped';
    }
    const subscription = await this.prisma
      .forTenant(data.tenantId)
      .webhookSubscription.findUnique({ where: { id: delivery.subscriptionId } });
    if (!subscription || subscription.deletedAt || !subscription.active) {
      await this.stop(delivery);
      return 'stopped';
    }
    const result = await this.attempt(delivery, subscription);
    const update = afterAttempt(delivery.attempts, result, new Date(), this.settings);
    await this.prisma.forTenant(data.tenantId).webhookDelivery.update({
      where: { id: delivery.id },
      data: { ...update, leaseExpiresAt: null },
    });
    this.metrics.webhookDeliveriesTotal.inc({ result: update.status });
    this.logOutcome(delivery, update);
    if (update.status === 'failed') {
      await this.jobs.enqueue([{ ...delivery, nextAttemptAt: update.nextAttemptAt }]);
    }
    return update.status;
  }

  /** Takes the lease of a due delivery. Returns `null` when the job is stale or another job has it. */
  private async claim(data: WebhookJob, now: Date): Promise<ClaimedDelivery | null> {
    const [claimed] = await this.prisma
      .forTenant(data.tenantId)
      .webhookDelivery.updateManyAndReturn({
        where: {
          id: data.deliveryId,
          status: { in: ['pending', 'failed'] },
          nextAttemptAt: { lte: new Date(now.getTime() + CLOCK_TOLERANCE_MS) },
        },
        data: {
          nextAttemptAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
          leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        },
        select: {
          id: true,
          tenantId: true,
          subscriptionId: true,
          eventType: true,
          payload: true,
          attempts: true,
        },
      });
    return claimed ?? null;
  }

  private async attempt(
    delivery: ClaimedDelivery,
    subscription: WebhookSubscription,
  ): Promise<AttemptResult> {
    const secrets = await this.loadSecrets(delivery, subscription);
    if (!secrets) {
      return { ok: false, statusCode: null, error: 'secret_unavailable' };
    }
    const request = buildSignedRequest(
      delivery.payload as { id: string },
      secrets,
      Math.floor(Date.now() / 1000),
    );
    try {
      const response = await this.http.send({
        url: subscription.url,
        body: request.body,
        headers: request.headers,
        timeoutMs: this.settings.requestTimeoutMs,
        discardLargeBody: true,
        maxResponseBytes: DELIVERY_MAX_RESPONSE_BYTES,
      });
      return resultOfStatus(response.status);
    } catch (error) {
      if (error instanceof ExternalHttpError) {
        return { ok: false, statusCode: null, error: error.code };
      }
      throw error;
    }
  }

  /**
   * The signing secrets, or `null` when a secret does not decrypt (a wrong `DATA_ENCRYPTION_KEY`). The
   * attempt then fails with a retry, and the operators get an alert.
   */
  private async loadSecrets(
    delivery: ClaimedDelivery,
    subscription: WebhookSubscription,
  ): Promise<string[] | null> {
    try {
      return this.secrets.signingSecrets(subscription);
    } catch (error) {
      if (!(error instanceof SecretBoxError)) {
        throw error;
      }
      this.logger.error(
        { err: error, delivery_id: delivery.id, webhook_id: subscription.id },
        'webhook secret does not decrypt; check DATA_ENCRYPTION_KEY',
      );
      await this.alerts.notify({
        severity: 'critical',
        title: 'Webhook secret does not decrypt',
        details: { webhook_id: subscription.id },
        dedupeKey: 'webhooks:secret',
      });
      return null;
    }
  }

  /** The client deleted the webhook: the delivery ends without a request. */
  private async stop(delivery: ClaimedDelivery): Promise<void> {
    await this.prisma.forTenant(delivery.tenantId).webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'dead',
        nextAttemptAt: null,
        leaseExpiresAt: null,
        lastError: WEBHOOK_DELETED_ERROR,
      },
    });
    this.logger.info(
      { delivery_id: delivery.id },
      'webhook delivery stopped: the webhook is deleted',
    );
  }

  private logOutcome(delivery: ClaimedDelivery, update: DeliveryUpdate): void {
    const fields = {
      delivery_id: delivery.id,
      webhook_id: delivery.subscriptionId,
      event_type: delivery.eventType,
      attempts: update.attempts,
      status_code: update.lastStatusCode,
      error: update.lastError,
      next_attempt_at: update.nextAttemptAt?.toISOString() ?? null,
    };
    if (update.status === 'succeeded') {
      this.logger.info(fields, 'webhook delivered');
    } else if (update.status === 'dead') {
      this.logger.warn(fields, 'webhook delivery dead after the last attempt');
    } else {
      this.logger.info(fields, 'webhook attempt failed; retry scheduled');
    }
  }
}
