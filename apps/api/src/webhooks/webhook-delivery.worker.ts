import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Counter } from 'prom-client';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { EXTERNAL_HTTP, ExternalHttpError } from '../ports/external-http.port';
import type { ExternalHttpPort } from '../ports/external-http.port';
import { PrismaService } from '../prisma/prisma.service';
import type { WebhookJob } from '../queues/queue-names';
import { UnrecoverableError, WorkerFactory } from '../queues/worker.factory';
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
import { DELIVERY_JOB_NAMES, WebhookDeliveryJobs } from './webhook-delivery.jobs';
import type { DeliveryKind } from './webhook-delivery.jobs';
import { WebhookSecrets } from './webhook-secrets';
import type { SubscriptionSecretColumns } from './webhook-secrets';

/**
 * A claimed attempt holds the row for this time (`nextAttemptAt` and `leaseExpiresAt` move forward). When
 * the worker stops during the call, the lease ends and the sweep adds a new job. It is longer than the
 * request time limit.
 */
export const DELIVERY_LEASE_MS = 60_000;
/** A job can start a little before `nextAttemptAt` (clock difference between the processes). */
const CLOCK_TOLERANCE_MS = 1_000;
/** `lastError` of a bot call when the bot has no signing secret (a bot of an older version). */
export const BOT_SECRET_MISSING_ERROR = 'bot_secret_missing';

export type DeliveryOutcome = 'skipped' | 'stopped' | DeliveryUpdate['status'];

/** The columns of a claimed row that the runner needs (both tables). */
interface ClaimedRow {
  id: string;
  tenantId: string;
  attempts: number;
  payload: unknown;
}

/** The request of one attempt. `secrets: null` means that the secret is not available. */
interface SignedTarget {
  url: string;
  secrets: string[] | null;
  /** The `lastError` when the secret is not available. */
  missingSecretError: string;
}

/**
 * One delivery table. The runner owns the lease, the signature, the HTTP call, the retry schedule, and the
 * dead state; a source only reads and writes its rows.
 */
interface DeliverySource<Row extends ClaimedRow> {
  readonly kind: DeliveryKind;
  readonly results: Counter<'result'>;
  claim(job: WebhookJob, dueBefore: Date, lease: Date): Promise<Row | null>;
  /** The request of the attempt, or `null` when the owner is gone (the row stops without a request). */
  target(row: Row): Promise<SignedTarget | null>;
  save(row: Row, update: DeliveryUpdate): Promise<void>;
  stop(row: Row): Promise<void>;
  /** The `Webhook-Id` header: the event id of a delivery, or the row id of a bot call. */
  webhookId(row: Row): string;
  /** Log fields of the row (ids only, never the payload). */
  fields(row: Row): Record<string, unknown>;
  /** Called after the last failed attempt. */
  onDead(row: Row, update: DeliveryUpdate): Promise<void>;
}

const LEASE_FREE = { leaseExpiresAt: null } as const;

/**
 * The consumer of the `webhooks` queue: one job is one attempt of one row of `webhook_deliveries` (job
 * name `deliver`) or of `bot_webhook_calls` (job name `bot-call`, ARCH-04). It claims the row with a lease
 * (an atomic update, so two jobs of the same row cannot send two times at once), signs the body, and
 * sends it through the external HTTP port (SSRF guard, time limit, no redirects). A 2xx answer is
 * `succeeded`; another answer or an error schedules the next retry, and the last failure is `dead`. The
 * `webhooks` queue has its own workers, so a slow receiver never blocks another queue.
 */
@Injectable()
export class WebhookDeliveryWorker implements OnApplicationBootstrap {
  private readonly logger = getLogger('webhooks');
  private readonly subscriptions: DeliverySource<
    ClaimedRow & { subscriptionId: string; eventId: string; eventType: string }
  >;
  private readonly botCalls: DeliverySource<
    ClaimedRow & { botId: string; conversationId: string; url: string }
  >;

  constructor(
    private readonly workers: WorkerFactory,
    private readonly prisma: PrismaService,
    @Inject(EXTERNAL_HTTP) private readonly http: ExternalHttpPort,
    private readonly secrets: WebhookSecrets,
    private readonly jobs: WebhookDeliveryJobs,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertService,
    @Inject(WEBHOOK_DELIVERY_SETTINGS) private readonly settings: WebhookDeliverySettings,
  ) {
    this.subscriptions = this.subscriptionSource();
    this.botCalls = this.botCallSource();
  }

