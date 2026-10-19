import { Inject, Injectable } from '@nestjs/common';
import {
  EngineStateError,
  handleInbound,
  handleTimeout,
  startConversation,
} from '@botcenter/engine';
import type { EngineResult } from '@botcenter/engine';
import { ENV } from '../../config/env';
import type { AppEnv } from '../../config/env';
import { getLogger } from '../../logging/logger';
import type { TimerJob } from '../../queues/queue-names';
import { AlertService } from '../../services/alert.service';
import { BotDataError, BotDefinitionsService } from '../bot-definitions.service';
import type { LoadedBotVersion } from '../bot-definitions.service';
import { ConversationCacheService } from '../conversation-cache.service';
import { ConversationMetrics } from '../conversation-metrics';
import { toSnapshot } from '../conversation-record';
import type { ConversationRecord } from '../conversation-record';
import { toEngineInput } from '../inbound-content';
import type { StoredInboundContent } from '../inbound-content';
import { mapMenuReply, menuAfterActions } from '../menu-reply';
import type { LastMenu } from '../menu-reply';
import { uuidV7 } from '../uuid-v7';
import { AfterCommitService } from './after-commit.service';
import { BotHttpService } from './bot-http';
import type { BotWebhookCall } from './bot-http';
import { ConversationLoader } from './conversation-loader.service';
import { ConversationWriter } from './conversation-writer.service';
import { EngineDiagnosticsReporter } from './engine-diagnostics';
import type { InstanceContext } from './instance-context';
import { WriteConflictError } from './step-plan';
import type { StepPlan } from './step-plan';

/** Attempts of one step when the optimistic lock conflicts (reload and run the engine again). */
export const STEP_ATTEMPTS = 3;
/** An inbound message that waited longer than this for its bot step is not given to the bot. */
export const PENDING_MAX_AGE_MS = 60 * 60_000;

/** An inbound row that waits for the bot step (`botPending`). */
export interface PendingMessage {
  id: string;
  contact: string;
  content: StoredInboundContent;
  createdAt: Date;
}

export type SkipReason = 'handoff' | 'no_bot' | 'stale' | 'engine_error';

interface Skip {
  skip: SkipReason;
  conversationId: string | null;
}

interface PlanInput {
  instance: InstanceContext;
  contact: string;
  conversationId: string;
  expectedVersion: number | null;
  bot: LoadedBotVersion;
  result: EngineResult;
  previousMenu: LastMenu | null;
  messageId: string | null;
  /** State timeouts in a row after this step (SEC-04). */
  timeoutsInRow: number;
  now: Date;
}

/** The timer belongs to this conversation, and the bot (not a human) runs it. */
function isTimerTarget(conversation: ConversationRecord, job: TimerJob): boolean {
  return conversation.id === job.conversationId && !conversation.handoff;
}

/** All attempts of a step conflicted. The job fails this attempt and BullMQ retries it with backoff. */
export class ConversationConflictError extends Error {
  constructor(conversationKey: string) {
    super(`The conversation kept changing during the step (${conversationKey})`);
    this.name = 'ConversationConflictError';
  }
}

/**
 * One engine step for one input (an inbound message or a timer), with the optimistic retry: load the
 * conversation (hot cache, then PostgreSQL), call the engine, write in one transaction, and run the
 * work after the commit. The caller holds the conversation lock.
 */
@Injectable()
export class ConversationStepService {
  private readonly logger = getLogger('conversation-step');
  private readonly maxTimeoutsInRow: number;

  constructor(
    @Inject(ENV) env: AppEnv,
    private readonly loader: ConversationLoader,
    private readonly definitions: BotDefinitionsService,
    private readonly writer: ConversationWriter,
    private readonly afterCommit: AfterCommitService,
    private readonly cache: ConversationCacheService,
    private readonly http: BotHttpService,
    private readonly diagnostics: EngineDiagnosticsReporter,
    private readonly metrics: ConversationMetrics,
    private readonly alerts: AlertService,
  ) {
    this.maxTimeoutsInRow = env.BOT_MAX_TIMEOUTS_IN_ROW;
  }

  async applyMessage(
    instance: InstanceContext,
    message: PendingMessage,
  ): Promise<BotWebhookCall[]> {
    return this.withRetry(instance, message.contact, async (fresh) => {
      if (fresh && !(await this.writer.isPending(instance.tenantId, message.id))) {
        return null;
      }
      const planned = await this.planMessage(instance, message, fresh);
      if ('skip' in planned) {
        await this.skip(instance, message, planned);
        return null;
      }
      return planned;
    });
  }

