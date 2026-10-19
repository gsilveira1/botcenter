import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { BotIdParam, BotResponse, ProblemDetails } from '@botcenter/contracts';
import { Auth } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { RequireScope } from '../auth/decorators';
import { createZodDto } from '../common/zod-dto';
import { SkipIdempotency } from '../idempotency/idempotency.interceptor';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import { PutBotBodySchema } from './bot-request';
import { BotsService } from './bots.service';

class BotParams extends createZodDto(BotIdParam) {}
class PutBotBody extends createZodDto(PutBotBodySchema) {}
class BotResponseDto extends createZodDto(BotResponse) {}

@Controller('v1/bots')
export class BotsController {
  constructor(private readonly bots: BotsService) {}

  @Put(':id')
  @HttpCode(200)
  @RequireScope('bots:write')
  @SkipIdempotency()
  @ApiOperation({
    summary: 'Create a bot or publish a new version of its definition',
    description:
      '`{id}` is a slug that the client chooses. A new version is published only when the definition ' +
      'changed. Open conversations stay on their version; new conversations use the new version. ' +
      '`instance_ids` is the full list of instances that the bot serves (an instance has at most one ' +
      'bot; an instance of another bot moves to this bot). A definition that is not valid gives 422 ' +
      '`BOT_DEFINITION_INVALID` with one error for each path. A key with an instance list gets 403 ' +
      '`INSTANCE_NOT_ALLOWED` when the bot serves an instance outside that list. The response of the ' +
      'create has `signing_secret` one time: it signs the `external` and `call_webhook` requests of ' +
      'the bot like a webhook. This route ignores Idempotency-Key, because the response can contain ' +
      'the secret.',
  })
  @ApiResponse(200, { description: 'The bot with its current version', schema: BotResponseDto })
  @ApiResponse(422, {
    description: 'The definition is not valid (`BOT_DEFINITION_INVALID`, `errors` has the paths)',
    schema: { name: 'ProblemDetails', schema: ProblemDetails },
  })
  put(@Auth() auth: AuthContext, @Param() params: BotParams, @Body() body: PutBotBody) {
    return this.bots.put(auth, params.id, body);
  }

  @Get(':id')
  @RequireScope('bots:write')
  @ApiOperation({
    summary: 'Read a bot and its current version',
    description:
      'A key with an instance list gets 403 `INSTANCE_NOT_ALLOWED` when the bot serves an instance ' +
      'outside that list.',
  })
  @ApiResponse(200, { description: 'The bot with its current version', schema: BotResponseDto })
  get(@Auth() auth: AuthContext, @Param() params: BotParams) {
    return this.bots.get(auth, params.id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @RequireScope('bots:write')
  @SkipIdempotency()
  @ApiOperation({
    summary: 'Rotate the signing secret of a bot',
    description:
      'Returns a new `signing_secret` one time. For 24 h, each `external` and `call_webhook` request ' +
      'of the bot has two v1= signatures (new and old). This route ignores Idempotency-Key, because the ' +
      'response contains the secret.',
  })
  @ApiResponse(200, { description: 'Rotated', schema: BotResponseDto })
  rotateSecret(@Auth() auth: AuthContext, @Param() params: BotParams) {
    return this.bots.rotateSecret(auth, params.id);
  }
}