  onApplicationBootstrap(): void {
    this.workers.create('webhooks', (job: Job<WebhookJob>) => {
      if (job.name === DELIVERY_JOB_NAMES.bot_call) {
        return this.deliverBotCall(job.data);
      }
      if (job.name === DELIVERY_JOB_NAMES.subscription) {
        return this.deliver(job.data);
      }
      throw new UnrecoverableError(`Unknown webhooks job: ${job.name}`);
    });
  }

  /** One attempt of a webhook delivery (an event to a webhook of the tenant). */
  deliver(data: WebhookJob, now = new Date()): Promise<DeliveryOutcome> {
    return this.run(this.subscriptions, data, now);
  }

  /** One attempt of a bot `call_webhook` action (ARCH-04). */
  deliverBotCall(data: WebhookJob, now = new Date()): Promise<DeliveryOutcome> {
    return this.run(this.botCalls, data, now);
  }

  private async run<Row extends ClaimedRow>(
    source: DeliverySource<Row>,
    data: WebhookJob,
    now: Date,
  ): Promise<DeliveryOutcome> {
    const row = await source.claim(
      data,
      new Date(now.getTime() + CLOCK_TOLERANCE_MS),
      new Date(now.getTime() + DELIVERY_LEASE_MS),
    );
    if (!row) {
      return 'skipped';
    }
    const target = await source.target(row);
    if (!target) {
      await source.stop(row);
      this.logger.info(
        { ...source.fields(row), kind: source.kind },
        'webhook delivery stopped: the owner is deleted',
      );
      return 'stopped';
    }
    const result = await this.attempt(row, source.webhookId(row), target);
    const update = afterAttempt(row.attempts, result, new Date(), this.settings);
    await source.save(row, update);
    source.results.inc({ result: update.status });
    this.logOutcome(source, row, update);
    if (update.status === 'failed') {
      await this.jobs.enqueue(
        [{ id: row.id, tenantId: row.tenantId, nextAttemptAt: update.nextAttemptAt }],
        Date.now(),
        source.kind,
      );
    }
    if (update.status === 'dead') {
      await source.onDead(row, update);
    }
    return update.status;
  }

