import { Inject, Injectable } from '@nestjs/common';
import type { MessageContent, MessagePriority } from '@botcenter/contracts';
import { ProviderError } from '@botcenter/whatsapp-provider';
import type { OutboundContent, WhatsAppProvider } from '@botcenter/whatsapp-provider';
import type { Job } from 'bullmq';
import { getLogger } from '../logging/logger';
import { maskPhone } from '../logging/mask';
import { MediaUnavailableError } from '../media/media.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { WHATSAPP_PROVIDER } from '../provider/provider.tokens';
import type { OutboundJob } from '../queues/queue-names';
import { RetryLaterError } from '../queues/worker.factory';
import { AlertService } from '../services/alert.service';
import { MessageStatusWriter } from './message-status.writer';
import type { StatusTarget } from './message-status.writer';
import { OutboundMediaPreparer } from './outbound-media';
import { OutboundOrder, orderWaitMs } from './outbound-order';
import { OutboundRateGate, keepReadyAt } from './outbound-rate-gate';
import { RetryableSendError, decideRetry } from './retry-policy';
import type { OutboundFailureReason } from './retry-policy';

export type SendOutcome = 'sent' | 'failed' | 'skipped';

type DeliveryResult =
  { kind: 'sent'; providerMessageId: string } | { kind: 'failed'; reason: OutboundFailureReason };

const MESSAGE_SELECT = {
  id: true,
  tenantId: true,
  instanceId: true,
  status: true,
  contact: true,
  priority: true,
  seq: true,
  content: true,
  typingDelayMs: true,
  createdAt: true,
  instance: {
    select: {
      providerName: true,
      status: true,
      deletedAt: true,
      rateLimitPerMinute: true,
      firstConnectedAt: true,
      externalRef: true,
    },
  },
} as const;

export interface OutboundInstance {
  providerName: string;
  status: string;
  deletedAt: Date | null;
  rateLimitPerMinute: number;
  firstConnectedAt: Date | null;
  externalRef: string;
}

interface OutboundMessage {
  id: string;
  tenantId: string;
  instanceId: string;
  status: string;
  contact: string;
  priority: MessagePriority;
  seq: bigint;
  content: unknown;
  typingDelayMs: number | null;
  createdAt: Date;
  instance: OutboundInstance;
}

/** A send to this instance cannot work now and later: fail at once. */
export function blockedReason(instance: OutboundInstance): OutboundFailureReason | null {
  if (instance.deletedAt) {
    return 'instance_deleted';
  }
  if (instance.status === 'created' || instance.status === 'logged_out') {
    return 'instance_not_connected';
  }
  return null;
}

/** Failures after all the retries: the provider or the network has a problem, so the operators know. */
const ALERT_REASONS: ReadonlySet<OutboundFailureReason> = new Set([
  'provider_unavailable',
  'send_timeout',
]);

/**
 * Processes one `send` job of the `outbound` queue:
 * 1. Take a token from the bucket of the instance (`OutboundRateGate`), before any read of the row.
 *    Without a token, the job goes back to the delayed set (not a failure, not an attempt).
 * 2. Load the message and its instance. A message that is not `queued` is done (idempotent job).
 *    When an older row of the same contact and priority is still `queued`, the job waits
 *    (`RetryLaterError`, not an attempt): the sends of one contact go out in order (ARCH-02).
 *    A job that does not send gives its token back.
 * 3. Send through the provider. Write `sent` or `failed`, with the `message.status` outbox event.
 * A retryable `ProviderError` throws `RetryableSendError`: BullMQ retries with the delay of the policy.
 */
