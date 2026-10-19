import { Module } from '@nestjs/common';
import { BotsApiModule } from '../bots/bots.module';
import { MediaModule } from '../media/media.module';
import { BotDefinitionsService } from './bot-definitions.service';
import { ConversationCacheService } from './conversation-cache.service';
import { ConversationMetrics } from './conversation-metrics';
import { ConversationTimersService } from './conversation-timers.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { AfterCommitService } from './worker/after-commit.service';
import { BotHttpService } from './worker/bot-http';
import { ConversationLoader } from './worker/conversation-loader.service';
import { ConversationRuntime } from './worker/conversation-runtime.service';
import { ConversationStepService } from './worker/conversation-step.service';
import { ConversationWriter } from './worker/conversation-writer.service';
import { EngineDiagnosticsReporter } from './worker/engine-diagnostics';
import { InboundMediaService } from './worker/inbound-media.service';
import { InboundStoreService } from './worker/inbound-store.service';
import { InstanceResolver } from './worker/instance-context';
import { MessageReceivedHandler } from './worker/message-received.handler';
import { TimersWorker } from './worker/timers.worker';

/** The services that both processes use. */
const SHARED = [
  ConversationMetrics,
  ConversationCacheService,
  ConversationTimersService,
  BotDefinitionsService,
];

/**
 * API process: `PUT/GET /v1/bots/{id}` (`BotsApiModule`), `GET /v1/conversations/{id}`, and
 * `POST /v1/conversations/{id}/handoff`.
 */
@Module({
  imports: [BotsApiModule],
  controllers: [ConversationsController],
  providers: [...SHARED, ConversationsService],
})
export class ConversationsApiModule {}

/**
 * Worker process: the `message.received` inbound handler and the `timers` consumer. It injects the
 * frozen ports `OUTBOUND_MESSAGES` (global `MessagesCoreModule`) and `EXTERNAL_HTTP` (webhooks slice,
 * which must export it globally). The inbound media go through `MediaStorage` of `MediaModule`.
 */
@Module({
  imports: [MediaModule],
  providers: [
    ...SHARED,
    InstanceResolver,
    InboundMediaService,
    InboundStoreService,
    ConversationLoader,
    ConversationWriter,
    AfterCommitService,
    BotHttpService,
    EngineDiagnosticsReporter,
    ConversationStepService,
    ConversationRuntime,
    MessageReceivedHandler,
    TimersWorker,
  ],
})
export class ConversationsWorkerModule {}
