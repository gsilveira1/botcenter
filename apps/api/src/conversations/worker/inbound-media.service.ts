import { Inject, Injectable } from '@nestjs/common';
import { MEDIA_MAX_BYTES } from '@botcenter/contracts';
import type { InboundMedia } from '@botcenter/contracts';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { MediaTooLargeError, ProviderError } from '@botcenter/whatsapp-provider';
import type { DownloadedMedia, WhatsAppProvider } from '@botcenter/whatsapp-provider';
import { ENV } from '../../config/env';
import type { AppEnv } from '../../config/env';
import { getLogger } from '../../logging/logger';
import { MediaStorage } from '../../media/media.storage';
import { PrismaService } from '../../prisma/prisma.service';
import { WHATSAPP_PROVIDER } from '../../provider/provider.tokens';
import { AlertService } from '../../services/alert.service';
import { TenantsService } from '../../services/tenants.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { InstanceContext } from './instance-context';

/** Life of the signed GET URL in a `message.received` event. */
export const INBOUND_MEDIA_URL_TTL_SECONDS = 3_600;

/** The object key of an inbound file (same layout as the outbound keys). No file name, no personal data. */
export function inboundMediaKey(tenantId: string, mediaId: string): string {
  return `tenants/${tenantId}/inbound/${mediaId}`;
}

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

/** The inbound media message to copy. */
export interface InboundMediaFile {
  /** The inbound `messages` row. It is also the media id, so a retry writes the same object (ARCH-13). */
  messageId: string;
  providerMessageId: string;
  /** The mime type of the webhook (the download can give a better one). */
  mimeType: string;
  fileName?: string;
  /** The size that the sender declared (`fileLength`), when the webhook has it. */
  declaredBytes?: number;
}

/** A counter of free slots with a FIFO queue of waiters (one process). */
class Semaphore {
  private readonly waiters: (() => void)[] = [];

  constructor(private free: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) {
      this.free -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.free += 1;
      }
    }
  }
}

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
 *
 * Memory (ARCH-03, SEC-02): a declared size above `MEDIA_MAX_BYTES` skips the download, the provider
 * stops the read of a larger answer, and at most `INBOUND_MEDIA_DOWNLOAD_CONCURRENCY` downloads run at
 * the same time in one process.
 *
 * Orphan objects (ARCH-13): the object key comes from the message id, so a retry writes the same object.
 * The `media_objects` row (with `expiresAt`) is written before the upload, so the purge of the
 * maintenance slice finds every object, also when the job stops after the upload.
 */
@Injectable()
export class InboundMediaService {
  private readonly logger = getLogger('inbound-media');
  private readonly downloads: Semaphore;

  constructor(
    @Inject(ENV) env: AppEnv,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    private readonly storage: MediaStorage,
    private readonly prisma: PrismaService,
    private readonly tenants: TenantsService,
    private readonly alerts: AlertService,
    private readonly metrics: ConversationMetrics,
  ) {
    this.downloads = new Semaphore(env.INBOUND_MEDIA_DOWNLOAD_CONCURRENCY);
  }

  async copy(
    instance: InstanceContext,
    file: InboundMediaFile,
    now: Date,
  ): Promise<InboundMediaResult> {
    if (file.declaredBytes !== undefined && file.declaredBytes > MEDIA_MAX_BYTES) {
      return this.tooLarge(file.declaredBytes);
    }
    const downloaded = await this.downloads.run(() => this.download(instance, file));
    if (downloaded === 'too_large') {
      return this.tooLarge(undefined);
    }
    if (downloaded === null) {
      return this.result('failed');
    }
    return (await this.upload(instance, file, downloaded, now)) ?? this.result('failed');
  }

