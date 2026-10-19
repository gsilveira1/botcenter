import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { CreateMediaUploadRequest, CreateMediaUploadResponse } from '@botcenter/contracts';
import { Auth } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { RequireScope } from '../auth/decorators';
import { createZodDto } from '../common/zod-dto';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import { MEDIA_CONTENT_TYPES } from './media-types';
import { MediaService } from './media.service';

class CreateMediaUploadBody extends createZodDto(CreateMediaUploadRequest) {}
class CreateMediaUploadResponseDto extends createZodDto(CreateMediaUploadResponse) {}

const ACCEPTED_TYPES = Object.entries(MEDIA_CONTENT_TYPES)
  .map(([mediaType, types]) => `${mediaType}: ${types.join(', ')}`)
  .join('; ');

@Controller('v1/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @HttpCode(201)
  @RequireScope('messages:send')
  @ApiOperation({
    summary: 'Get a pre-signed upload URL for a media file',
    description:
      'Send the bytes with `PUT upload_url`, the same `Content-Type`, and exactly `size_bytes` bytes ' +
      'before `expires_at` (5 minutes). Then use `media_id` in `POST /v1/messages`. The bucket is private. ' +
      'A tenant has at most `MEDIA_UPLOADS_PER_DAY` uploads for each UTC day and ' +
      '`MEDIA_MAX_BYTES_PER_TENANT` bytes of live files; above them, 429 `QUOTA_EXCEEDED`. ' +
      `Accepted types (${ACCEPTED_TYPES}). A \`document\` message accepts every type of the list.`,
  })
  @ApiResponse(201, { description: 'Upload URL', schema: CreateMediaUploadResponseDto })
  create(@Auth() auth: AuthContext, @Body() body: CreateMediaUploadBody) {
    return this.media.createUpload(auth.tenantId, body);
  }
}
