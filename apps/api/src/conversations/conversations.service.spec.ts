import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import type { AuthContext } from '../auth/auth-context';
import { AppError } from '../common/errors/app-error';
import { MetricsService } from '../metrics/metrics.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../services/audit.service';
import type { OutboxService } from '../services/outbox.service';
import type { BotDefinitionsService } from './bot-definitions.service';
import type { ConversationCacheService } from './conversation-cache.service';
import { ConversationMetrics } from './conversation-metrics';
import type { ConversationTimersService } from './conversation-timers.service';
import { ConversationsService } from './conversations.service';

const auth: AuthContext = {
  tenantId: 't1',
  keyId: 'k',
  keyPrefix: 'p',
  scopes: ['bots:write'],
  instanceIds: [],
};
const now = new Date();
const row = {
  id: 'c1',
  tenantId: 't1',
  instanceId: 'i1',
  contact: '5511987654321',
  botId: 'b1',
  botVersion: 1,
  state: 'inicio',
  variables: {},
  version: 2,
  handoff: false,
  lastMenu: null,
  lastInboundAt: null,
  createdAt: now,
  updatedAt: now,
  bot: { slug: 'bot' },
  instance: { externalRef: 'o1' },
  transitions: [],
};

function build(updatedCount: number, changes: Partial<typeof row> = {}, definitions: unknown = {}) {
  const tx = {
    conversation: { updateMany: vi.fn(async () => ({ count: updatedCount })) },
    conversationTransition: { create: vi.fn(async () => ({})) },
  };
  const findUnique = vi.fn(async () => ({ ...row, ...changes }));
  const prisma = {
    forTenant: () => ({
      conversation: { findUnique },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    }),
  } as unknown as PrismaService;
  const timers = { cancel: vi.fn(async () => undefined), schedule: vi.fn(async () => undefined) };
  const service = new ConversationsService(
    prisma,
    { enqueue: vi.fn(async () => 'e1') } as unknown as OutboxService,
    { record: vi.fn(async () => 'a1') } as unknown as AuditService,
    { delete: vi.fn(async () => undefined) } as unknown as ConversationCacheService,
    timers as unknown as ConversationTimersService,
    definitions as BotDefinitionsService,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  return { service, tx, timers, findUnique };
}

describe('ConversationsService.handoff', () => {
  it('retries a conflict with the worker and answers 409 CONFLICT after the last attempt', async () => {
    const { service, tx, timers } = build(0);
    const error = await service.handoff(auth, 'c1', 'human').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('CONFLICT');
    expect(tx.conversation.updateMany).toHaveBeenCalledTimes(3);
    expect(timers.cancel).not.toHaveBeenCalled();
  });

  it('removes the pending timer of the version before the handoff', async () => {
    const { service, timers, tx } = build(1);
    await service.handoff(auth, 'c1', 'human');
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', tenantId: 't1', version: 2 },
      data: { handoff: true, version: 3, timerFireAt: null },
    });
    expect(timers.cancel).toHaveBeenCalledWith('timer-c1-v2');
  });

  it('answers 403 for an instance outside the key list before any write', async () => {
    const { service, tx } = build(1);
    const restricted = { ...auth, instanceIds: ['other'] };
    await expect(service.handoff(restricted, 'c1', 'human')).rejects.toMatchObject({
      code: 'INSTANCE_NOT_ALLOWED',
    });
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('stores the fire time of the timer that a handoff to the bot arms (ARCH-08)', async () => {
    const definitions = {
      version: vi.fn(async () => ({
        definition: {
          initial_state: 'inicio',
          states: { inicio: { transitions: [], timeout: { after_seconds: 60, target: 'inicio' } } },
        },
      })),
    };
    const { service, tx, timers } = build(1, { handoff: true }, definitions);
    await service.handoff(auth, 'c1', 'bot');
    const data = (
      tx.conversation.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data).toMatchObject({ handoff: false, version: 3 });
    expect(data['timerFireAt']).toBeInstanceOf(Date);
    expect(timers.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'timer-c1-v3', fireAt: data['timerFireAt'] }),
      { tenantId: 't1', conversationId: 'c1' },
      expect.any(Date),
    );
  });
});
