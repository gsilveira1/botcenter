import { Module } from '@nestjs/common';
import { BotsController } from './bots.controller';
import { BotsService } from './bots.service';

/** API process: `PUT /v1/bots/{id}` and `GET /v1/bots/{id}`. `ConversationsApiModule` imports it. */
@Module({
  controllers: [BotsController],
  providers: [BotsService],
})
export class BotsApiModule {}
