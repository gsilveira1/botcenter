import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { Prisma } from '../../generated/prisma/client';
import { MetricsService } from '../../metrics/metrics.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { OutboxService } from '../../services/outbox.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { InboundMediaService } from './inbound-media.service';
import { InboundStoreService } from './inbound-store.service';

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
const stored = {
  id: 'm1',
  contact: event.from,
  conversationId: null,
  content: { type: 'text', text: 'Oi' },
  botPending: true,
};

function build(options: { existing?: boolean; handoff?: boolean } = {}) {
  const message = {
    findUnique: vi.fn(async () => (options.existing ? stored : null)),
    create: vi.fn(async () => stored),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const conversation = {
    findUnique: vi.fn(async () =>
      options.handoff === undefined ? null : { id: 'c1', handoff: options.handoff },
    ),
  };
  const scoped = {
    message,
    conversation,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ message })),
  };
  const outbox = { enqueue: vi.fn(async () => 'e1') };
  const media = { copy: vi.fn() };
  const service = new InboundStoreService(
    { forTenant: () => scoped } as unknown as PrismaService,
    outbox as unknown as OutboxService,
    media as unknown as InboundMediaService,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  return { service, message, outbox, media };
}

describe('InboundStoreService', () => {
  it('stores a text message with its receive time and writes the event in the same transaction', async () => {
    const { service, message, outbox } = build();
    const receivedAt = new Date('2026-10-19T12:00:00.000Z');
    await expect(service.store(instance, event, receivedAt)).resolves.toMatchObject({
      botPending: true,
    });
    expect(message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        direction: 'inbound',
        status: 'received',
        botPending: true,
        createdAt: receivedAt,
      }),
      select: expect.any(Object),
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 't1',
      type: 'message.received',
      payload: {
        instance_id: 'i1',
        external_ref: 'o1',
        message_id: 'm1',
        from: event.from,
        type: 'text',
        text: 'Oi',
      },
    });
  });

  it('does not give the message to the bot when the conversation is in handoff', async () => {
    const { service, message } = build({ handoff: true });
    await service.store(instance, event, new Date());
    expect(message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botPending: false, conversationId: 'c1' }),
      }),
    );
  });

  it('returns the stored row on a retry and on a unique violation, without a second event', async () => {
    const retry = build({ existing: true });
    await expect(retry.service.store(instance, event, new Date())).resolves.toMatchObject({
      messageId: 'm1',
    });
    expect(retry.message.create).not.toHaveBeenCalled();
    expect(retry.outbox.enqueue).not.toHaveBeenCalled();

    const race = build();
    race.message.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7' }),
    );
    race.message.findUnique
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(stored as never);
    await expect(race.service.store(instance, event, new Date())).resolves.toMatchObject({
      messageId: 'm1',
    });
  });

  it('gives the declared size of a media message to the media copy (ARCH-03, SEC-02)', async () => {
    const { service, message, media } = build();
    const content = {
      type: 'media',
      media_type: 'video',
      mime_type: 'video/mp4',
      file_length: 734_003_200,
      media_status: 'pending',
    };
    message.create.mockResolvedValueOnce({ ...stored, content } as never);
    media.copy.mockResolvedValueOnce({ status: 'too_large' } as never);
    await service.store(
      instance,
      {
        ...event,
        content: {
          type: 'media',
          mediaType: 'video',
          mimeType: 'video/mp4',
          fileLength: 734_003_200,
        },
      },
      new Date(),
    );
    expect(message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ content }) }),
    );
    expect(media.copy).toHaveBeenCalledWith(
      instance,
      {
        messageId: 'm1',
        providerMessageId: 'wamid',
        mimeType: 'video/mp4',
        declaredBytes: 734_003_200,
      },
      expect.any(Date),
    );
  });
});
