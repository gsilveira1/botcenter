import { Injectable } from '@nestjs/common';
import type { ConversationResponse, HandoffRequest } from '@botcenter/contracts';
import { timerForState, timerJobId } from '@botcenter/engine';
import type { TimerPlan } from '@botcenter/engine';
import { assertInstanceAllowed, auditActor } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { AppError, notFound } from '../common/errors/app-error';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AuditService } from '../services/audit.service';
import { OutboxService } from '../services/outbox.service';
import { BotDataError, BotDefinitionsService } from './bot-definitions.service';
import { ConversationCacheService } from './conversation-cache.service';
import { ConversationMetrics } from './conversation-metrics';
import { toConversationRecord } from './conversation-record';
import { CONVERSATION_RESPONSE_INCLUDE, toConversationResponse } from './conversation-response';
import type { ConversationWithResponseData } from './conversation-response';
import { ConversationTimersService } from './conversation-timers.service';
import { recordTransition } from './conversation-transition';

/** Attempts of a handoff write when a worker step changes the conversation at the same time. */
const HANDOFF_ATTEMPTS = 3;

class HandoffConflict extends Error {}

/**
 * `GET /v1/conversations/{id}` and `POST /v1/conversations/{id}/handoff`. A handoff is a write that is
 * not from the engine: it increments `version`, so the pending timer and any running worker step become
 * stale (the worker step conflicts and reloads the conversation).
 */
@Injectable()
export class ConversationsService {
  private readonly logger = getLogger('conversations');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly cache: ConversationCacheService,
    private readonly timers: ConversationTimersService,
    private readonly definitions: BotDefinitionsService,
    private readonly metrics: ConversationMetrics,
  ) {}

  async get(auth: AuthContext, id: string): Promise<ConversationResponse> {
    return toConversationResponse(await this.load(auth, id));
  }

  async handoff(
    auth: AuthContext,
    id: string,
    target: HandoffRequest['to'],
  ): Promise<ConversationResponse> {
    for (let attempt = 1; attempt <= HANDOFF_ATTEMPTS; attempt += 1) {
      const row = await this.load(auth, id);
      if (row.handoff === (target === 'human')) {
        return toConversationResponse(row);
      }
      const timer = target === 'bot' ? await this.timerAfterHandoff(row) : null;
      try {
        await this.writeHandoff(auth, row, target, timer);
      } catch (error) {
        if (error instanceof HandoffConflict) {
          this.metrics.conflicts.inc({ result: 'retried' });
          continue;
        }
        throw error;
      }
      await this.afterHandoff(row, target, timer);
      return toConversationResponse(await this.load(auth, id));
    }
    this.metrics.conflicts.inc({ result: 'exhausted' });
    throw new AppError('CONFLICT', 'The conversation changed during the handoff. Try again.');
  }

  private async load(auth: AuthContext, id: string): Promise<ConversationWithResponseData> {
    const row = await this.prisma.forTenant(auth.tenantId).conversation.findUnique({
      where: { id },
      include: CONVERSATION_RESPONSE_INCLUDE,
    });
    if (!row) {
      throw notFound('Conversation');
    }
    assertInstanceAllowed(auth, row.instanceId);
    return row;
  }

  private async writeHandoff(
    auth: AuthContext,
    row: ConversationWithResponseData,
    target: HandoffRequest['to'],
    timer: TimerPlan | null,
  ): Promise<void> {
    const handoff = target === 'human';
    await this.prisma.forTenant(auth.tenantId).$transaction(async (scoped) => {
      const tx = scoped as unknown as TransactionClient;
      const updated = await tx.conversation.updateMany({
        where: { id: row.id, tenantId: auth.tenantId, version: row.version },
        data: { handoff, version: row.version + 1, timerFireAt: timer?.fireAt ?? null },
      });
      if (updated.count !== 1) {
        throw new HandoffConflict();
      }
      await recordTransition(tx, this.outbox, {
        tenantId: auth.tenantId,
        conversationId: row.id,
        instanceId: row.instanceId,
        externalRef: row.instance.externalRef,
        contact: row.contact,
        botSlug: row.bot.slug,
        botVersion: row.botVersion,
        fromState: row.state,
        toState: row.state,
        trigger: 'handoff',
        handoff,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actor: auditActor(auth),
          action: `conversation.handoff.${target}`,
          targetType: 'conversation',
          targetId: row.id,
          metadata: { instance_id: row.instanceId, state: row.state, version: row.version + 1 },
        },
        tx,
      );
    });
    this.metrics.transitions.inc({ trigger: 'handoff' });
  }

  /**
   * The timer of the current state for the version after a handoff to the bot (engine open problem 2).
   * The write stores its fire time (ARCH-08). A missing bot version arms no timer.
   */
  private async timerAfterHandoff(row: ConversationWithResponseData): Promise<TimerPlan | null> {
    const loaded = await this.definitions
      .version(row.tenantId, row.botId, row.botVersion)
      .catch((error: unknown) => {
        if (!(error instanceof BotDataError)) {
          throw error;
        }
        this.logger.error(
          { err: error, conversation_id: row.id },
          'bot version not loaded; no timer armed',
        );
        return null;
      });
    if (!loaded) {
      return null;
    }
    return timerForState(loaded.definition, {
      conversationId: row.id,
      state: row.state,
      version: row.version + 1,
      now: new Date(),
    });
  }

  /**
   * After the commit: write the new record to the hot cache (ARCH-09: the compare-and-set on `version`
   * keeps an older record of a running worker out; a failed write deletes the entry), then remove the
   * pending timer (`human`) or add the timer of the current state with the new version (`bot`).
   */
  private async afterHandoff(
    row: ConversationWithResponseData,
    target: HandoffRequest['to'],
    timer: TimerPlan | null,
  ): Promise<void> {
    await this.cache.set(
      toConversationRecord({ ...row, handoff: target === 'human', version: row.version + 1 }),
    );
    if (target === 'human') {
      await this.timers.cancel(timerJobId(row.id, row.version));
      return;
    }
    if (timer) {
      await this.timers.schedule(
        timer,
        { tenantId: row.tenantId, conversationId: row.id },
        new Date(),
      );
    }
  }
}
