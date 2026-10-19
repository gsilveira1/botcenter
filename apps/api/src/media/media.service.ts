import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateMediaUploadRequest,
  CreateMediaUploadResponse,
  MediaContent,
} from '@botcenter/contracts';
import type { OutboundMediaContent } from '@botcenter/whatsapp-provider';
import { validationError } from '../common/errors/app-error';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from '../services/tenants.service';
import { fitsMediaType, isAcceptedContentType } from './media-types';
import { MediaStorage } from './media.storage';

const DAY_MS = 86_400_000;

/** Why the worker cannot send a media message. The value is the `failure_reason` of the message. */
export type MediaFailureReason = 'media_not_found' | 'media_not_uploaded';

export class MediaUnavailableError extends Error {
  constructor(readonly reason: MediaFailureReason) {
    super(`Media unavailable: ${reason}`);
    this.name = 'MediaUnavailableError';
  }
}

interface MediaRow {
  id: string;
  key: string;
  contentType: string;
  sizeBytes: number;
  fileName: string | null;
}

const MEDIA_SELECT = {
  id: true,
  key: true,
  contentType: true,
  sizeBytes: true,
  fileName: true,
} as const;

/** The object key of an outbound file. It has no file name and no personal data. */
export function outboundMediaKey(tenantId: string): string {
  return `tenants/${tenantId}/outbound/${randomUUID()}`;
}

/**
 * Outbound media: the upload URL of `POST /v1/media`, the check of a `media_id` in `POST /v1/messages`,
 * and the short-lived download URL that the worker gives to the provider.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    private readonly tenants: TenantsService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async createUpload(
    tenantId: string,
    request: CreateMediaUploadRequest,
    now = new Date(),
  ): Promise<CreateMediaUploadResponse> {
    if (!isAcceptedContentType(request.content_type)) {
      throw validationError('The content type is not accepted', [
        { path: 'content_type', message: 'WhatsApp does not accept this content type' },
      ]);
    }
    const tenant = await this.tenants.get(tenantId);
    const key = outboundMediaKey(tenantId);
    const row = await this.prisma.forTenant(tenantId).mediaObject.create({
      data: {
        tenantId,
        key,
        contentType: request.content_type,
        sizeBytes: request.size_bytes,
        fileName: request.file_name,
        direction: 'outbound',
        expiresAt: new Date(now.getTime() + tenant.retentionDays * DAY_MS),
      },
      select: { id: true },
    });
    const ttlSeconds = this.env.MEDIA_UPLOAD_URL_TTL_SECONDS;
    const uploadUrl = await this.storage.uploadUrl(
      key,
      request.content_type,
      request.size_bytes,
      ttlSeconds,
    );
    return {
      media_id: row.id,
      upload_url: uploadUrl,
      expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
  }

  /**
   * Refuses (400) a `media_id` that the tenant does not have, or a file type that does not fit the
   * `media_type` of the message. The upload itself is checked by the worker before the send.
   */
  async assertSendable(tenantId: string, content: MediaContent): Promise<void> {
    if (content.media_id === undefined) {
      return;
    }
    const media = await this.find(tenantId, content.media_id);
    if (!media) {
      throw validationError('The media does not exist', [
        { path: 'media_id', message: 'Unknown media id' },
      ]);
    }
    if (!fitsMediaType(content.media_type, media.contentType)) {
      throw validationError('The media type does not fit the file', [
        { path: 'media_type', message: `A ${media.contentType} file cannot be sent as this type` },
      ]);
    }
  }

  /**
   * The content for the provider. A `media_id` becomes a pre-signed `GET` URL that is valid for
   * `MEDIA_SEND_URL_TTL_SECONDS`. Throws `MediaUnavailableError` when the row or the upload is missing.
   */
  async toProviderContent(tenantId: string, content: MediaContent): Promise<OutboundMediaContent> {
    const base = {
      type: 'media' as const,
      media_type: content.media_type,
      ...(content.caption !== undefined ? { caption: content.caption } : {}),
    };
    if (content.media_id === undefined) {
      return {
        ...base,
        url: content.url ?? '',
        ...(content.file_name !== undefined ? { file_name: content.file_name } : {}),
      };
    }
    const media = await this.find(tenantId, content.media_id);
    if (!media) {
      throw new MediaUnavailableError('media_not_found');
    }
    const stored = await this.storage.head(media.key);
    if (!stored || stored.sizeBytes !== media.sizeBytes) {
      throw new MediaUnavailableError('media_not_uploaded');
    }
    const fileName = content.file_name ?? media.fileName;
    return {
      ...base,
      url: await this.storage.downloadUrl(media.key, this.env.MEDIA_SEND_URL_TTL_SECONDS),
      mime_type: media.contentType,
      ...(fileName ? { file_name: fileName } : {}),
    };
  }

  private find(tenantId: string, mediaId: string): Promise<MediaRow | null> {
    return this.prisma.forTenant(tenantId).mediaObject.findFirst({
      where: { id: mediaId, direction: 'outbound' },
      select: MEDIA_SELECT,
    });
  }
}
