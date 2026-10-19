import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { OUTBOUND_MESSAGES } from '../../ports/outbound-messages.port';
import type { OutboundMessagesPort } from '../../ports/outbound-messages.port';
import { PrismaService } from '../../prisma/prisma.service';
import type { TransactionClient } from '../../prisma/prisma.service';
import { OutboxService } from '../../services/outbox.service';
import { BotWebhookCallsService } from '../../webhooks/bot-webhook-calls.service';
import { recordTransition } from '../conversation-transition';
import { typingDelayMs } from '../typing-delay';
import { botWebhookCalls } from './bot-http';
import { WriteConflictError, recordAfter } from './step-plan';
import type { StepOutcome, StepPlan, WrittenReply } from './step-plan';

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * Writes one engine step in ONE transaction: the conversation (optimistic lock on `version`), the
 * transition row, the bot replies (`OUTBOUND_MESSAGES.createInTx`, priority `reply`, typing delay), the
 * `conversation.transitioned` event, the `call_webhook` rows (ARCH-04), and the consumed inbound row.
 * A changed `version` throws
 * `WriteConflictError` and the transaction rolls back.
 */
@Injectable()
export class ConversationWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @Inject(OUTBOUND_MESSAGES) private readonly outbound: OutboundMessagesPort,
    private readonly botCalls: BotWebhookCallsService,
  ) {}

  async write(plan: StepPlan): Promise<StepOutcome> {
    return this.prisma.forTenant(plan.instance.tenantId).$transaction(async (scoped) => {
      const tx = scoped as unknown as TransactionClient;
      await this.writeConversation(tx, plan);
      const replies = await this.writeReplies(tx, plan);
      if (plan.result.matched) {
        await recordTransition(tx, this.outbox, {
          tenantId: plan.instance.tenantId,
          conversationId: plan.conversationId,
          instanceId: plan.instance.instanceId,
          externalRef: plan.instance.externalRef,
          contact: plan.contact,
          botSlug: plan.bot.botSlug,
          botVersion: plan.bot.version,
          fromState: plan.result.fromState,
          toState: plan.result.toState,
          trigger: plan.result.trigger,
          handoff: plan.result.handoff,
        });
      }
      const record = recordAfter(plan);
      const webhookCalls = await this.botCalls.createInTx(tx, botWebhookCalls(plan, record));
      if (plan.messageId !== null) {
        await this.consume(tx, plan.instance.tenantId, plan.messageId, plan.conversationId);
      }
      return { record, replies, webhookCalls };
    });
  }

  /** Marks an inbound row as processed without an engine step (handoff, no bot, stale, or a data error). */
  async consumeOnly(
    tenantId: string,
    messageId: string,
    conversationId: string | null,
  ): Promise<void> {
    await this.prisma.forTenant(tenantId).message.updateMany({
      where: { id: messageId, botPending: true },
      data: { botPending: false, ...(conversationId ? { conversationId } : {}) },
    });
  }

  /** True when the inbound row still waits for its bot step (a retry checks it after a conflict). */
  async isPending(tenantId: string, messageId: string): Promise<boolean> {
    const row = await this.prisma.forTenant(tenantId).message.findFirst({
      where: { id: messageId, botPending: true },
      select: { id: true },
    });
    return row !== null;
  }

  private async writeConversation(tx: TransactionClient, plan: StepPlan): Promise<void> {
    const { result, instance } = plan;
    const lastInboundAt = plan.messageId === null ? {} : { lastInboundAt: plan.now };
    if (!result.persist) {
      await tx.conversation.updateMany({
        where: { id: plan.conversationId, tenantId: instance.tenantId },
        data: lastInboundAt,
      });
      return;
    }
    const data = {
      botId: plan.bot.botId,
      botVersion: plan.bot.version,
      state: result.toState,
      variables: json(result.variables),
      version: result.version,
      handoff: result.handoff,
      lastMenu: plan.lastMenu === null ? Prisma.DbNull : json(plan.lastMenu),
      ...lastInboundAt,
    };
    if (plan.expectedVersion === null) {
      await this.create(tx, plan, data);
      return;
    }
    const updated = await tx.conversation.updateMany({
      where: {
        id: plan.conversationId,
        tenantId: instance.tenantId,
        version: plan.expectedVersion,
      },
      data,
    });
    if (updated.count !== 1) {
      throw new WriteConflictError('The conversation version changed');
    }
  }

  private async create(
    tx: TransactionClient,
    plan: StepPlan,
    data: Omit<
      Prisma.ConversationUncheckedCreateInput,
      'id' | 'tenantId' | 'instanceId' | 'contact'
    >,
  ): Promise<void> {
    try {
      // A unique violation means that another step created the row (the lock expired): roll back.
      await tx.conversation.create({
        data: {
          ...data,
          id: plan.conversationId,
          tenantId: plan.instance.tenantId,
          instanceId: plan.instance.instanceId,
          contact: plan.contact,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new WriteConflictError('Another step created the conversation');
      }
      throw error;
    }
  }

  private async writeReplies(tx: TransactionClient, plan: StepPlan): Promise<WrittenReply[]> {
    const replies: WrittenReply[] = [];
    for (const action of plan.result.actions) {
      if (action.type !== 'send_message') {
        continue;
      }
      const { messageId } = await this.outbound.createInTx(tx, {
        tenantId: plan.instance.tenantId,
        instanceId: plan.instance.instanceId,
        to: plan.contact,
        content: action.message,
        priority: 'reply',
        conversationId: plan.conversationId,
        typingDelayMs: typingDelayMs(action.message),
      });
      replies.push({
        tenantId: plan.instance.tenantId,
        messageId,
        instanceId: plan.instance.instanceId,
      });
    }
    return replies;
  }

  private async consume(
    tx: TransactionClient,
    tenantId: string,
    messageId: string,
    conversationId: string,
  ): Promise<void> {
    const updated = await tx.message.updateMany({
      where: { id: messageId, tenantId, botPending: true },
      data: { botPending: false, conversationId },
    });
    if (updated.count !== 1) {
      throw new WriteConflictError('Another step processed the inbound message');
    }
  }
}
