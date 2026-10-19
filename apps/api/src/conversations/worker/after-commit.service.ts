import { Inject, Injectable } from '@nestjs/common';
import { OUTBOUND_MESSAGES } from '../../ports/outbound-messages.port';
import type { OutboundMessagesPort } from '../../ports/outbound-messages.port';
import { ConversationCacheService } from '../conversation-cache.service';
import { ConversationMetrics } from '../conversation-metrics';
import { ConversationTimersService } from '../conversation-timers.service';
import { BotWebhookCallsService } from '../../webhooks/bot-webhook-calls.service';
import type { StepOutcome, StepPlan } from './step-plan';

/**
 * The work after the commit of a step (engine README, steps 4 and 5): dispatch the replies and the
 * `call_webhook` rows (the `webhooks` queue sends them, ARCH-04), update the hot cache, remove the stale
 * timer, and add the new timer.
 */
@Injectable()
export class AfterCommitService {
  constructor(
    @Inject(OUTBOUND_MESSAGES) private readonly outbound: OutboundMessagesPort,
    private readonly cache: ConversationCacheService,
    private readonly timers: ConversationTimersService,
    private readonly metrics: ConversationMetrics,
    private readonly botCalls: BotWebhookCallsService,
  ) {}

  async run(plan: StepPlan, outcome: StepOutcome): Promise<void> {
    if (outcome.replies.length > 0) {
      await this.outbound.dispatch(outcome.replies);
    }
    await this.botCalls.dispatch(outcome.webhookCalls);
    await this.cache.set(outcome.record);
    const { result } = plan;
    if (result.persist) {
      if (result.cancelTimer) {
        await this.timers.cancel(result.cancelTimer.jobId);
      }
      if (result.timer) {
        await this.timers.schedule(
          result.timer,
          { tenantId: plan.instance.tenantId, conversationId: plan.conversationId },
          plan.now,
        );
      }
    }
    if (result.matched) {
      this.metrics.transitions.inc({ trigger: result.trigger });
    }
  }
}
