import { Global, Module } from '@nestjs/common';
import { MediaApiModule, MediaModule } from '../media/media.module';
import { OUTBOUND_MESSAGES } from '../ports/outbound-messages.port';
import { MessageQuota } from './message-quota';
import { MessageStatusHandler } from './message-status.handler';
import { MessageStatusWriter } from './message-status.writer';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { OutboundMessagesService } from './outbound-messages.service';
import { InstanceLimitsCache } from './instance-limits.cache';
import { OutboundOrder } from './outbound-order';
import { OutboundRateGate } from './outbound-rate-gate';
import { OutboundSender } from './outbound-sender';
import { OutboundSweep } from './outbound-sweep';
import { OutboundWorker } from './outbound.worker';
import { InstanceTokenBucket } from './token-bucket';

/**
 * The outbound core of both processes. It is global, so the conversations slice injects
 * `OUTBOUND_MESSAGES` (frozen port) without an import, in the API process and in the worker process.
 */
@Global()
@Module({
  providers: [
    MessageQuota,
    MessageStatusWriter,
    OutboundMessagesService,
    { provide: OUTBOUND_MESSAGES, useExisting: OutboundMessagesService },
  ],
  exports: [OUTBOUND_MESSAGES, OutboundMessagesService, MessageQuota, MessageStatusWriter],
})
export class MessagesCoreModule {}

/** API process: `POST /v1/messages`, `GET /v1/messages/{id}`, and `POST /v1/media`. */
@Module({
  imports: [MessagesCoreModule, MediaModule, MediaApiModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesApiModule {}

/** Worker process: the `outbound` consumer, the sweep, and the `message.status` inbound handler. */
@Module({
  imports: [MessagesCoreModule, MediaModule],
  providers: [
    InstanceTokenBucket,
    InstanceLimitsCache,
    OutboundRateGate,
    OutboundOrder,
    OutboundSender,
    OutboundSweep,
    OutboundWorker,
    MessageStatusHandler,
  ],
})
export class MessagesWorkerModule {}
