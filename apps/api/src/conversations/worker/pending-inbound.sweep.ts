import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InboundHandlerRegistry } from '../../inbound/inbound-handler.registry';
import type { InboundSweepTask } from '../../inbound/inbound-handler.registry';
import { getLogger } from '../../logging/logger';
import { PrismaService } from '../../prisma/prisma.service';
import { RetryLaterError } from '../../queues/retry-later';
import { ConversationMetrics } from '../conversation-metrics';
import { ConversationRuntime } from './conversation-runtime.service';
import { InstanceResolver } from './instance-context';

/** A `botPending` row younger than this can still belong to a running job. */
export const PENDING_SWEEP_MIN_AGE_MS = 60_000;
/** The conversations that one run drains at most (the next run continues). */
export const PENDING_SWEEP_MAX_CONVERSATIONS = 200;

interface PendingConversation {
  tenantId: string;
  instanceId: string;
  contact: string;
}

export interface PendingSweepResult {
  drained: number;
  busy: number;
  dropped: number;
}

/**
 * ARCH-01: a task of the `sweep-inbound` job (every minute). It finds the conversations with inbound rows
 * that wait for their bot step (`botPending`) for more than one minute: the drain of the job failed, or
 * the job failed its last attempt after the store. It runs the normal drain for each one. The drain
 * skips a row older than one hour (`stale`), so an old row never loops. A busy lock means that another
 * job drains the conversation now.
 */
@Injectable()
export class PendingInboundSweep implements InboundSweepTask, OnModuleInit {
  readonly name = 'drain-pending-inbound';
  private readonly logger = getLogger('inbound-sweep');

  constructor(
    private readonly registry: InboundHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly instances: InstanceResolver,
    private readonly runtime: ConversationRuntime,
    private readonly metrics: ConversationMetrics,
  ) {}

  onModuleInit(): void {
    this.registry.registerSweep(this);
  }

  async run(now: Date): Promise<PendingSweepResult> {
    const conversations = await this.findPending(now);
    const result: PendingSweepResult = { drained: 0, busy: 0, dropped: 0 };
    let failed = 0;
    for (const conversation of conversations) {
      try {
        await this.repair(conversation, result);
      } catch (error) {
        failed += 1;
        this.logger.error(
          { err: error, tenant_id: conversation.tenantId, instance_id: conversation.instanceId },
          'pending inbound rows not drained; the next sweep tries again',
        );
      }
    }
    if (result.drained + result.dropped > 0) {
      this.logger.warn({ ...result, failed }, 'inbound sweep drained lost pending rows');
    }
    if (failed > 0) {
      throw new Error(`The drain failed for ${failed} of ${conversations.length} conversations`);
    }
    return result;
  }

  private async repair(
    conversation: PendingConversation,
    result: PendingSweepResult,
  ): Promise<void> {
    const instance = await this.instances.byId(conversation.tenantId, conversation.instanceId);
    if (!instance) {
      const consumed = await this.prisma.forTenant(conversation.tenantId).message.updateMany({
        where: {
          instanceId: conversation.instanceId,
          contact: conversation.contact,
          botPending: true,
        },
        data: { botPending: false },
      });
      result.dropped += consumed.count;
      this.metrics.repairs.inc({ kind: 'pending_dropped' }, consumed.count);
      return;
    }
    try {
      await this.runtime.drain(instance, conversation.contact);
      result.drained += 1;
      this.metrics.repairs.inc({ kind: 'pending_drained' });
    } catch (error) {
      if (!(error instanceof RetryLaterError)) {
        throw error;
      }
      result.busy += 1;
    }
  }

  /** One row for each conversation (partial index `messages_bot_pending_idx`). */
  private findPending(now: Date): Promise<PendingConversation[]> {
    const before = new Date(now.getTime() - PENDING_SWEEP_MIN_AGE_MS);
    return this.prisma.$queryRaw<PendingConversation[]>`
      SELECT DISTINCT ON ("instanceId", "contact") "tenantId", "instanceId", "contact"
      FROM "messages"
      WHERE "botPending" AND "createdAt" < ${before}
      ORDER BY "instanceId", "contact"
      LIMIT ${PENDING_SWEEP_MAX_CONVERSATIONS}`;
  }
}