@Injectable()
export class OutboundSender {
  private readonly logger = getLogger('outbound-sender');
  private readonly sendDelay;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    private readonly writer: MessageStatusWriter,
    private readonly gate: OutboundRateGate,
    private readonly media: OutboundMediaPreparer,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertService,
    private readonly order: OutboundOrder,
  ) {
    this.sendDelay = metrics.histogram({
      name: 'botcenter_outbound_send_delay_seconds',
      help: 'Time from the queued row to the accepted send, for each outbound message',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900],
    });
  }

  async process(job: Job<OutboundJob>): Promise<SendOutcome> {
    // The token comes before the read of the row, so a rate-limited backlog does not read PostgreSQL.
    const token = job.data.providerMessageId ? null : await this.gate.take(job);
    const message = await this.load(job.data);
    if (!message || message.status !== 'queued') {
      await this.gate.refund(token);
      this.logger.debug({ status: message?.status ?? null }, 'message is not queued; the job ends');
      return 'skipped';
    }
    const blocked = blockedReason(message.instance);
    if (blocked) {
      await this.gate.refund(token);
      return this.fail(message, blocked);
    }
    if (!job.data.providerMessageId && (await this.order.hasOlderQueued(message))) {
      await this.gate.refund(token);
      return this.waitForOlder(job);
    }
    const result = await this.deliver(job, message);
    if (result.kind === 'failed') {
      return this.fail(message, result.reason);
    }
    return this.markSent(job, message, result.providerMessageId);
  }

  private load(data: OutboundJob): Promise<OutboundMessage | null> {
    return this.prisma.forTenant(data.tenantId).message.findFirst({
      where: { id: data.messageId, direction: 'outbound' },
      select: MESSAGE_SELECT,
    });
  }

  /** An older row of the same contact and priority is `queued`: throw `RetryLaterError` (ARCH-02). */
  private async waitForOlder(job: Job<OutboundJob>): Promise<never> {
    const waits = job.data.orderWaits ?? 0;
    const delayMs = orderWaitMs(waits);
    await keepReadyAt(job, Date.now() + delayMs, { orderWaits: waits + 1 });
    throw new RetryLaterError(delayMs, 'older_message_queued');
  }

  private async deliver(job: Job<OutboundJob>, message: OutboundMessage): Promise<DeliveryResult> {
    if (job.data.providerMessageId) {
      // An earlier run sent the message and could not write the result.
      return { kind: 'sent', providerMessageId: job.data.providerMessageId };
    }
    let content: OutboundContent;
    try {
      content = await this.media.content(job, message.tenantId, message.content as MessageContent);
    } catch (error) {
      if (error instanceof MediaUnavailableError) {
        return { kind: 'failed', reason: error.reason };
      }
      throw error;
    }
    try {
      const result = await this.provider.sendMessage(message.instance.providerName, {
        to: message.contact,
        content,
        ...(message.typingDelayMs ? { typingDelayMs: message.typingDelayMs } : {}),
      });
      return { kind: 'sent', providerMessageId: result.providerMessageId };
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        throw error;
      }
      return this.onProviderError(job, message, error);
    }
  }

  /** Fails at once, fails after the last retry, or throws `RetryableSendError` to retry. */
  private async onProviderError(
    job: Job<OutboundJob>,
    message: OutboundMessage,
    error: ProviderError,
  ): Promise<DeliveryResult> {
    const ambiguousSends = job.data.ambiguousSends ?? 0;
    const decision = decideRetry(error, job.attemptsMade, ambiguousSends);
    this.logger.warn(
      {
        provider_code: error.code,
        http_status: error.httpStatus ?? null,
        attempt: job.attemptsMade + 1,
        decision: decision.action,
        to: maskPhone(message.contact),
      },
      'provider send failed',
    );
    if (decision.action === 'fail') {
      if (ALERT_REASONS.has(decision.reason)) {
        void this.alerts.notify({
          severity: 'warning',
          title: 'Outbound send failed after its retries',
          details: { reason: decision.reason, instance_id: message.instanceId },
          dedupeKey: `outbound-failed:${message.instanceId}:${decision.reason}`,
        });
      }
      return { kind: 'failed', reason: decision.reason };
    }
    if (decision.kind === 'ambiguous') {
      await job.updateData({ ...job.data, ambiguousSends: ambiguousSends + 1 });
    }
    throw new RetryableSendError(decision.kind, decision.delayMs, { cause: error });
  }

  private async markSent(
    job: Job<OutboundJob>,
    message: OutboundMessage,
    providerMessageId: string,
  ): Promise<SendOutcome> {
    if (!job.data.providerMessageId) {
      await this.rememberSend(job, providerMessageId);
    }
    const sentAt = new Date();
    await this.writer.apply(toTarget(message), { status: 'sent', providerMessageId, at: sentAt });
    this.sendDelay.observe((sentAt.getTime() - message.createdAt.getTime()) / 1000);
    await this.order.promoteNext(message);
    return 'sent';
  }

  /** Keeps the provider id in the job, so a retry after a database error does not send again. */
  private async rememberSend(job: Job<OutboundJob>, providerMessageId: string): Promise<void> {
    try {
      await job.updateData({ ...job.data, providerMessageId });
    } catch (error) {
      this.logger.warn({ err: error }, 'provider message id not kept in the job');
    }
  }

  private async fail(
    message: OutboundMessage,
    reason: OutboundFailureReason,
  ): Promise<SendOutcome> {
    await this.writer.apply(toTarget(message), { status: 'failed', reason, at: new Date() });
    this.logger.info({ reason }, 'outbound message failed');
    await this.order.promoteNext(message);
    return 'failed';
  }
}

function toTarget(message: OutboundMessage): StatusTarget {
  return {
    messageId: message.id,
    tenantId: message.tenantId,
    instanceId: message.instanceId,
    externalRef: message.instance.externalRef,
  };
}
