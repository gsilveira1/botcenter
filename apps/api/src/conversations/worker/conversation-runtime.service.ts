import { Injectable } from '@nestjs/common';
import { getLogger } from '../../logging/logger';
import { PrismaService } from '../../prisma/prisma.service';
import type { TimerJob } from '../../queues/queue-names';
import { RetryLaterError } from '../../queues/retry-later';
import { DistributedLockService, LockNotAcquiredError } from '../../services/lock.service';
import type { Lock } from '../../services/lock.service';
import { conversationLockName } from '../conversation-keys';
import { ConversationMetrics } from '../conversation-metrics';
import type { StoredInboundContent } from '../inbound-content';
import { ConversationStepService } from './conversation-step.service';
import type { PendingMessage } from './conversation-step.service';
import { InstanceResolver } from './instance-context';
import type { InstanceContext } from './instance-context';

/** The lock of a conversation is short. A step extends it after each message. */
export const CONVERSATION_LOCK = {
  ttlMs: 30_000,
  /** The job waits this long for a busy lock, then runs again after `retryDelayMs`. */
  waitMs: 2_000,
  retryDelayMs: 1_000,
} as const;
/** The pending rows that one drain reads at a time, and the maximum number of reads. */
const DRAIN_BATCH = 20;
const DRAIN_ROUNDS = 5;

/**
 * Runs the bot for one conversation under its lock (key = instance + contact): events of the same
 * conversation run one at a time, different conversations run in parallel. The holder of the lock
 * processes ALL the pending inbound rows of the conversation in the order of arrival, so two jobs of one
 * conversation keep their order even when the second job takes the lock first. A busy lock is not a
 * failure: the job runs again after a short delay (`RetryLaterError`).
 */
@Injectable()
export class ConversationRuntime {
  private readonly logger = getLogger('conversation-runtime');

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: DistributedLockService,
    private readonly steps: ConversationStepService,
    private readonly instances: InstanceResolver,
    private readonly metrics: ConversationMetrics,
  ) {}

  /**
   * Processes the pending inbound messages of one conversation. Each step writes its `call_webhook`
   * actions as rows in its own transaction (ARCH-04), so a later failure does not lose them.
   */
  async drain(instance: InstanceContext, contact: string): Promise<void> {
    await this.withLock(instance.instanceId, contact, async (lock) => {
      for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
        const pending = await this.pending(instance, contact);
        for (const message of pending) {
          await this.steps.applyMessage(instance, message);
          await this.extend(lock);
        }
        if (pending.length < DRAIN_BATCH) {
          break;
        }
      }
    });
  }

  /** A state timer job. A stale timer (the conversation moved, or it is in handoff) is a no-op. */
  async fireTimer(job: TimerJob): Promise<void> {
    const conversation = await this.prisma.forTenant(job.tenantId).conversation.findUnique({
      where: { id: job.conversationId },
      select: { instanceId: true, contact: true },
    });
    const instance =
      conversation && (await this.instances.byId(job.tenantId, conversation.instanceId));
    if (!conversation || !instance) {
      this.metrics.timers.inc({ result: 'stale' });
      return;
    }
    await this.withLock(instance.instanceId, conversation.contact, () =>
      this.steps.applyTimer(instance, conversation.contact, job),
    );
  }

  private async pending(instance: InstanceContext, contact: string): Promise<PendingMessage[]> {
    const rows = await this.prisma.forTenant(instance.tenantId).message.findMany({
      where: { instanceId: instance.instanceId, contact, direction: 'inbound', botPending: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: DRAIN_BATCH,
      select: { id: true, contact: true, content: true, createdAt: true },
    });
    return rows.map((row) => ({ ...row, content: row.content as unknown as StoredInboundContent }));
  }

  private async withLock<T>(
    instanceId: string,
    contact: string,
    fn: (lock: Lock) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await this.locks.withLock(
        conversationLockName(instanceId, contact),
        { ttlMs: CONVERSATION_LOCK.ttlMs, waitMs: CONVERSATION_LOCK.waitMs },
        fn,
      );
      this.metrics.lockWaits.inc({ result: 'acquired' });
      return result;
    } catch (error) {
      if (!(error instanceof LockNotAcquiredError)) {
        throw error;
      }
      this.metrics.lockWaits.inc({ result: 'busy' });
      throw new RetryLaterError(CONVERSATION_LOCK.retryDelayMs, 'conversation lock busy');
    }
  }

  private async extend(lock: Lock): Promise<void> {
    if (!(await this.locks.extend(lock, CONVERSATION_LOCK.ttlMs))) {
      // The optimistic `version` check still guards the writes.
      this.logger.warn({ lock: lock.name }, 'conversation lock expired during a drain');
    }
  }
}
