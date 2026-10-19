import { Controller, Get, Param, Res } from '@nestjs/common';
import { ConnectEvent } from '@botcenter/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ConnectTokenAuth } from '../auth/auth-context';
import type { ConnectTokenContext } from '../auth/auth-context';
import { ConnectToken } from '../auth/decorators';
import { createZodDto } from '../common/zod-dto';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import { ConnectStreamService } from './connect-stream.service';

class ConnectTokenParams extends createZodDto(z.object({ token: z.string().min(32).max(256) })) {}

@Controller('v1/connect')
export class ConnectEventsController {
  constructor(private readonly streams: ConnectStreamService) {}

  @Get(':token/events')
  @ConnectToken()
  @ApiOperation({
    summary: 'Stream the connect events (Server-Sent Events)',
    tags: ['instances'],
    description:
      'Open it in the browser with `EventSource`. The token is the authorization (one use: a second open ' +
      'gets 401 `CONNECT_TOKEN_INVALID`). The first events are the latest `qrcode` or `pairing_code` and ' +
      'the current `status`; new codes and statuses follow. The stream closes after `status` ' +
      '`connected` or `logged_out`, and after `expired` (the end of the token). A comment line comes ' +
      'every 15 s. Close the `EventSource` after the last event: a reconnect gets 401. CORS: only the ' +
      'origins in `CONNECT_ALLOWED_ORIGINS`.',
  })
  @ApiResponse(200, {
    description: 'A stream of `ConnectEvent` (`event:` is the type, `data:` is the JSON)',
    schema: { name: 'ConnectEvent', schema: ConnectEvent },
    contentType: 'text/event-stream',
  })
  async events(
    @ConnectTokenAuth() context: ConnectTokenContext,
    @Param() _params: ConnectTokenParams,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.streams.stream(context, reply);
  }
}
