import { Inject, Injectable } from '@nestjs/common';
import { OUTBOUND_MESSAGES } from '../../ports/outbound-messages.port';
import type { OutboundMessagesPort } from '../../ports/outbound-messages.port';
import { ConversationCacheService } from '../conversation-cache.service';
import { ConversationMetrics } from '../conversation-metrics';
import { ConversationTimersService } from '../conversation-timers.service';
import { conversationContext } from './bot-http';
import type { BotWebhookCall } from './bot-http';
import type { StepOutcome, StepPlan } from './step-plan';

/**
 * The work after the commit of a step (engine README, steps 4 and 5): dispatch the replies, update the
 * hot cache, remove the stale timer, and add the new timer. It returns the `call_webhook` actions: the
 * caller runs them after the conversation lock (never inside the transaction or the lock).
 */
@Injectable()
export class AfterCommitService {
  constructor(
    @Inject(OUTBOUND_MESSAGES) private readonly outbound: OutboundMessagesPort,
    private readonly cache: ConversationCacheService,
    private readonly timers: ConversationTimersService,
    private readonly metrics: ConversationMetrics,
  ) {}

  async run(plan: StepPlan, outcome: StepOutcome): Promise<BotWebhookCall[]> {
    if (outcome.replies.length > 0) {
      await this.outbound.dispatch(outcome.replies);
    }
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
    return this.webhookCalls(plan, outcome);
  }

  private webhookCalls(plan: StepPlan, outcome: StepOutcome): BotWebhookCall[] {
    const calls: BotWebhookCall[] = [];
    for (const action of plan.result.actions) {
      if (action.type === 'call_webhook') {
        calls.push({
          tenantId: plan.instance.tenantId,
          url: action.url,
          body: conversationContext(
            plan.instance,
            { ...outcome.record, variables: action.variables },
            plan.bot,
          ),
        });
      }
    }
    return calls;
  }
}
