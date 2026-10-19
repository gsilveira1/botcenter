import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/errors/app-error';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import type { OutboundMessageInput, OutboundMessagesPort } from '../ports/outbound-messages.port';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { AlertService } from '../services/alert.service';
import { OutboxService } from '../services/outbox.service';
import { MessageQuota } from './message-quota';
import { OUTBOUND_SEND_JOB, outboundJobOptions } from './outbound-job';
import type { OutboundEnqueue } from './outbound-job';

/** The insert data of one outbound message with status `queued`. */
export function outboundMessageData(
  input: OutboundMessageInput,
): Prisma.MessageUncheckedCreateInput {
  return {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    conversationId: input.conversationId ?? null,
    direction: 'outbound',
    type: input.content.type,
    status: 'queued',
    contact: input.to,
    content: input.content as Prisma.InputJsonObject,
    priority: input.priority,
    typingDelayMs: input.typingDelayMs ?? null,
  };
}

/**
 * The implementation of the frozen port `OUTBOUND_MESSAGES`, and the one producer of `outbound` jobs.
 * Enqueue errors never reach the caller: the row stays `queued`, and the sweep of the worker
 * (`OutboundSweep`, every minute) enqueues it again. So no message is lost silently.
 */
@Injectable()
export class OutboundMessagesService implements OutboundMessagesPort {
  private readonly logger = getLogger('outbound-messages');

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly quota: MessageQuota,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertService,
    private readonly outbox: OutboxService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  /**
   * Writes the row in the transaction of the caller. A `bulk` message consumes the daily quota and can
   * throw 429 `QUOTA_EXCEEDED` (the caller transaction then rolls back). A `reply` does not use the quota.
   *
   * When the instance has `OUTBOUND_MAX_QUEUED_PER_INSTANCE` queued rows (SEC-04), the reply is refused:
   * the row is written as `failed` (`instance_queue_full`) with its `message.status` event, a warning
   * is logged, and `dispatch` does not enqueue it. It does not throw, so the conversation step of the
   * caller still commits (a throw would roll back the step and repeat it for ever).
   */
  async createInTx(
    tx: TransactionClient,
    input: OutboundMessageInput,
  ): Promise<{ messageId: string }> {
    if (input.priority === 'bulk') {
      await this.quota.consume(input.tenantId);
    }
    if (await this.queueIsFull(tx, input.instanceId)) {
      return this.refuseInTx(tx, input);
    }
    const row = await tx.message.create({ data: outboundMessageData(input), select: { id: true } });
    this.metrics.messagesTotal.inc({ status: 'queued' });
    return { messageId: row.id };
  }

  /** `POST /v1/messages`: 429 `QUOTA_EXCEEDED` when the instance has too many queued rows (SEC-04). */
  async assertQueueBelowLimit(tenantId: string, instanceId: string): Promise<void> {
    const db = this.prisma.forTenant(tenantId) as unknown as TransactionClient;
    if (await this.queueIsFull(db, instanceId)) {
      this.metrics.rateLimitDeniedTotal.inc({ scope: 'instance_queue' });
      throw new AppError(
        'QUOTA_EXCEEDED',
        `The instance has ${this.env.OUTBOUND_MAX_QUEUED_PER_INSTANCE} queued messages. Retry later.`,
        { headers: { 'Retry-After': '60' } },
      );
    }
  }

  /** True when the instance has the maximum of queued rows (partial index `messages_queued_idx`). */
  private async queueIsFull(db: TransactionClient, instanceId: string): Promise<boolean> {
    const limit = this.env.OUTBOUND_MAX_QUEUED_PER_INSTANCE;
    const queued = await db.message.count({
      where: { instanceId, status: 'queued' },
      take: limit,
    });
    return queued >= limit;
  }

  private async refuseInTx(
    tx: TransactionClient,
    input: OutboundMessageInput,
  ): Promise<{ messageId: string }> {
    const reason = 'instance_queue_full';
    const row = await tx.message.create({
      data: { ...outboundMessageData(input), status: 'failed', failureReason: reason },
      select: { id: true, instance: { select: { externalRef: true } } },
    });
    await this.outbox.enqueue(tx, {
      tenantId: input.tenantId,
      type: 'message.status',
      payload: {
        instance_id: input.instanceId,
        external_ref: row.instance.externalRef,
        message_id: row.id,
        status: 'failed',
        failure_reason: reason,
      },
    });
    this.metrics.messagesTotal.inc({ status: 'failed' });
    this.metrics.instanceMessagesTotal.inc({ instance_id: input.instanceId, status: 'failed' });
    this.metrics.rateLimitDeniedTotal.inc({ scope: 'instance_queue' });
    this.logger.warn(
      { limit: this.env.OUTBOUND_MAX_QUEUED_PER_INSTANCE, priority: input.priority },
      'outbound queue of the instance is full; the reply is refused',
    );
    void this.alerts.notify({
      severity: 'warning',
      title: 'Outbound queue of an instance is full; bot replies are refused',
      details: { instance_id: input.instanceId },
      dedupeKey: `outbound:queue-full:${input.instanceId}`,
    });
    return { messageId: row.id };
  }

  /** Adds the jobs after the commit of the caller. Reads the priorities in one query. Never throws. */
  async dispatch(
    messages: ReadonlyArray<{ tenantId: string; messageId: string; instanceId: string }>,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    let rows: OutboundEnqueue[];
    try {
      rows = await this.prisma.message
        .findMany({
          where: {
            id: { in: messages.map((message) => message.messageId) },
            tenantId: { in: [...new Set(messages.map((message) => message.tenantId))] },
            direction: 'outbound',
            status: 'queued',
          },
          select: { id: true, tenantId: true, instanceId: true, priority: true },
        })
        .then((found) => found.map((row) => ({ ...row, messageId: row.id })));
    } catch (error) {
      this.logger.error(
        { err: error, count: messages.length },
        'dispatch query failed; the sweep enqueues the messages later',
      );
      return;
    }
    await this.enqueue(rows);
  }

  /** Adds one `send` job for each message. Returns the number of added jobs. Never throws. */
  async enqueue(messages: readonly OutboundEnqueue[]): Promise<number> {
    if (messages.length === 0) {
      return 0;
    }
    try {
      await this.queues.get('outbound').addBulk(
        messages.map((message) => ({
          name: OUTBOUND_SEND_JOB,
          data: {
            tenantId: message.tenantId,
            messageId: message.messageId,
            instanceId: message.instanceId,
          },
          opts: outboundJobOptions(message.messageId, message.priority),
        })),
      );
      return messages.length;
    } catch (error) {
      this.logger.error(
        { err: error, count: messages.length },
        'outbound enqueue failed; the messages stay queued and the sweep enqueues them later',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Outbound enqueue failed (Redis error)',
        details: { count: messages.length },
        dedupeKey: 'outbound:enqueue',
      });
      return 0;
    }
  }
}
