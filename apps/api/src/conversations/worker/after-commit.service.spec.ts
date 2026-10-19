import { BotDefinition } from '@botcenter/contracts';
import type { EngineResult } from '@botcenter/engine';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { MetricsService } from '../../metrics/metrics.service';
import type { OutboundMessagesPort } from '../../ports/outbound-messages.port';
import type { ConversationCacheService } from '../conversation-cache.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { ConversationTimersService } from '../conversation-timers.service';
import { AfterCommitService } from './after-commit.service';
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
  const service = new AfterCommitService(
    outbound as unknown as OutboundMessagesPort,
    cache as unknown as ConversationCacheService,
    timers as unknown as ConversationTimersService,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  return { service, outbound, cache, timers };
}

describe('AfterCommitService', () => {
  it('dispatches, caches, moves the timer, and returns the webhook calls with the action variables', async () => {
    const { service, outbound, cache, timers } = build();
    const step = plan({});
    const replies = [{ tenantId: 't1', messageId: 'm1', instanceId: 'i1' }];
    const calls = await service.run(step, { record: recordAfter(step), replies });
    expect(outbound.dispatch).toHaveBeenCalledWith(replies);
    expect(cache.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'b', version: 5 }));
    expect(timers.cancel).toHaveBeenCalledWith('timer-c1-v4');
    expect(timers.schedule).toHaveBeenCalledWith(
      timer,
      { tenantId: 't1', conversationId: 'c1' },
      step.now,
    );
    expect(calls).toEqual([
      {
        tenantId: 't1',
        url: 'https://hook.test',
        body: expect.objectContaining({
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
    await service.run(step, { record: recordAfter(step), replies: [] });
    expect(outbound.dispatch).not.toHaveBeenCalled();
    expect(timers.cancel).not.toHaveBeenCalled();
    expect(timers.schedule).not.toHaveBeenCalled();
  });
});
