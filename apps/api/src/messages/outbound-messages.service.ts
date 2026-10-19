import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import type { OutboundMessageInput, OutboundMessagesPort } from '../ports/outbound-messages.port';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { AlertService } from '../services/alert.service';
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
  ) {}

  /**
   * Writes the row in the transaction of the caller. A `bulk` message consumes the daily quota and can
   * throw 429 `QUOTA_EXCEEDED` (the caller transaction then rolls back). A `reply` does not use the quota.
   */
  async createInTx(
    tx: TransactionClient,
    input: OutboundMessageInput,
  ): Promise<{ messageId: string }> {
    if (input.priority === 'bulk') {
      await this.quota.consume(input.tenantId);
    }
    const row = await tx.message.create({ data: outboundMessageData(input), select: { id: true } });
    this.metrics.messagesTotal.inc({ status: 'queued' });
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
