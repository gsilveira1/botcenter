import { BotDefinition } from '@botcenter/contracts';
import type { EngineResult } from '@botcenter/engine';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import type { OutboundMessagesPort } from '../../ports/outbound-messages.port';
import type { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../services/outbox.service';
import type { BotWebhookCallsService } from '../../webhooks/bot-webhook-calls.service';
import { ConversationWriter } from './conversation-writer.service';
import { WriteConflictError } from './step-plan';
import type { StepPlan } from './step-plan';

const TENANT = '0199a000-0000-7000-8000-000000000001';
const INSTANCE = '0199a000-0000-7000-8000-000000000002';
const CONVERSATION = '0199a000-0000-7000-8000-000000000004';

function result(overrides: Partial<EngineResult> = {}): EngineResult {
  return {
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
    actions: [{ type: 'send_message', message: { type: 'text', text: 'Olá, Ana!' } }],
    timer: null,
    cancelTimer: null,
    diagnostics: [],
    ...overrides,
  };
}

function plan(overrides: Partial<StepPlan> = {}): StepPlan {
  return {
    instance: {
      tenantId: TENANT,
      instanceId: INSTANCE,
      providerName: 'p',
      externalRef: 'o',
      botId: 'x',
    },
    contact: '5511987654321',
    conversationId: CONVERSATION,
    expectedVersion: 4,
    bot: {
      botId: '0199a000-0000-7000-8000-000000000003',
      botSlug: 'bot',
      version: 1,
      definition: BotDefinition.parse({ initial_state: 'a', states: { a: { transitions: [] } } }),
    },
    result: result(),
    lastMenu: null,
    messageId: '0199a000-0000-7000-8000-000000000005',
    now: new Date(),
    ...overrides,
  };
}

function build() {
  const tx = {
    conversation: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({})),
    },
    conversationTransition: { create: vi.fn(async () => ({})) },
    message: { updateMany: vi.fn(async () => ({ count: 1 })) },
    outboxEvent: { create: vi.fn(async () => ({ id: 'e1' })) },
  };
  const scoped = { $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)) };
  const prisma = { forTenant: vi.fn(() => scoped) } as unknown as PrismaService;
  const outbound = {
    createInTx: vi.fn(async () => ({ messageId: 'reply-1' })),
    dispatch: vi.fn(),
  } satisfies OutboundMessagesPort;
  const botCalls = {
    createInTx: vi.fn(async (_tx: unknown, calls: unknown[]) =>
      calls.map((_call, index) => ({ id: `w${index}`, tenantId: TENANT, nextAttemptAt: null })),
    ),
  };
  const writer = new ConversationWriter(
    prisma,
    new OutboxService(),
    outbound,
    botCalls as unknown as BotWebhookCallsService,
  );
  return { writer, tx, outbound, botCalls };
}

describe('ConversationWriter', () => {
  it('writes the state with the optimistic lock, the reply, the transition, the event, and the message', async () => {
    const { writer, tx, outbound } = build();
    const outcome = await writer.write(plan());
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: CONVERSATION, tenantId: TENANT, version: 4 },
      data: expect.objectContaining({
        state: 'b',
        version: 5,
        handoff: false,
        lastMenu: Prisma.DbNull,
      }),
    });
    expect(outbound.createInTx).toHaveBeenCalledWith(tx, {
      tenantId: TENANT,
      instanceId: INSTANCE,
      to: '5511987654321',
      content: { type: 'text', text: 'Olá, Ana!' },
      priority: 'reply',
      conversationId: CONVERSATION,
      typingDelayMs: 800,
    });
    expect(tx.conversationTransition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromState: 'a', toState: 'b', trigger: 'message' }),
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'conversation.transitioned' }),
      select: { id: true },
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { id: plan().messageId, tenantId: TENANT, botPending: true },
      data: { botPending: false, conversationId: CONVERSATION },
    });
    expect(outcome.replies).toEqual([
      { tenantId: TENANT, messageId: 'reply-1', instanceId: INSTANCE },
    ]);
    expect(outcome.record).toMatchObject({ state: 'b', version: 5, variables: { nome: 'Ana' } });
  });

  it('writes each call_webhook action as a row in the step transaction (ARCH-04)', async () => {
    const { writer, tx, botCalls } = build();
    const outcome = await writer.write(
      plan({
        result: result({
          actions: [
            { type: 'call_webhook', url: 'https://hook.test/a', variables: { nome: 'Bia' } },
          ],
        }),
      }),
    );
    expect(botCalls.createInTx).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        tenantId: TENANT,
        conversationId: CONVERSATION,
        url: 'https://hook.test/a',
        payload: expect.objectContaining({ state: 'b', variables: { nome: 'Bia' } }),
      }),
    ]);
    expect(outcome.webhookCalls).toEqual([{ id: 'w0', tenantId: TENANT, nextAttemptAt: null }]);
  });

  it('throws WriteConflictError when the version changed', async () => {
    const { writer, tx, outbound } = build();
    tx.conversation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(writer.write(plan())).rejects.toBeInstanceOf(WriteConflictError);
    expect(outbound.createInTx).not.toHaveBeenCalled();
  });

  it('throws WriteConflictError when another step created the row or consumed the message', async () => {
    const created = build();
    created.tx.conversation.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7' }),
    );
    await expect(created.writer.write(plan({ expectedVersion: null }))).rejects.toBeInstanceOf(
      WriteConflictError,
    );

    const consumed = build();
    consumed.tx.message.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(consumed.writer.write(plan())).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('writes only the receive time and the message for a step without persist', async () => {
    const { writer, tx } = build();
    const outcome = await writer.write(
      plan({ result: result({ persist: false, matched: false, actions: [], version: 4 }) }),
    );
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: CONVERSATION, tenantId: TENANT },
      data: { lastInboundAt: expect.any(Date) },
    });
    expect(tx.conversationTransition.create).not.toHaveBeenCalled();
    expect(tx.message.updateMany).toHaveBeenCalled();
    expect(outcome.record.version).toBe(4);
  });
});
