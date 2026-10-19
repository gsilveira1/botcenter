import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  CreateMediaUploadRequest,
  CreateMediaUploadResponse,
  MediaUrlResponse,
  UuidParam,
} from '@botcenter/contracts';
import { Auth } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { RequireScope } from '../auth/decorators';
import { createZodDto } from '../common/zod-dto';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import { MEDIA_CONTENT_TYPES } from './media-types';
import { MediaService } from './media.service';

class CreateMediaUploadBody extends createZodDto(CreateMediaUploadRequest) {}
class CreateMediaUploadResponseDto extends createZodDto(CreateMediaUploadResponse) {}
class MediaParams extends createZodDto(UuidParam) {}
class MediaUrlResponseDto extends createZodDto(MediaUrlResponse) {}

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

  @Get(':id')
  @RequireScope('events:read')
  @ApiOperation({
    summary: 'Get a fresh download URL of a media file',
    description:
      'The `url` of an inbound file in a `message.received` event expires after 1 hour. This route ' +
      'gives a new signed URL (15 minutes) of a file of the tenant while the file is kept ' +
      '(`retentionDays`). A key with an instance list reads only the inbound files of its instances. ' +
      'An unknown or expired file is 404.',
  })
  @ApiResponse(200, { description: 'Download URL', schema: MediaUrlResponseDto })
  read(@Auth() auth: AuthContext, @Param() params: MediaParams) {
    return this.media.readUrl(auth, params.id);
  }
}
