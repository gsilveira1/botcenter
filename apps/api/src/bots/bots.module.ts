import { Module } from '@nestjs/common';
import { BotsController } from './bots.controller';
import { BotWebhookCallsModule } from '../webhooks/webhooks.module';
import { BotsService } from './bots.service';

/**
 * API process: `PUT /v1/bots/{id}`, `GET /v1/bots/{id}`, and `POST /v1/bots/{id}/rotate-secret`.
 * `ConversationsApiModule` imports it. `BotWebhookCallsModule` gives `WebhookSecrets`.
 */
@Module({
  imports: [BotWebhookCallsModule],
  controllers: [BotsController],
  providers: [BotsService],
})
export class BotsApiModule {}