  private async download(
    instance: InstanceContext,
    file: InboundMediaFile,
  ): Promise<DownloadedMedia | 'too_large' | null> {
    try {
      return await this.provider.downloadMedia(instance.providerName, file.providerMessageId, {
        maxBytes: MEDIA_MAX_BYTES,
      });
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        return 'too_large';
      }
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
    file: InboundMediaFile,
    downloaded: DownloadedMedia,
    now: Date,
  ): Promise<StoredMediaFile | null> {
    const mediaId = file.messageId;
    const key = inboundMediaKey(instance.tenantId, mediaId);
    const fileName = downloaded.fileName ?? file.fileName ?? null;
    try {
      await this.reserve(instance, { mediaId, key, downloaded, fileName }, now);
      await this.storage.put(key, downloaded.data, downloaded.mimeType);
      const url = await this.storage.downloadUrl(key, INBOUND_MEDIA_URL_TTL_SECONDS);
      const expiresAt = new Date(now.getTime() + INBOUND_MEDIA_URL_TTL_SECONDS * 1000);
      this.metrics.inboundMedia.inc({ result: 'stored' });
      return {
        status: 'stored',
        mediaId,
        key,
        contentType: downloaded.mimeType,
        sizeBytes: downloaded.data.length,
        fileName,
        event: {
          media_id: mediaId,
          mime_type: downloaded.mimeType,
          url,
          expires_at: expiresAt.toISOString(),
        },
      };
    } catch (error) {
      await this.uploadFailed(instance, mediaId, now, error);
      return null;
    }
  }

  /** A bucket error: log, alert, and release the reserved row. Any other error is a bug: throw it. */
  private async uploadFailed(
    instance: InstanceContext,
    mediaId: string,
    now: Date,
    error: unknown,
  ): Promise<void> {
    if (!isStorageError(error)) {
      throw error;
    }
    this.logger.error(
      { err: error },
      'inbound media upload failed; the event goes out without media',
    );
    await this.release(instance, mediaId, now);
    void this.alerts.notify({
      severity: 'warning',
      title: 'Inbound media not stored in the media bucket',
      details: { tenant_id: instance.tenantId, error: (error as Error).name },
      dedupeKey: 'inbound-media-upload',
    });
  }

  /**
   * Writes the `media_objects` row before the upload (idempotent: a retry finds the row). `expiresAt`
   * is the end of the retention of the tenant, so the purge deletes the object in all cases.
   */
  private async reserve(
    instance: InstanceContext,
    file: { mediaId: string; key: string; downloaded: DownloadedMedia; fileName: string | null },
    now: Date,
  ): Promise<void> {
    const tenant = await this.tenants.get(instance.tenantId);
    await this.prisma.forTenant(instance.tenantId).mediaObject.createMany({
      data: [
        {
          id: file.mediaId,
          tenantId: instance.tenantId,
          key: file.key,
          contentType: file.downloaded.mimeType,
          sizeBytes: file.downloaded.data.length,
          fileName: file.fileName,
          direction: 'inbound',
          expiresAt: new Date(now.getTime() + tenant.retentionDays * 86_400_000),
        },
      ],
      skipDuplicates: true,
    });
  }

  /** After a failed upload: the next purge run deletes the row and a partial object, if one exists. */
  private async release(instance: InstanceContext, mediaId: string, now: Date): Promise<void> {
    try {
      await this.prisma.forTenant(instance.tenantId).mediaObject.updateMany({
        where: { id: mediaId },
        data: { expiresAt: now },
      });
    } catch (error) {
      // The row keeps the expiry of the retention: the purge still deletes it later.
      this.logger.warn({ err: error, media_id: mediaId }, 'reserved media row not released');
    }
  }

  private tooLarge(declaredBytes: number | undefined): InboundMediaResult {
    this.logger.warn(
      { declared_bytes: declaredBytes, max_bytes: MEDIA_MAX_BYTES },
      'inbound media is too large; the event goes out without media',
    );
    return this.result('too_large');
  }

  private result(status: 'failed' | 'too_large'): InboundMediaResult {
    this.metrics.inboundMedia.inc({ result: status });
    return { status };
  }
}
