import { Module } from '@nestjs/common';
import { ConversationsApiModule } from './conversations/conversations.module';
import { WebhooksApiModule } from './webhooks/webhooks.module';
import { InstancesApiModule } from './instances/instances.module';
import { ApiCoreModule } from './core/api-core.module';
import { CoreModule } from './core/core.module';
import { InboundApiModule } from './inbound/inbound.module';
import { MessagesApiModule } from './messages/messages.module';

/**
 * Root module of the API process (`ROLE=api`, `src/main.ts`).
 * Only the orchestrator edits this file: it adds the `*ApiModule` of each wave 2 slice to `imports`.
 */
@Module({
  imports: [
    CoreModule,
    ApiCoreModule,
    InboundApiModule,
    MessagesApiModule,
    InstancesApiModule,
    WebhooksApiModule,
    ConversationsApiModule,
  ],
})
export class AppModule {}
