import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ConversationResponse, HandoffRequest, UuidParam } from '@botcenter/contracts';
import { Auth } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { RequireScope } from '../auth/decorators';
import { createZodDto } from '../common/zod-dto';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import { ConversationsService } from './conversations.service';

class ConversationParams extends createZodDto(UuidParam) {}
class HandoffBody extends createZodDto(HandoffRequest) {}
class ConversationResponseDto extends createZodDto(ConversationResponse) {}

@Controller('v1/conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get(':id')
  @RequireScope('bots:write')
  @ApiOperation({
    summary: 'Read a conversation',
    description: 'The state, the variables, and the last 50 transitions (most recent first).',
  })
  @ApiResponse(200, { description: 'The conversation', schema: ConversationResponseDto })
  get(@Auth() auth: AuthContext, @Param() params: ConversationParams) {
    return this.conversations.get(auth, params.id);
  }

  @Post(':id/handoff')
  @HttpCode(200)
  @RequireScope('bots:write')
  @ApiOperation({
    summary: 'Move a conversation to a human or give it back to the bot',
    description:
      '`human` stops the bot and removes the pending state timer. `bot` gives the conversation back to ' +
      'the bot and starts the timer of the current state again. A request that changes nothing ' +
      'returns the conversation without a new transition.',
  })
  @ApiResponse(200, {
    description: 'The conversation after the handoff',
    schema: ConversationResponseDto,
  })
  handoff(
    @Auth() auth: AuthContext,
    @Param() params: ConversationParams,
    @Body() body: HandoffBody,
  ) {
    return this.conversations.handoff(auth, params.id, body.to);
  }
}
