import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { MetricsService } from '../../metrics/metrics.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { RetryLaterError } from '../../queues/retry-later';
import { LockNotAcquiredError } from '../../services/lock.service';
import type { DistributedLockService, Lock } from '../../services/lock.service';
import { conversationLockName } from '../conversation-keys';
import { ConversationMetrics } from '../conversation-metrics';
import type { BotHttpService } from './bot-http';
import { CONVERSATION_LOCK, ConversationRuntime } from './conversation-runtime.service';
import type { ConversationStepService } from './conversation-step.service';
import type { InstanceContext, InstanceResolver } from './instance-context';

const instance: InstanceContext = {
  tenantId: 't1',
  instanceId: 'i1',
  providerName: 'inst_1',
  externalRef: 'o1',
  botId: 'b1',
};

function row(id: string) {
  return {
    id,
    contact: '5511987654321',
    content: { type: 'text', text: id },
    createdAt: new Date(),
  };
}

function build(pages: ReturnType<typeof row>[][]) {
  const findMany = vi.fn(async () => pages.shift() ?? []);
  const findUnique = vi.fn(async () => ({ instanceId: 'i1', contact: '5511987654321' }));
  const prisma = {
    forTenant: () => ({ message: { findMany }, conversation: { findUnique } }),
  } as unknown as PrismaService;
  const lock: Lock = { name: 'l', token: 't' };
  const locks = {
    withLock: vi.fn(
      async (_name: string, _options: unknown, fn: (lock: Lock) => Promise<unknown>) => fn(lock),
    ),
    extend: vi.fn(async () => true),
  };
  const steps = {
    applyMessage: vi.fn(async (_instance: unknown, message: { id: string }) => [
      { tenantId: 't1', url: `https://hook.test/${message.id}`, body: {} },
    ]),
    applyTimer: vi.fn(async () => []),
  };
  const instances = { byId: vi.fn(async () => instance) };
  const http = { callWebhooks: vi.fn(async () => undefined) };
  const runtime = new ConversationRuntime(
    prisma,
    locks as unknown as DistributedLockService,
    steps as unknown as ConversationStepService,
    instances as unknown as InstanceResolver,
    http as unknown as BotHttpService,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  return { runtime, locks, steps, http, findMany, findUnique, instances };
}

describe('ConversationRuntime.drain', () => {
  it('processes the pending rows in order under the lock, then runs the webhooks after the lock', async () => {
    const { runtime, locks, steps, http, findMany } = build([[row('a'), row('b')]]);
    await runtime.drain(instance, '5511987654321');
    expect(locks.withLock).toHaveBeenCalledWith(
      conversationLockName('i1', '5511987654321'),
      { ttlMs: CONVERSATION_LOCK.ttlMs, waitMs: CONVERSATION_LOCK.waitMs },
      expect.any(Function),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    );
    expect(steps.applyMessage.mock.calls.map((call) => (call[1] as { id: string }).id)).toEqual([
      'a',
      'b',
    ]);
    expect(locks.extend).toHaveBeenCalledTimes(2);
    expect(http.callWebhooks).toHaveBeenCalledWith([
      expect.objectContaining({ url: 'https://hook.test/a' }),
      expect.objectContaining({ url: 'https://hook.test/b' }),
    ]);
  });

  it('reads again while a page is full', async () => {
    const full = Array.from({ length: 20 }, (_, index) => row(`m${index}`));
    const { runtime, steps, findMany } = build([full, [row('last')]]);
    await runtime.drain(instance, '5511987654321');
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(steps.applyMessage).toHaveBeenCalledTimes(21);
  });

  it('turns a busy lock into RetryLaterError (not a failure)', async () => {
    const { runtime, locks, steps } = build([[row('a')]]);
    locks.withLock.mockRejectedValueOnce(new LockNotAcquiredError('x'));
    const error = await runtime.drain(instance, '5511987654321').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetryLaterError);
    expect((error as RetryLaterError).delayMs).toBe(CONVERSATION_LOCK.retryDelayMs);
    expect(steps.applyMessage).not.toHaveBeenCalled();
  });
});

describe('ConversationRuntime.fireTimer', () => {
  const job = { tenantId: 't1', conversationId: 'c1', state: 's', conversationVersion: 1 };

  it('runs the timer step under the lock of the conversation', async () => {
    const { runtime, steps, locks } = build([]);
    await runtime.fireTimer(job);
    expect(locks.withLock.mock.calls[0]?.[0]).toBe(conversationLockName('i1', '5511987654321'));
    expect(steps.applyTimer).toHaveBeenCalledWith(instance, '5511987654321', job);
  });

  it('is a no-op for a deleted conversation or instance', async () => {
    const missing = build([]);
    missing.findUnique.mockResolvedValueOnce(null as never);
    await missing.runtime.fireTimer(job);
    expect(missing.steps.applyTimer).not.toHaveBeenCalled();

    const deleted = build([]);
    deleted.instances.byId.mockResolvedValueOnce(null as never);
    await deleted.runtime.fireTimer(job);
    expect(deleted.steps.applyTimer).not.toHaveBeenCalled();
  });
});
