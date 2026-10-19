import { BotDefinition } from '@botcenter/contracts';
import type { EngineResult } from '@botcenter/engine';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { MetricsService } from '../../metrics/metrics.service';
import type { OutboundMessagesPort } from '../../ports/outbound-messages.port';
import type { ConversationCacheService } from '../conversation-cache.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { ConversationTimersService } from '../conversation-timers.service';
import type { BotWebhookCallsService } from '../../webhooks/bot-webhook-calls.service';
import { AfterCommitService } from './after-commit.service';
import { botWebhookCalls } from './bot-http';
import { recordAfter } from './step-plan';
import type { StepPlan } from './step-plan';

const timer = { state: 'b', version: 5, jobId: 'timer-c1-v5', fireAt: new Date() };

function plan(result: Partial<EngineResult>): StepPlan {
  return {
    instance: {
      tenantId: 't1',
      instanceId: 'i1',
      providerName: 'p',
      externalRef: 'o1',
      botId: 'b',
    },
    contact: '5511987654321',
    conversationId: 'c1',
    expectedVersion: 4,
    bot: {
      botId: 'b',
      botSlug: 'bot',
      version: 1,
      definition: BotDefinition.parse({ initial_state: 'a', states: { a: { transitions: [] } } }),
    },
    result: {
      trigger: 'message',
      matched: true,
      persist: true,
      fromState: 'a',
      toState: 'b',
      transitionIndex: 0,
      ended: false,
      handoff: false,
      version: 5,
      variables: { nome: 'Ana' },
      actions: [{ type: 'call_webhook', url: 'https://hook.test', variables: { nome: 'Bia' } }],
      timer,
      cancelTimer: { state: 'a', jobId: 'timer-c1-v4' },
      diagnostics: [],
      ...result,
    },
    lastMenu: null,
    messageId: null,
    now: new Date(),
  };
}

function build() {
  const outbound = { createInTx: vi.fn(), dispatch: vi.fn(async () => undefined) };
  const cache = { set: vi.fn(async () => undefined) };
  const timers = { cancel: vi.fn(async () => undefined), schedule: vi.fn(async () => undefined) };
  const botCalls = { dispatch: vi.fn(async () => undefined) };
  const service = new AfterCommitService(
    outbound as unknown as OutboundMessagesPort,
    cache as unknown as ConversationCacheService,
    timers as unknown as ConversationTimersService,
    new ConversationMetrics(new MetricsService(testEnv())),
    botCalls as unknown as BotWebhookCallsService,
  );
  return { service, outbound, cache, timers, botCalls };
}

const callRef = { id: 'w1', tenantId: 't1', nextAttemptAt: new Date() };

describe('AfterCommitService', () => {
  it('dispatches the replies and the webhook call rows, caches, and moves the timer', async () => {
    const { service, outbound, cache, timers, botCalls } = build();
    const step = plan({});
    const replies = [{ tenantId: 't1', messageId: 'm1', instanceId: 'i1' }];
    await service.run(step, { record: recordAfter(step), replies, webhookCalls: [callRef] });
    expect(outbound.dispatch).toHaveBeenCalledWith(replies);
    expect(botCalls.dispatch).toHaveBeenCalledWith([callRef]);
    expect(cache.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'b', version: 5 }));
    expect(timers.cancel).toHaveBeenCalledWith('timer-c1-v4');
    expect(timers.schedule).toHaveBeenCalledWith(
      timer,
      { tenantId: 't1', conversationId: 'c1' },
      step.now,
    );
  });

  it('builds one call row for each call_webhook action, with the variables of the action', () => {
    const step = plan({});
    expect(botWebhookCalls(step, recordAfter(step))).toEqual([
      {
        tenantId: 't1',
        botId: step.bot.botId,
        conversationId: 'c1',
        url: 'https://hook.test',
        payload: expect.objectContaining({
          conversation_id: 'c1',
          state: 'b',
          variables: { nome: 'Bia' },
        }),
      },
    ]);
  });

  it('does not touch the timers or dispatch for a step without persist and replies', async () => {
    const { service, outbound, timers } = build();
    const step = plan({ persist: false, matched: false, actions: [] });
    await service.run(step, { record: recordAfter(step), replies: [], webhookCalls: [] });
    expect(outbound.dispatch).not.toHaveBeenCalled();
    expect(timers.cancel).not.toHaveBeenCalled();
    expect(timers.schedule).not.toHaveBeenCalled();
  });
});
