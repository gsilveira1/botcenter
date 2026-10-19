import { Inject, Injectable } from '@nestjs/common';
import type { MessagePriority } from '@botcenter/contracts';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { MessageStatusWriter } from './message-status.writer';
import { OutboundMessagesService } from './outbound-messages.service';
import type { OutboundFailureReason } from './retry-policy';

/** A `queued` row younger than this can still wait for its first enqueue (the API adds the job after the commit). */
export const SWEEP_MIN_AGE_MS = 60_000;
/** Rows for each run. The oldest rows go first; the next run takes the rest. */
export const SWEEP_BATCH_SIZE = 500;

export interface SweepResult {
  checked: number;
  requeued: number;
  failed: number;
  /** Rows older than `OUTBOUND_QUEUED_MAX_AGE_SECONDS`, now `failed` with the reason `expired`. */
  expired: number;
}

interface QueuedRow {
  id: string;
  createdAt: Date;
  tenantId: string;
  instanceId: string;
  priority: MessagePriority;
  instance: { externalRef: string };
}

const QUEUED_ROW_SELECT = {
  id: true,
  createdAt: true,
  tenantId: true,
  instanceId: true,
  priority: true,
  instance: { select: { externalRef: true } },
} as const;

/**
 * The repeatable `sweep` job of the `outbound` queue (every minute). It finds `queued` outbound rows older
 * than one minute and reads the state of their job (the job id is the message id):
 * - no job (the enqueue failed after the commit, or Redis lost the job): enqueue it again;
 * - a completed job (a run ended without a status write): remove the job and enqueue it again;
 * - a failed job (an unexpected error on the last attempt): write `failed` (`internal_error`);
 * - a waiting, delayed, or active job: nothing.
 * First, a `queued` row older than `OUTBOUND_QUEUED_MAX_AGE_SECONDS` (default 24 h) becomes `failed`
 * with the reason `expired` and its `message.status` event (at most 500 rows in each run). Its job then
 * ends without a send.
 * The query is across the tenants (a system task); each write has the `tenantId` of its row.
 */
@Injectable()
export class OutboundSweep {
  private readonly logger = getLogger('outbound-sweep');
  /** The last row of the last full page. The next run continues after it (ARCH-10). */
  private cursor: { createdAt: Date; id: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly outbound: OutboundMessagesService,
    private readonly writer: MessageStatusWriter,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async run(now = new Date()): Promise<SweepResult> {
    const expired = await this.expireOld(now);
    const rows = await this.findQueued(now);
    if (rows.length === 0) {
      return { checked: 0, requeued: 0, failed: 0, expired };
    }
    const queue = this.queues.get('outbound');
    const states = await Promise.all(rows.map((row) => queue.getJobState(row.id)));
    const withState = (...wanted: string[]) =>
      rows.filter((_, index) => wanted.includes(states[index]!));
    await Promise.all(withState('completed').map((row) => queue.remove(row.id)));
    const requeued = await this.outbound.enqueue(
      withState('unknown', 'completed').map((row) => ({ ...row, messageId: row.id })),
    );
    const failed = await this.failAll(withState('failed'), 'internal_error');
    if (requeued > 0 || failed > 0) {
      this.logger.warn({ checked: rows.length, requeued, failed }, 'outbound sweep fixed messages');
    }
    return { checked: rows.length, requeued, failed, expired };
  }

  /** Fails the oldest `queued` rows that passed the maximum age (reason `expired`). */
  private async expireOld(now: Date): Promise<number> {
    const maxAgeMs = this.env.OUTBOUND_QUEUED_MAX_AGE_SECONDS * 1000;
    const rows = await this.prisma.message.findMany({
      where: {
        direction: 'outbound',
        status: 'queued',
        createdAt: { lt: new Date(now.getTime() - maxAgeMs) },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH_SIZE,
      select: QUEUED_ROW_SELECT,
    });
    const expired = await this.failAll(rows, 'expired');
    if (expired > 0) {
      this.logger.warn(
        { expired, max_age_seconds: this.env.OUTBOUND_QUEUED_MAX_AGE_SECONDS },
        'outbound rows expired before their send',
      );
    }
    return expired;
  }

  /**
   * One page of `queued` outbound rows of all tenants, in the order `createdAt, id` (index
   * `(status, createdAt)`). Each run reads the page after the page of the run before, so a large backlog
   * of waiting rows cannot hide the newer rows that lost their job. A short page ends the pass, and the
   * next run starts at the oldest row again. The cursor is in the memory of the worker process.
   */
  private async findQueued(now: Date): Promise<QueuedRow[]> {
    const after = this.cursor;
    const rows = await this.prisma.message.findMany({
      where: {
        direction: 'outbound',
        status: 'queued',
        createdAt: { lt: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH_SIZE,
      select: QUEUED_ROW_SELECT,
    });
    const last = rows.at(-1);
    this.cursor =
      rows.length === SWEEP_BATCH_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null;
    return rows;
  }

  private async failAll(
    rows: readonly QueuedRow[],
    reason: OutboundFailureReason,
  ): Promise<number> {
    const results = await Promise.all(
      rows.map((row) =>
        this.writer.apply(
          {
            messageId: row.id,
            tenantId: row.tenantId,
            instanceId: row.instanceId,
            externalRef: row.instance.externalRef,
          },
          { status: 'failed', reason, at: new Date() },
        ),
      ),
    );
    return results.filter(Boolean).length;
  }
}
