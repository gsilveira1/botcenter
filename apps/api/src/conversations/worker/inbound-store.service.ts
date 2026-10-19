import { Inject, Injectable } from '@nestjs/common';
import type { InboundMedia } from '@botcenter/contracts';
import type { MessageReceivedEvent } from '@botcenter/whatsapp-provider';
import { ENV } from '../../config/env';
import type { AppEnv } from '../../config/env';
import { Prisma } from '../../generated/prisma/client';
import { getLogger } from '../../logging/logger';
import { PrismaService } from '../../prisma/prisma.service';
import type { TransactionClient } from '../../prisma/prisma.service';
import { QuotaService } from '../../rate-limit/quota.service';
import { OutboxService } from '../../services/outbox.service';
import { contactKey } from '../conversation-keys';
import { ConversationMetrics } from '../conversation-metrics';
import { eventContentFields, toStoredContent } from '../inbound-content';
import type { StoredInboundContent } from '../inbound-content';
import { InboundMediaService } from './inbound-media.service';
import type { InboundMediaFile, InboundMediaResult } from './inbound-media.service';
import type { InstanceContext } from './instance-context';

/** An inbound `messages` row after the store step. */
export interface StoredInbound {
  messageId: string;
  contact: string;
  conversationId: string | null;
  content: StoredInboundContent;
  /** True when the bot step of the conversation must still process the message. */
  botPending: boolean;
}

const ROW_SELECT = {
  id: true,
  contact: true,
  conversationId: true,
  content: true,
  botPending: true,
} as const;

type Row = {
  id: string;
  contact: string;
  conversationId: string | null;
  content: unknown;
  botPending: boolean;
};

interface NewRow {
  conversationId: string | null;
  botPending: boolean;
  content: StoredInboundContent;
  /** The receive time of the provider webhook: the order key of the bot step. */
  receivedAt: Date;
}

function toStored(row: Row): StoredInbound {
  return {
    messageId: row.id,
    contact: row.contact,
    conversationId: row.conversationId,
    content: row.content as StoredInboundContent,
    botPending: row.botPending,
  };
}

/**
 * Steps a, b, and c of the inbound path: store the message (always, also without a bot or in handoff),
 * copy its media, and write the `message.received` event. Every step is idempotent: a retry of the job
 * finds the row (unique `instanceId` + `providerMessageId`) and completes only the missing media step.
 * The row is inserted before the media download, so the bot step sees the messages of a conversation in
 * the order of their arrival (`createdAt` is the receive time of the provider webhook).
 */
