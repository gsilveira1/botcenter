import { Inject, Injectable } from '@nestjs/common';
import { MEDIA_MAX_BYTES } from '@botcenter/contracts';
import type { InboundMedia } from '@botcenter/contracts';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { ProviderError } from '@botcenter/whatsapp-provider';
import type { DownloadedMedia, WhatsAppProvider } from '@botcenter/whatsapp-provider';
import { getLogger } from '../../logging/logger';
import { WHATSAPP_PROVIDER } from '../../provider/provider.tokens';
import { AlertService } from '../../services/alert.service';
import { ConversationMetrics } from '../conversation-metrics';
import { uuidV7 } from '../uuid-v7';
import type { InstanceContext } from './instance-context';
import { MediaStorageService } from './media-storage.service';

/** Life of the signed GET URL in a `message.received` event. */
export const INBOUND_MEDIA_URL_TTL_SECONDS = 3_600;

export interface StoredMediaFile {
  status: 'stored';
  mediaId: string;
  key: string;
  contentType: string;
  sizeBytes: number;
  fileName: string | null;
  event: InboundMedia;
}

export type InboundMediaResult = StoredMediaFile | { status: 'failed' | 'too_large' };

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

/** An error of the object storage (S3 answer, network, or time limit), not a programming error. */
function isStorageError(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return true;
  }
  const failure = error as { name?: unknown; code?: unknown };
  return (
    error instanceof Error &&
    (failure.name === 'TimeoutError' ||
      (typeof failure.code === 'string' && NETWORK_ERROR_CODES.has(failure.code)))
  );
}

/**
 * Copies the file of an inbound media message from the provider to the media bucket. A failure never
 * blocks the message: the result is `failed` (log and metric; an alert when the bucket fails) and the
 * `message.received` event goes out without media.
 */
@Injectable()
export class InboundMediaService {
  private readonly logger = getLogger('inbound-media');

  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    private readonly storage: MediaStorageService,
    private readonly alerts: AlertService,
    private readonly metrics: ConversationMetrics,
  ) {}

  async copy(
    instance: InstanceContext,
    providerMessageId: string,
    now: Date,
  ): Promise<InboundMediaResult> {
    const downloaded = await this.download(instance, providerMessageId);
    if (downloaded === null) {
      return this.result('failed');
    }
    if (downloaded.data.length > MEDIA_MAX_BYTES) {
      this.logger.warn(
        { size_bytes: downloaded.data.length, max_bytes: MEDIA_MAX_BYTES },
        'inbound media is too large; the event goes out without media',
      );
      return this.result('too_large');
    }
    return (await this.upload(instance, downloaded, now)) ?? this.result('failed');
  }

  private async download(
    instance: InstanceContext,
    providerMessageId: string,
  ): Promise<DownloadedMedia | null> {
    try {
      return await this.provider.downloadMedia(instance.providerName, providerMessageId);
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        throw error;
      }
      this.logger.warn(
        { err: error, provider_code: error.code },
        'inbound media download failed; the event goes out without media',
      );
      return null;
    }
  }

  private async upload(
    instance: InstanceContext,
    file: DownloadedMedia,
    now: Date,
  ): Promise<StoredMediaFile | null> {
    const mediaId = uuidV7(now.getTime());
    const key = `inbound/${instance.tenantId}/${mediaId}`;
    try {
      await this.storage.put(key, file.data, file.mimeType);
      const url = await this.storage.signedGetUrl(key, INBOUND_MEDIA_URL_TTL_SECONDS);
      const expiresAt = new Date(now.getTime() + INBOUND_MEDIA_URL_TTL_SECONDS * 1000);
      this.metrics.inboundMedia.inc({ result: 'stored' });
      return {
        status: 'stored',
        mediaId,
        key,
        contentType: file.mimeType,
        sizeBytes: file.data.length,
        fileName: file.fileName ?? null,
        event: {
          media_id: mediaId,
          mime_type: file.mimeType,
          url,
          expires_at: expiresAt.toISOString(),
        },
      };
    } catch (error) {
      if (!isStorageError(error)) {
        throw error;
      }
      this.logger.error(
        { err: error },
        'inbound media upload failed; the event goes out without media',
      );
      await this.alerts.notify({
        severity: 'warning',
        title: 'Inbound media not stored in the media bucket',
        details: { tenant_id: instance.tenantId, error: (error as Error).name },
        dedupeKey: 'inbound-media-upload',
      });
      return null;
    }
  }

  private result(status: 'failed' | 'too_large'): InboundMediaResult {
    this.metrics.inboundMedia.inc({ result: status });
    return { status };
  }
}