  private async attempt(
    row: ClaimedRow,
    webhookId: string,
    target: SignedTarget,
  ): Promise<AttemptResult> {
    if (!target.secrets) {
      return { ok: false, statusCode: null, error: target.missingSecretError };
    }
    const request = buildSignedRequest(
      webhookId,
      row.payload,
      target.secrets,
      Math.floor(Date.now() / 1000),
    );
    try {
      // The client sends `JSON.stringify(payload)`: the same bytes that the signature covers.
      const response = await this.http.postJson({
        url: target.url,
        body: row.payload ?? null,
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
    owner: SubscriptionSecretColumns,
    fields: Record<string, string>,
  ): Promise<string[] | null> {
    try {
      return this.secrets.signingSecrets(owner);
    } catch (error) {
      if (!(error instanceof SecretBoxError)) {
        throw error;
      }
      this.logger.error(
        { err: error, ...fields },
        'signing secret does not decrypt; check DATA_ENCRYPTION_KEY',
      );
      await this.alerts.notify({
        severity: 'critical',
        title: 'Webhook signing secret does not decrypt',
        details: fields,
        dedupeKey: 'webhooks:secret',
      });
      return null;
    }
  }

  private logOutcome<Row extends ClaimedRow>(
    source: DeliverySource<Row>,
    row: Row,
    update: DeliveryUpdate,
  ): void {
    const fields = {
      ...source.fields(row),
      kind: source.kind,
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

  /** `webhook_deliveries`: the events of the outbox to the webhooks of a tenant. */
  private subscriptionSource(): DeliverySource<
    ClaimedRow & { subscriptionId: string; eventId: string; eventType: string }
  > {
    return {
      kind: 'subscription',
      results: this.metrics.webhookDeliveriesTotal,
      claim: async (job, dueBefore, lease) => {
        const [claimed] = await this.prisma
          .forTenant(job.tenantId)
          .webhookDelivery.updateManyAndReturn({
            where: {
              id: job.deliveryId,
              status: { in: ['pending', 'failed'] },
              nextAttemptAt: { lte: dueBefore },
            },
            data: { nextAttemptAt: lease, leaseExpiresAt: lease },
            select: {
              id: true,
              tenantId: true,
              subscriptionId: true,
              eventId: true,
              eventType: true,
              payload: true,
              attempts: true,
            },
          });
        return claimed ?? null;
      },
      target: async (row) => {
        const subscription = await this.prisma
          .forTenant(row.tenantId)
          .webhookSubscription.findUnique({ where: { id: row.subscriptionId } });
        if (!subscription || subscription.deletedAt || !subscription.active) {
          return null;
        }
        return {
          url: subscription.url,
          secrets: await this.loadSecrets(subscription, { webhook_id: subscription.id }),
          missingSecretError: 'secret_unavailable',
        };
      },
      save: async (row, update) => {
        await this.prisma.forTenant(row.tenantId).webhookDelivery.update({
          where: { id: row.id },
          data: { ...update, ...LEASE_FREE },
        });
      },
      stop: async (row) => {
        await this.prisma.forTenant(row.tenantId).webhookDelivery.update({
          where: { id: row.id },
          data: {
            status: 'dead',
            nextAttemptAt: null,
            ...LEASE_FREE,
            lastError: WEBHOOK_DELETED_ERROR,
          },
        });
      },
      webhookId: (row) => row.eventId,
      fields: (row) => ({
        delivery_id: row.id,
        webhook_id: row.subscriptionId,
        event_type: row.eventType,
      }),
      // `check-alerts` watches the dead deliveries of each tenant.
      onDead: async () => undefined,
    };
  }

  /** `bot_webhook_calls`: the `call_webhook` actions of the bots, signed with the secret of the bot. */
  private botCallSource(): DeliverySource<
    ClaimedRow & { botId: string; conversationId: string; url: string }
  > {
    return {
      kind: 'bot_call',
      results: this.metrics.counter({
        name: 'botcenter_bot_webhook_calls_total',
        help: 'call_webhook actions of the bots by result',
        labelNames: ['result'],
      }),
      claim: async (job, dueBefore, lease) => {
        const [claimed] = await this.prisma
          .forTenant(job.tenantId)
          .botWebhookCall.updateManyAndReturn({
            where: {
              id: job.deliveryId,
              status: { in: ['pending', 'failed'] },
              nextAttemptAt: { lte: dueBefore },
            },
            data: { nextAttemptAt: lease, leaseExpiresAt: lease },
            select: {
              id: true,
              tenantId: true,
              botId: true,
              conversationId: true,
              url: true,
              payload: true,
              attempts: true,
            },
          });
        return claimed ?? null;
      },
      target: async (row) => {
        const bot = await this.prisma.forTenant(row.tenantId).bot.findUnique({
          where: { id: row.botId },
          select: {
            id: true,
            secretEncrypted: true,
            previousSecretEncrypted: true,
            previousSecretExpiresAt: true,
          },
        });
        if (!bot) {
          return null;
        }
        const { secretEncrypted } = bot;
        return {
          url: row.url,
          secrets: secretEncrypted
            ? await this.loadSecrets({ ...bot, secretEncrypted }, { bot_id: bot.id })
            : null,
          missingSecretError: secretEncrypted ? 'secret_unavailable' : BOT_SECRET_MISSING_ERROR,
        };
      },
      save: async (row, update) => {
        await this.prisma.forTenant(row.tenantId).botWebhookCall.update({
          where: { id: row.id },
          data: { ...update, ...LEASE_FREE },
        });
      },
      stop: async (row) => {
        await this.prisma.forTenant(row.tenantId).botWebhookCall.update({
          where: { id: row.id },
          data: { status: 'dead', nextAttemptAt: null, ...LEASE_FREE, lastError: 'bot_deleted' },
        });
      },
      webhookId: (row) => row.id,
      fields: (row) => ({
        bot_call_id: row.id,
        bot_id: row.botId,
        conversation_id: row.conversationId,
      }),
      onDead: async (row, update) => {
        await this.alerts.notify({
          severity: 'warning',
          title: 'Bot call_webhook action failed after the last attempt',
          details: {
            tenant_id: row.tenantId,
            bot_id: row.botId,
            reason: update.lastError,
            status_code: update.lastStatusCode,
          },
          dedupeKey: `bot-webhook:${row.tenantId}:${row.botId}`,
        });
      },
    };
  }
}
