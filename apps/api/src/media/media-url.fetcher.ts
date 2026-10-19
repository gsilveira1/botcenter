import { Inject, Injectable } from '@nestjs/common';
import { MEDIA_MAX_BYTES } from '@botcenter/contracts';
import type { MediaType } from '@botcenter/contracts';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';
import { EXTERNAL_HTTP_BINARY, ExternalHttpError } from '../ports/external-http.port';
import type {
  ExternalHttpBinaryPort,
  ExternalHttpBinaryResponse,
} from '../ports/external-http.port';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from '../services/tenants.service';
import { fitsMediaType } from './media-types';
import { MediaUnavailableError, outboundMediaKey } from './media.service';
import { MediaStorage } from './media.storage';

const DAY_MS = 86_400_000;

/** A download failure that can pass: a time limit, a network error, or a 5xx, 408, or 429 answer. */
export class MediaDownloadRetryableError extends Error {
  constructor(readonly detail: string) {
    super(`Media download failed (${detail}); a retry can work`);
    this.name = 'MediaDownloadRetryableError';
  }
}

export interface FetchedMedia {
  mediaId: string;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : 'invalid';
}

/**
 * Downloads the file of a client media `url` into the private bucket (SEC-01). The provider then gets a
 * pre-signed URL of the bucket, never the client URL, so the provider cannot be sent to an internal
 * address. The download uses `EXTERNAL_HTTP_BINARY`: the SSRF guard, no redirects (a 3xx fails), a size
 * limit of 16 MiB, HTTPS only in production, and `OUTBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS`.
 *
 * Errors: `MediaUnavailableError` (no retry: a forbidden address, a 3xx or 4xx answer, an empty or too
 * large file, a file type that WhatsApp does not accept) or `MediaDownloadRetryableError`.
 */
@Injectable()
export class MediaUrlFetcher {
  private readonly logger = getLogger('media-url');

  constructor(
    @Inject(EXTERNAL_HTTP_BINARY) private readonly http: ExternalHttpBinaryPort,
    private readonly storage: MediaStorage,
    private readonly prisma: PrismaService,
    private readonly tenants: TenantsService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async fetch(
    tenantId: string,
    url: string,
    mediaType: MediaType,
    fileName: string | undefined,
    now = new Date(),
  ): Promise<FetchedMedia> {
    const response = await this.download(url);
    const contentType = this.check(url, mediaType, response);
    const tenant = await this.tenants.get(tenantId);
    const key = outboundMediaKey(tenantId);
    const row = await this.prisma.forTenant(tenantId).mediaObject.create({
      data: {
        tenantId,
        key,
        contentType,
        sizeBytes: response.body.length,
        fileName: fileName ?? null,
        direction: 'outbound',
        expiresAt: new Date(now.getTime() + tenant.retentionDays * DAY_MS),
      },
      select: { id: true },
    });
    try {
      await this.storage.put(key, response.body, contentType);
    } catch (error) {
      await this.prisma
        .forTenant(tenantId)
        .mediaObject.deleteMany({ where: { id: row.id } })
        .catch((cleanup: unknown) => {
          this.logger.warn({ err: cleanup }, 'media row of a failed upload not deleted');
        });
      throw error;
    }
    return { mediaId: row.id };
  }

  private async download(url: string): Promise<ExternalHttpBinaryResponse> {
    try {
      return await this.http.getBinary({
        url,
        timeoutMs: this.env.OUTBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS,
        maxBytes: MEDIA_MAX_BYTES,
      });
    } catch (error) {
      if (!(error instanceof ExternalHttpError)) {
        throw error;
      }
      this.logger.warn({ code: error.code, host: hostOf(url) }, 'media download failed');
      switch (error.code) {
        case 'forbidden_address':
          throw new MediaUnavailableError('media_url_forbidden');
        case 'response_too_large':
          throw new MediaUnavailableError('media_too_large');
        case 'timeout':
        case 'network':
          throw new MediaDownloadRetryableError(error.code);
      }
    }
  }

  /** Returns the content type of a file that can go out as `mediaType`, or throws. */
  private check(url: string, mediaType: MediaType, response: ExternalHttpBinaryResponse): string {
    const { status, contentType, body } = response;
    if (isRetryableStatus(status)) {
      this.logger.warn({ status, host: hostOf(url) }, 'media download failed');
      throw new MediaDownloadRetryableError(`http_${status}`);
    }
    if (status < 200 || status >= 300 || body.length === 0) {
      this.logger.warn({ status, host: hostOf(url) }, 'media download failed; no retry');
      throw new MediaUnavailableError('media_download_failed');
    }
    if (!contentType || !fitsMediaType(mediaType, contentType)) {
      this.logger.warn(
        { content_type: contentType, media_type: mediaType },
        'media file type not accepted',
      );
      throw new MediaUnavailableError('media_type_not_accepted');
    }
    return contentType;
  }
}
