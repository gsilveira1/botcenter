import { Injectable } from '@nestjs/common';
import type { MessageStatus } from '@botcenter/contracts';
import type { Prisma } from '../generated/prisma/client';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../services/outbox.service';
import { statusesBefore } from './message-status';
import type { OutboundFailureReason } from './retry-policy';

/** The message and the instance fields that a status change needs. */
export interface StatusTarget {
  messageId: string;
  tenantId: string;
  instanceId: string;
  externalRef: string;
}

export type StatusChange =
  | { status: 'sent'; providerMessageId: string; at: Date }
  | { status: 'delivered' | 'read'; at: Date }
  | { status: 'failed'; reason: OutboundFailureReason; at: Date };

function changeData(change: StatusChange): Prisma.MessageUpdateManyMutationInput {
  switch (change.status) {
    case 'sent':
      return { status: 'sent', providerMessageId: change.providerMessageId, sentAt: change.at };
    case 'delivered':
      return { status: 'delivered', deliveredAt: change.at };
    case 'read':
      return { status: 'read', readAt: change.at };
    case 'failed':
      return { status: 'failed', failureReason: change.reason };
  }
}

/**
 * The one writer of outbound status changes. In one transaction, it moves the status only forward (a
 * conditional update on the statuses before the new one, see `message-status.ts`) and writes the
 * `message.status` outbox event. Two workers that write the same change at the same time make one
 * change and one event. A `sent` or `failed` change also counts
 * `botcenter_instance_messages_total{instance_id,status}`. Returns false when the message has this status or a later one already.
 */
@Injectable()
export class MessageStatusWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
  ) {}

  async apply(target: StatusTarget, change: StatusChange): Promise<boolean> {
    const changed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.message.updateMany({
        where: {
          id: target.messageId,
          tenantId: target.tenantId,
          direction: 'outbound',
          status: { in: statusesBefore(change.status) },
        },
        data: changeData(change),
      });
      if (result.count === 0) {
        return false;
      }
      await this.outbox.enqueue(tx, {
        tenantId: target.tenantId,
        type: 'message.status',
        payload: {
          instance_id: target.instanceId,
          external_ref: target.externalRef,
          message_id: target.messageId,
          status: change.status satisfies MessageStatus,
          failure_reason: change.status === 'failed' ? change.reason : null,
        },
      });
      return true;
    });
    if (changed) {
      this.metrics.messagesTotal.inc({ status: change.status });
      if (change.status === 'sent' || change.status === 'failed') {
        this.metrics.instanceMessagesTotal.inc({
          instance_id: target.instanceId,
          status: change.status,
        });
      }
    }
    return changed;
  }
}