@Injectable()
export class InboundStoreService {
  private readonly logger = getLogger('inbound-store');

  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly media: InboundMediaService,
    private readonly metrics: ConversationMetrics,
    private readonly quotas: QuotaService,
  ) {}

  async store(
    instance: InstanceContext,
    event: MessageReceivedEvent,
    receivedAt: Date,
  ): Promise<StoredInbound> {
    const stored =
      (await this.find(instance, event.providerMessageId)) ??
      (await this.insert(instance, event, receivedAt));
    if (stored.content.type === 'media' && stored.content.media_status === 'pending') {
      await this.completeMedia(instance, stored, event.providerMessageId);
    }
    return stored;
  }

  private async find(
    instance: InstanceContext,
    providerMessageId: string,
  ): Promise<StoredInbound | null> {
    const row = await this.prisma.forTenant(instance.tenantId).message.findUnique({
      where: {
        instanceId_providerMessageId: { instanceId: instance.instanceId, providerMessageId },
      },
      select: ROW_SELECT,
    });
    return row ? toStored(row) : null;
  }

  private async insert(
    instance: InstanceContext,
    event: MessageReceivedEvent,
    receivedAt: Date,
  ): Promise<StoredInbound> {
    const db = this.prisma.forTenant(instance.tenantId);
    const conversation = await db.conversation.findUnique({
      where: { instanceId_contact: { instanceId: instance.instanceId, contact: event.from } },
      select: { id: true, handoff: true },
    });
    const forBot = instance.botId !== null && conversation?.handoff !== true;
    const row: NewRow = {
      conversationId: conversation?.id ?? null,
      botPending: forBot && (await this.withinContactLimit(instance, event.from)),
      content: toStoredContent(event.content),
      receivedAt,
    };
    try {
      const stored = await db.$transaction((scoped) =>
        this.createRow(scoped as unknown as TransactionClient, instance, event, row),
      );
      this.metrics.inboundMessage();
      return stored;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A parallel attempt of the same event stored it first.
        const existing = await this.find(instance, event.providerMessageId);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * SEC-04: at most `BOT_INBOUND_LIMIT_PER_MINUTE` messages of one contact on one instance in one minute
   * go to the bot. Above it, the message is stored and sent to the client, but the bot does not run
   * (log and metric). A Redis error allows the message (the bot stays available).
   */
  private async withinContactLimit(instance: InstanceContext, contact: string): Promise<boolean> {
    try {
      const quota = await this.quotas.consume({
        name: 'bot-inbound-contact',
        subject: `${instance.instanceId}:${contactKey(contact)}`,
        window: 'minute',
        limit: this.env.BOT_INBOUND_LIMIT_PER_MINUTE,
      });
      if (quota.allowed) {
        return true;
      }
      this.metrics.skipped.inc({ reason: 'rate_limited' });
      this.logger.warn(
        { limit_per_minute: quota.limit },
        'inbound messages of a contact passed the limit; the bot does not run for this message',
      );
      return false;
    } catch (error) {
      this.logger.warn({ err: error }, 'inbound contact limit not checked; the bot runs');
      return true;
    }
  }

  /** The row and, for a message without media, its `message.received` event (one transaction). */
  private async createRow(
    tx: TransactionClient,
    instance: InstanceContext,
    event: MessageReceivedEvent,
    row: NewRow,
  ): Promise<StoredInbound> {
    const created = await tx.message.create({
      data: {
        tenantId: instance.tenantId,
        instanceId: instance.instanceId,
        conversationId: row.conversationId,
        direction: 'inbound',
        type: row.content.type,
        status: 'received',
        contact: event.from,
        content: row.content as unknown as Prisma.InputJsonObject,
        providerMessageId: event.providerMessageId,
        botPending: row.botPending,
        createdAt: row.receivedAt,
      },
      select: ROW_SELECT,
    });
    const stored = toStored(created);
    if (row.content.type !== 'media') {
      await this.writeEvent(tx, instance, stored, undefined);
    }
    return stored;
  }

  private async completeMedia(
    instance: InstanceContext,
    stored: StoredInbound,
    providerMessageId: string,
  ): Promise<void> {
    if (stored.content.type !== 'media') {
      return;
    }
    const now = new Date();
    const result = await this.media.copy(
      instance,
      mediaFile(stored.messageId, providerMessageId, stored.content),
      now,
    );
    const content: StoredInboundContent = {
      ...stored.content,
      media_status: result.status,
      ...(result.status === 'stored' ? { media_id: result.mediaId } : {}),
    };
    await this.prisma.forTenant(instance.tenantId).$transaction(async (scoped) => {
      const tx = scoped as unknown as TransactionClient;
      const updated = await tx.message.updateMany({
        where: {
          id: stored.messageId,
          tenantId: instance.tenantId,
          content: { path: ['media_status'], equals: 'pending' },
        },
        data: { content: content as unknown as Prisma.InputJsonObject },
      });
      if (updated.count !== 1) {
        return;
      }
      await this.writeEvent(tx, instance, { ...stored, content }, mediaOf(result));
    });
    stored.content = content;
  }

  private async writeEvent(
    tx: TransactionClient,
    instance: InstanceContext,
    stored: StoredInbound,
    media: InboundMedia | undefined,
  ): Promise<void> {
    await this.outbox.enqueue(tx, {
      tenantId: instance.tenantId,
      type: 'message.received',
      payload: {
        instance_id: instance.instanceId,
        external_ref: instance.externalRef,
        message_id: stored.messageId,
        from: stored.contact,
        ...eventContentFields(stored.content),
        ...(media ? { media } : {}),
        ...(stored.conversationId ? { conversation_id: stored.conversationId } : {}),
      },
    });
  }
}

/** The media copy input of a stored inbound media row. */
function mediaFile(
  messageId: string,
  providerMessageId: string,
  content: Extract<StoredInboundContent, { type: 'media' }>,
): InboundMediaFile {
  return {
    messageId,
    providerMessageId,
    mimeType: content.mime_type,
    ...(content.file_name === undefined ? {} : { fileName: content.file_name }),
    ...(content.file_length === undefined ? {} : { declaredBytes: content.file_length }),
  };
}

function mediaOf(result: InboundMediaResult): InboundMedia | undefined {
  return result.status === 'stored' ? result.event : undefined;
}