  async applyTimer(
    instance: InstanceContext,
    contact: string,
    job: TimerJob,
  ): Promise<BotWebhookCall[]> {
    return this.withRetry(instance, contact, () => this.planTimer(instance, contact, job));
  }

  private async withRetry(
    instance: InstanceContext,
    contact: string,
    plan: (fresh: boolean) => Promise<StepPlan | null>,
  ): Promise<BotWebhookCall[]> {
    for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt += 1) {
      const planned = await plan(attempt > 1);
      if (planned === null) {
        return [];
      }
      try {
        const outcome = await this.writer.write(planned);
        return await this.afterCommit.run(planned, outcome);
      } catch (error) {
        if (!(error instanceof WriteConflictError)) {
          throw error;
        }
        this.metrics.conflicts.inc({ result: 'retried' });
        await this.cache.delete(instance.instanceId, contact);
      }
    }
    this.metrics.conflicts.inc({ result: 'exhausted' });
    throw new ConversationConflictError(instance.instanceId);
  }

  private async planMessage(
    instance: InstanceContext,
    message: PendingMessage,
    fresh: boolean,
  ): Promise<StepPlan | Skip> {
    const now = new Date();
    if (now.getTime() - message.createdAt.getTime() > PENDING_MAX_AGE_MS) {
      return { skip: 'stale', conversationId: null };
    }
    if (instance.botId === null) {
      return { skip: 'no_bot', conversationId: null };
    }
    let conversation = await this.loader.load(instance, message.contact, { fresh });
    if (conversation?.handoff && !fresh) {
      // ARCH-09: a skip writes no conversation, so no version check finds a stale cache entry. A
      // handoff is rare: read PostgreSQL before the bot ignores the message.
      conversation = await this.loader.load(instance, message.contact, { fresh: true });
    }
    if (conversation?.handoff) {
      return { skip: 'handoff', conversationId: conversation.id };
    }
    try {
      return conversation && !(await this.ended(conversation))
        ? await this.continuePlan(instance, conversation, message, now)
        : await this.startPlan(instance, instance.botId, conversation, message, now);
    } catch (error) {
      await this.dataError(error, instance, conversation?.id ?? null);
      return { skip: 'engine_error', conversationId: conversation?.id ?? null };
    }
  }

  /** True when the conversation is in a final state: the next message starts a new conversation. */
  private async ended(conversation: ConversationRecord): Promise<boolean> {
    const pinned = await this.definitions.version(
      conversation.tenantId,
      conversation.botId,
      conversation.botVersion,
    );
    const state = pinned.definition.states[conversation.state];
    if (state === undefined) {
      throw new EngineStateError(
        `The state "${conversation.state}" does not exist in the definition`,
      );
    }
    return state.final;
  }

  /** A new conversation, or a new start on the row of an ended one, with the CURRENT bot version. */
  private async startPlan(
    instance: InstanceContext,
    botId: string,
    conversation: ConversationRecord | null,
    message: PendingMessage,
    now: Date,
  ): Promise<StepPlan> {
    const bot = await this.definitions.current(instance.tenantId, botId);
    const conversationId = conversation?.id ?? uuidV7(now.getTime());
    const result = startConversation(bot.definition, {
      conversationId,
      now,
      ...(conversation ? { version: conversation.version } : {}),
    });
    return this.plan({
      instance,
      contact: message.contact,
      conversationId,
      expectedVersion: conversation?.version ?? null,
      bot,
      result,
      previousMenu: null,
      messageId: message.id,
      timeoutsInRow: 0,
      now,
    });
  }

  /** A message of a running conversation, with its PINNED bot version. */
  private async continuePlan(
    instance: InstanceContext,
    conversation: ConversationRecord,
    message: PendingMessage,
    now: Date,
  ): Promise<StepPlan> {
    const bot = await this.definitions.version(
      instance.tenantId,
      conversation.botId,
      conversation.botVersion,
    );
    const input = mapMenuReply(toEngineInput(message.content), conversation.lastMenu);
    const external = this.http.externalCaller({
      conversation_id: conversation.id,
      instance_id: instance.instanceId,
      external_ref: instance.externalRef,
      contact: conversation.contact,
      bot_id: bot.botSlug,
      bot_version: bot.version,
    });
    const result = await handleInbound(bot.definition, toSnapshot(conversation), input, {
      now,
      external,
    });
    return this.plan({
      instance,
      contact: message.contact,
      conversationId: conversation.id,
      expectedVersion: conversation.version,
      bot,
      result,
      previousMenu: conversation.lastMenu,
      messageId: message.id,
      timeoutsInRow: 0,
      now,
    });
  }

  private async planTimer(
    instance: InstanceContext,
    contact: string,
    job: TimerJob,
  ): Promise<StepPlan | null> {
    const conversation = await this.loader.load(instance, contact, { fresh: true });
    if (!conversation || !isTimerTarget(conversation, job) || !instance.botId) {
      this.metrics.timers.inc({ result: 'stale' });
      return null;
    }
    const now = new Date();
    try {
      const bot = await this.definitions.version(
        instance.tenantId,
        conversation.botId,
        conversation.botVersion,
      );
      const timeoutsInRow = conversation.timeoutsInRow + 1;
      const result = this.limitTimeouts(
        handleTimeout(bot.definition, toSnapshot(conversation), {
          timerState: job.state,
          timerVersion: job.conversationVersion,
          now,
        }),
        timeoutsInRow,
        conversation.id,
      );
      this.metrics.timers.inc({ result: result.persist ? 'fired' : 'stale' });
      const plan = await this.plan({
        instance,
        contact,
        conversationId: conversation.id,
        expectedVersion: conversation.version,
        bot,
        result,
        previousMenu: conversation.lastMenu,
        messageId: null,
        timeoutsInRow,
        now,
      });
      return result.persist ? plan : null;
    } catch (error) {
      await this.dataError(error, instance, conversation.id);
      return null;
    }
  }

  /**
   * SEC-04: a timeout can go back to its own state, so a bot can send messages for ever without a user.
   * After `BOT_MAX_TIMEOUTS_IN_ROW` timeouts without an inbound message, the step arms no new timer.
   */
  private limitTimeouts(
    result: EngineResult,
    timeoutsInRow: number,
    conversationId: string,
  ): EngineResult {
    if (!result.persist || result.timer === null || timeoutsInRow < this.maxTimeoutsInRow) {
      return result;
    }
    this.metrics.timers.inc({ result: 'limit' });
    this.logger.warn(
      { conversation_id: conversationId, timeouts_in_row: timeoutsInRow },
      'state timeouts in a row reached the limit; no timer is armed until the next inbound message',
    );
    return { ...result, timer: null };
  }

  private async plan(input: PlanInput): Promise<StepPlan> {
    await this.diagnostics.report(input.result.diagnostics, {
      tenantId: input.instance.tenantId,
      conversationId: input.conversationId,
      botSlug: input.bot.botSlug,
      botVersion: input.bot.version,
    });
    return {
      instance: input.instance,
      contact: input.contact,
      conversationId: input.conversationId,
      expectedVersion: input.expectedVersion,
      bot: input.bot,
      result: input.result,
      lastMenu: menuAfterActions(input.result.actions, input.previousMenu),
      timeoutsInRow: input.timeoutsInRow,
      messageId: input.messageId,
      now: input.now,
    };
  }

  private async skip(
    instance: InstanceContext,
    message: PendingMessage,
    skip: Skip,
  ): Promise<void> {
    await this.writer.consumeOnly(instance.tenantId, message.id, skip.conversationId);
    this.metrics.skipped.inc({ reason: skip.skip });
    const log =
      skip.skip === 'stale'
        ? this.logger.warn.bind(this.logger)
        : this.logger.debug.bind(this.logger);
    log({ message_id: message.id, reason: skip.skip }, 'inbound message not given to the bot');
  }

  /** A data error (`EngineStateError`, `BotDataError`): log, alert, and skip the input. Other errors throw. */
  private async dataError(
    error: unknown,
    instance: InstanceContext,
    conversationId: string | null,
  ): Promise<void> {
    if (!(error instanceof EngineStateError) && !(error instanceof BotDataError)) {
      throw error;
    }
    this.logger.error(
      { err: error, conversation_id: conversationId },
      'bot data error; the input is skipped',
    );
    // ARCH-20: the caller holds the conversation lock; a slow Discord must not hold it.
    void this.alerts.notify({
      severity: 'warning',
      title: 'Bot data error in a conversation step',
      details: { tenant_id: instance.tenantId, conversation_id: conversationId, error: error.name },
      dedupeKey: `bot-data-error:${instance.tenantId}`,
    });
  }
}
