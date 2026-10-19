import { Injectable } from '@nestjs/common';
import type { MessagePriority } from '@botcenter/contracts';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { MessageStatusWriter } from './message-status.writer';
import { OutboundMessagesService } from './outbound-messages.service';

/** A `queued` row younger than this can still wait for its first enqueue (the API adds the job after the commit). */
export const SWEEP_MIN_AGE_MS = 60_000;
/** Rows for each run. The oldest rows go first; the next run takes the rest. */
export const SWEEP_BATCH_SIZE = 500;

export interface SweepResult {
  checked: number;
  requeued: number;
  failed: number;
}

interface QueuedRow {
  id: string;
  tenantId: string;
  instanceId: string;
  priority: MessagePriority;
  instance: { externalRef: string };
}

/**
 * The repeatable `sweep` job of the `outbound` queue (every minute). It finds `queued` outbound rows older
 * than one minute and reads the state of their job (the job id is the message id):
 * - no job (the enqueue failed after the commit, or Redis lost the job): enqueue it again;
 * - a completed job (a run ended without a status write): remove the job and enqueue it again;
 * - a failed job (an unexpected error on the last attempt): write `failed` (`internal_error`);
 * - a waiting, delayed, or active job: nothing.
 * The query is across the tenants (a system task); each write has the `tenantId` of its row.
 */
@Injectable()
export class OutboundSweep {
  private readonly logger = getLogger('outbound-sweep');

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly outbound: OutboundMessagesService,
    private readonly writer: MessageStatusWriter,
  ) {}

  async run(now = new Date()): Promise<SweepResult> {
    const rows = await this.findQueued(now);
    if (rows.length === 0) {
      return { checked: 0, requeued: 0, failed: 0 };
    }
    const queue = this.queues.get('outbound');
    const states = await Promise.all(rows.map((row) => queue.getJobState(row.id)));
    const withState = (...wanted: string[]) =>
      rows.filter((_, index) => wanted.includes(states[index]!));
    await Promise.all(withState('completed').map((row) => queue.remove(row.id)));
    const requeued = await this.outbound.enqueue(
      withState('unknown', 'completed').map((row) => ({ ...row, messageId: row.id })),
    );
    const failed = await this.failLost(withState('failed'));
    if (requeued > 0 || failed > 0) {
      this.logger.warn({ checked: rows.length, requeued, failed }, 'outbound sweep fixed messages');
    }
    return { checked: rows.length, requeued, failed };
  }

  /** The oldest `queued` outbound rows of all tenants (index `(status, createdAt)`). */
  private findQueued(now: Date): Promise<QueuedRow[]> {
    return this.prisma.message.findMany({
      where: {
        direction: 'outbound',
        status: 'queued',
        createdAt: { lt: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: {
        id: true,
        tenantId: true,
        instanceId: true,
        priority: true,
        instance: { select: { externalRef: true } },
      },
    });
  }

  private async failLost(rows: readonly QueuedRow[]): Promise<number> {
    const results = await Promise.all(
      rows.map((row) =>
        this.writer.apply(
          {
            messageId: row.id,
            tenantId: row.tenantId,
            instanceId: row.instanceId,
            externalRef: row.instance.externalRef,
          },
          { status: 'failed', reason: 'internal_error', at: new Date() },
        ),
      ),
    );
    return results.filter(Boolean).length;
  }
}
