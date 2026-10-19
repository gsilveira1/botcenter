import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { timerJobId } from '@botcenter/engine';
import { InboundHandlerRegistry } from '../../inbound/inbound-handler.registry';
import type { InboundSweepTask } from '../../inbound/inbound-handler.registry';
import { getLogger } from '../../logging/logger';
import { PrismaService } from '../../prisma/prisma.service';
import { QueuesService } from '../../queues/queues.service';
import { ConversationMetrics } from '../conversation-metrics';
import { ConversationTimersService } from '../conversation-timers.service';

/** A timer that is late by less than this can still wait in the `timers` queue. */
export const TIMER_REPAIR_MIN_LATE_MS = 60_000;
/** The conversations that one run checks at most (oldest fire time first). */
export const TIMER_REPAIR_BATCH = 500;

export interface TimerRepairResult {
  checked: number;
  rearmed: number;
  cleared: number;
}

interface ArmedConversation {
  id: string;
  tenantId: string;
  state: string;
  version: number;
  timerFireAt: Date | null;
}

/**
 * ARCH-08: a task of the `sweep-inbound` job (every minute). The step and the handoff store the fire time
 * of the timer of the current version (`conversations.timerFireAt`). For each conversation of the bot
 * with a fire time older than one minute, the task reads the job `timer-<id>-v<version>`:
 * - no job (the worker stopped before the add, Redis refused the add, or Redis lost the job): add it
 *   again with the same id, so it fires now;
 * - `failed` (all attempts failed): retry it;
 * - `completed` (the timer ran and changed nothing): clear the fire time;
 * - any other state: the job waits or runs; do nothing.
 */
@Injectable()
export class TimerRepairSweep implements InboundSweepTask, OnModuleInit {
  readonly name = 'repair-state-timers';
  private readonly logger = getLogger('inbound-sweep');

  constructor(
    private readonly registry: InboundHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly timers: ConversationTimersService,
    private readonly metrics: ConversationMetrics,
  ) {}

  onModuleInit(): void {
    this.registry.registerSweep(this);
  }

  async run(now: Date): Promise<TimerRepairResult> {
    const rows: ArmedConversation[] = await this.prisma.conversation.findMany({
      where: {
        timerFireAt: { lt: new Date(now.getTime() - TIMER_REPAIR_MIN_LATE_MS) },
        handoff: false,
      },
      orderBy: { timerFireAt: 'asc' },
      take: TIMER_REPAIR_BATCH,
      select: { id: true, tenantId: true, state: true, version: true, timerFireAt: true },
    });
    const result: TimerRepairResult = { checked: rows.length, rearmed: 0, cleared: 0 };
    for (const row of rows) {
      const outcome = await this.repair(row, now);
      if (outcome !== null) {
        result[outcome] += 1;
        this.metrics.repairs.inc({
          kind: outcome === 'rearmed' ? 'timer_rearmed' : 'timer_cleared',
        });
      }
    }
    if (result.rearmed > 0) {
      this.logger.warn({ ...result }, 'lost state timers added again');
    }
    return result;
  }

  private async repair(row: ArmedConversation, now: Date): Promise<'rearmed' | 'cleared' | null> {
    const jobId = timerJobId(row.id, row.version);
    const queue = this.queues.get('timers');
    const state = await queue.getJobState(jobId);
    if (state === 'unknown') {
      const added = await this.timers.schedule(
        { state: row.state, version: row.version, jobId, fireAt: row.timerFireAt ?? now },
        { tenantId: row.tenantId, conversationId: row.id },
        now,
      );
      return added ? 'rearmed' : null;
    }
    if (state === 'failed') {
      await (await queue.getJob(jobId))?.retry('failed');
      return 'rearmed';
    }
    if (state === 'completed') {
      // The version did not change after the run (a stale or skipped timer): nothing is armed.
      await this.prisma.forTenant(row.tenantId).conversation.updateMany({
        where: { id: row.id, version: row.version },
        data: { timerFireAt: null },
      });
      return 'cleared';
    }
    return null;
  }
}
