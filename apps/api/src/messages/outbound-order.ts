import { Injectable } from '@nestjs/common';
import type { MessagePriority } from '@botcenter/contracts';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';

/** The first wait of a job that has an older queued row of the same contact. */
export const ORDER_WAIT_BASE_MS = 1_000;
/** The maximum wait. The send of the older row promotes the next job, so this wait is only a fallback. */
export const ORDER_WAIT_MAX_MS = 30_000;

/** The fields of an outbound row that its place in the send order needs. */
export interface OrderedMessage {
  id: string;
  tenantId: string;
  instanceId: string;
  contact: string;
  priority: MessagePriority;
  /** The insert order (`messages.seq`). The rows of one transaction have the same `createdAt`. */
  seq: bigint;
}

/** The wait before the next check: 1 s, 2 s, 4 s, and so on, at most 30 s. */
export function orderWaitMs(waits: number): number {
  return Math.min(ORDER_WAIT_MAX_MS, ORDER_WAIT_BASE_MS * 2 ** Math.max(0, waits));
}

/**
 * The send order of one contact (ARCH-02). The outbound rows of one instance, contact, and priority go
 * out in the order of `seq`: a job sends only the oldest `queued` row, and a job of a younger row waits
 * (`RetryLaterError`, not an attempt). When the older row gets its final status (`sent` or `failed`),
 * `promoteNext` wakes the job of the next row at once. The order is for each priority, so a long `bulk`
 * backlog does not hold the bot replies of the same contact.
 */
@Injectable()
export class OutboundOrder {
  private readonly logger = getLogger('outbound-order');

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  /** True when an older row of the same instance, contact, and priority is still `queued`. */
  async hasOlderQueued(message: OrderedMessage): Promise<boolean> {
    const older = await this.prisma.forTenant(message.tenantId).message.findFirst({
      where: {
        instanceId: message.instanceId,
        contact: message.contact,
        priority: message.priority,
        direction: 'outbound',
        status: 'queued',
        seq: { lt: message.seq },
      },
      select: { id: true },
    });
    return older !== null;
  }

  /**
   * Promotes the delayed job of the next `queued` row of the contact, after the final status of this row.
   * Never throws: a failure only makes the next job wait for its own delay (at most 30 s).
   */
  async promoteNext(message: OrderedMessage): Promise<void> {
    try {
      const next = await this.prisma.forTenant(message.tenantId).message.findFirst({
        where: {
          instanceId: message.instanceId,
          contact: message.contact,
          priority: message.priority,
          direction: 'outbound',
          status: 'queued',
          seq: { gt: message.seq },
        },
        orderBy: { seq: 'asc' },
        select: { id: true },
      });
      if (!next) {
        return;
      }
      const job = await this.queues.get('outbound').getJob(next.id);
      if (job && (await job.isDelayed())) {
        await job.promote();
      }
    } catch (error) {
      if ((error as Error | undefined)?.message?.includes('is not in the delayed state')) {
        // The job left the delayed state at the same time (a normal race).
        return;
      }
      this.logger.warn({ err: error }, 'next outbound job not promoted; it waits for its delay');
    }
  }
}
