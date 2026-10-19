import { Injectable } from '@nestjs/common';
import type { MessageContent, MessageResponse, SendMessageRequest } from '@botcenter/contracts';
import { allowsAllInstances, assertInstanceAllowed } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { AppError, notFound } from '../common/errors/app-error';
import { MediaService } from '../media/media.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { MessageQuota } from './message-quota';
import { MESSAGE_RESPONSE_SELECT, toMessageResponse } from './message-response';
import { OutboundMessagesService, outboundMessageData } from './outbound-messages.service';

/**
 * Instance statuses that refuse a new message: the instance has no WhatsApp session, and only the end
 * user can make a new one. `connecting` and `disconnected` accept the message: the provider reconnects,
 * and the worker retries the send (see `retry-policy.ts`).
 */
const REFUSED_INSTANCE_STATUSES: ReadonlySet<string> = new Set(['created', 'logged_out']);

/** `POST /v1/messages` and `GET /v1/messages/{id}`. */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundMessagesService,
    private readonly quota: MessageQuota,
    private readonly media: MediaService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Checks the instance, the media, and the daily quota, writes the row `queued`, and adds the job.
   * An enqueue error does not change the answer (202): the sweep of the worker sends the message later.
   */
  async send(auth: AuthContext, request: SendMessageRequest): Promise<MessageResponse> {
    assertInstanceAllowed(auth, request.instance_id);
    await this.assertInstanceUsable(auth.tenantId, request.instance_id);
    const { instance_id: instanceId, to, priority, ...content } = request;
    if (content.type === 'media') {
      await this.media.assertSendable(auth.tenantId, content);
    }
    const refund = await this.quota.consume(auth.tenantId);
    let row;
    try {
      row = await this.prisma.forTenant(auth.tenantId).message.create({
        data: outboundMessageData({
          tenantId: auth.tenantId,
          instanceId,
          to,
          priority,
          content: content as MessageContent,
        }),
        select: MESSAGE_RESPONSE_SELECT,
      });
    } catch (error) {
      await refund();
      throw error;
    }
    this.metrics.messagesTotal.inc({ status: 'queued' });
    await this.outbound.enqueue([
      { tenantId: auth.tenantId, messageId: row.id, instanceId, priority },
    ]);
    return toMessageResponse(row);
  }

  /** An outbound message of the tenant. A key with an instance list sees only those instances. */
  async get(auth: AuthContext, id: string): Promise<MessageResponse> {
    const row = await this.prisma.forTenant(auth.tenantId).message.findFirst({
      where: {
        id,
        direction: 'outbound',
        ...(allowsAllInstances(auth) ? {} : { instanceId: { in: auth.instanceIds } }),
      },
      select: MESSAGE_RESPONSE_SELECT,
    });
    if (!row) {
      throw notFound('Message');
    }
    return toMessageResponse(row);
  }

  /**
   * An instance of another tenant, an unknown instance, and a deleted instance give 403 (plan, section 4).
   * An instance without a session gives 409 `INSTANCE_NOT_CONNECTED`.
   */
  private async assertInstanceUsable(tenantId: string, instanceId: string): Promise<void> {
    const instance = await this.prisma.forTenant(tenantId).instance.findFirst({
      where: { id: instanceId, deletedAt: null },
      select: { status: true },
    });
    if (!instance) {
      throw new AppError('INSTANCE_NOT_ALLOWED', 'The instance does not exist for this tenant');
    }
    if (REFUSED_INSTANCE_STATUSES.has(instance.status)) {
      throw new AppError(
        'INSTANCE_NOT_CONNECTED',
        `The instance has no WhatsApp session (status ${instance.status}). Connect it first.`,
      );
    }
  }
}
