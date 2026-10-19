import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { MessageResponse, SendMessageRequest, UuidParam } from '@botcenter/contracts';
import { Auth } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { RequireScope } from '../auth/decorators';
import { createZodDto } from '../common/zod-dto';
import type { ZodDto } from '../common/zod-dto';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import { MessagesService } from './messages.service';

/**
 * `SendMessageRequest` is a union, and a union type cannot be the instance type of a base class. The DTO
 * class keeps the static schema for the pipe and the OpenAPI generator; the handler reads the parsed union.
 */
type UnionDtoBase = Pick<ZodDto, 'schema' | 'isZodDto'> & (new () => object);
class SendMessageBody extends (createZodDto(SendMessageRequest) as unknown as UnionDtoBase) {}
class MessageParams extends createZodDto(UuidParam) {}
class MessageResponseDto extends createZodDto(MessageResponse) {}

/** The delivery rules of the outbound path, for the OpenAPI document. */
export const SEND_DESCRIPTION = [
  'Queues one message and answers 202 at once. The worker sends it later; read the status with',
  '`GET /v1/messages/{id}` or the `message.status` webhook event.',
  '',
  '- `priority: reply` goes before `bulk` in the queue. The daily quota of the tenant',
  '  (`maxMessagesPerDay`, UTC day) counts every message of this route; 429 `QUOTA_EXCEEDED` has',
  '  `Retry-After` until 00:00 UTC.',
  '- The instance must belong to the tenant (else 403). An instance without a WhatsApp session',
  '  (`created`, `logged_out`) gives 409 `INSTANCE_NOT_CONNECTED`. A `connecting` or `disconnected`',
  '  instance accepts the message; the worker retries for about 12 minutes, then the status is',
  '  `failed` with `failure_reason: not_connected`.',
  '- Each instance has a send rate (token bucket). A new number sends slower during its first days',
  '  (warm-up). A message that waits for the rate limit stays `queued`.',
  '- Delivery is at least once. When a send times out, the provider can have sent the message, and',
  '  the retry (after 60 s or more) can send it a second time. After two such timeouts the status is',
  '  `failed` with `failure_reason: send_timeout`.',
  '- A media `url` must be a public HTTPS file. A URL that resolves to a private, loopback, link-local,',
  '  or metadata address gives 422 `MEDIA_URL_FORBIDDEN`. The worker downloads the file (no redirects,',
  '  at most 16 MiB, a WhatsApp file type in `Content-Type`) into the private bucket and sends the copy.',
  '- `failure_reason` values: `invalid_recipient`, `instance_not_found`, `rejected`, `not_connected`,',
  '  `provider_unavailable`, `send_timeout`, `instance_deleted`, `instance_not_connected`,',
  '  `media_not_found`, `media_not_uploaded`, `media_url_forbidden`, `media_download_failed`,',
  '  `media_too_large`, `media_type_not_accepted`, `internal_error`, `provider_error`.',
].join('\n');

@Controller('v1/messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @HttpCode(202)
  @RequireScope('messages:send')
  @ApiOperation({ summary: 'Queue a message', description: SEND_DESCRIPTION })
  @ApiResponse(202, { description: 'Queued', schema: MessageResponseDto })
  send(@Auth() auth: AuthContext, @Body() body: SendMessageBody) {
    return this.messages.send(auth, body as unknown as SendMessageRequest);
  }

  @Get(':id')
  @RequireScope('messages:send')
  @ApiOperation({ summary: 'Read the status of a message' })
  @ApiResponse(200, { description: 'The message', schema: MessageResponseDto })
  get(@Auth() auth: AuthContext, @Param() params: MessageParams) {
    return this.messages.get(auth, params.id);
  }
}
