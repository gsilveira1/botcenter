import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { InboundHandlerRegistry } from '../../inbound/inbound-handler.registry';
import { MetricsService } from '../../metrics/metrics.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { ConversationRuntime } from './conversation-runtime.service';
import type { InboundStoreService } from './inbound-store.service';
import type { InstanceResolver } from './instance-context';
import { MessageReceivedHandler } from './message-received.handler';

const instance = {
  tenantId: 't1',
  instanceId: 'i1',
  providerName: 'inst_1',
  externalRef: 'o1',
  botId: 'b1',
};
const event = {
  kind: 'message.received' as const,
  instanceName: 'inst_1',
  dedupeKey: 'd',
  occurredAt: new Date(),
  providerMessageId: 'wamid',
  from: '5511987654321',
  content: { type: 'text' as const, text: 'Oi' },
};
const context = { jobId: 'j', attemptsMade: 0, rawEventId: null, receivedAt: new Date() };

function build(found: typeof instance | null, botPending: boolean) {
  const registry = new InboundHandlerRegistry();
  const store = { store: vi.fn(async () => ({ contact: event.from, botPending })) };
  const runtime = { drain: vi.fn(async () => undefined) };
  const handler = new MessageReceivedHandler(
    registry,
    { byProviderName: vi.fn(async () => found) } as unknown as InstanceResolver,
    store as unknown as InboundStoreService,
    runtime as unknown as ConversationRuntime,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  handler.onModuleInit();
  return { handler, registry, store, runtime };
}

describe('MessageReceivedHandler', () => {
  it('registers for message.received', () => {
    const { registry, handler } = build(instance, false);
    expect(registry.get('message.received')).toBe(handler);
  });

  it('stores the message and runs the bot step when the message waits for the bot', async () => {
    const { handler, store, runtime } = build(instance, true);
    await handler.handle(event, context);
    expect(store.store).toHaveBeenCalledWith(instance, event, context.receivedAt);
    expect(runtime.drain).toHaveBeenCalledWith(instance, event.from);
  });

  it('only stores the message without a bot step, and ignores an unknown instance', async () => {
    const stored = build(instance, false);
    await stored.handler.handle(event, context);
    expect(stored.runtime.drain).not.toHaveBeenCalled();

    const unknown = build(null, true);
    await unknown.handler.handle(event, context);
    expect(unknown.store.store).not.toHaveBeenCalled();
  });
});
