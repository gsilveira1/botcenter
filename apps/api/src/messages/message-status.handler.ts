import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InboundHandlerRegistry } from '../inbound/inbound-handler.registry';
import type {
  InboundHandler,
  InboundJobContext,
  ProviderEventOf,
} from '../inbound/inbound-handler.registry';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { canMoveStatus } from './message-status';
import type { MessageStatus } from '@botcenter/contracts';
import { MessageStatusWriter } from './message-status.writer';
import type { StatusChange } from './message-status.writer';

type StatusEvent = ProviderEventOf<'message.status'>;

/**
 * The provider sends the first status webhooks while the outbound worker still writes `sent` and the
 * provider message id. The handler retries an unknown message on the first runs of the inbound job
 * (backoff 1 s, 2 s, 4 s), and only for a young event. Then it ends the job (no failure, no alert).
 */
export const UNKNOWN_MESSAGE_RETRIES = 3;
export const UNKNOWN_MESSAGE_MAX_AGE_MS = 60_000;

/** Thrown to retry the inbound job: the message can still get its provider id. */
export class StatusTargetNotReadyError extends Error {
  constructor() {
    super('No outbound message with this provider id yet; the job retries');
    this.name = 'StatusTargetNotReadyError';
  }
}

function toChange(event: StatusEvent): StatusChange {
  if (event.status === 'failed') {
    return { status: 'failed', reason: 'provider_error', at: event.occurredAt };
  }
  if (event.status === 'sent') {
    return { status: 'sent', providerMessageId: event.providerMessageId, at: event.occurredAt };
  }
  return { status: event.status, at: event.occurredAt };
}

/**
 * The `message.status` events of the provider (`messages.update` of Evolution): `sent`, `delivered`,
 * `read`, and `failed`. The status moves only forward, so a late or repeated event does nothing.
 * An event for an unknown message is retried a short time (see `UNKNOWN_MESSAGE_RETRIES`). After that
 * (for example a message that the phone sent outside the Bot Center), it is logged at `debug`, counted
 * as `botcenter_inbound_events_total{result="unknown_message"}`, and the job ends.
 */
@Injectable()
export class MessageStatusHandler implements InboundHandler<'message.status'>, OnModuleInit {
  private readonly logger = getLogger('message-status');

  constructor(
    private readonly registry: InboundHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly writer: MessageStatusWriter,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.registry.register('message.status', this);
  }

  async handle(event: StatusEvent, context: InboundJobContext, now = new Date()): Promise<void> {
    // The provider name finds the tenant; the next query is filtered by it.
    const instance = await this.prisma.instance.findUnique({
      where: { providerName: event.instanceName },
      select: { id: true, tenantId: true, externalRef: true },
    });
    const message = instance
      ? await this.prisma.forTenant(instance.tenantId).message.findFirst({
          where: {
            instanceId: instance.id,
            providerMessageId: event.providerMessageId,
            direction: 'outbound',
          },
          select: { id: true, status: true },
        })
      : null;
    if (instance && !message && isYoung(context, now)) {
      throw new StatusTargetNotReadyError();
    }
    if (!instance || !message) {
      this.logger.debug({ status: event.status }, 'status event for an unknown message; ignored');
      this.metrics.inboundEventsTotal.inc({ result: 'unknown_message' });
      return;
    }
    if (!canMoveStatus(message.status as MessageStatus, event.status)) {
      this.logger.debug(
        { from: message.status, to: event.status },
        'status event does not move the status forward; ignored',
      );
      return;
    }
    await this.writer.apply(
      {
        messageId: message.id,
        tenantId: instance.tenantId,
        instanceId: instance.id,
        externalRef: instance.externalRef,
      },
      toChange(event),
    );
  }
}

function isYoung(context: InboundJobContext, now: Date): boolean {
  return (
    context.attemptsMade < UNKNOWN_MESSAGE_RETRIES &&
    now.getTime() - context.receivedAt.getTime() < UNKNOWN_MESSAGE_MAX_AGE_MS
  );
}
