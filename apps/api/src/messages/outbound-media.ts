import { Injectable } from '@nestjs/common';
import type { MediaContent, MessageContent } from '@botcenter/contracts';
import type { OutboundContent } from '@botcenter/whatsapp-provider';
import type { Job } from 'bullmq';
import { getLogger } from '../logging/logger';
import { MediaDownloadRetryableError, MediaUrlFetcher } from '../media/media-url.fetcher';
import { MediaService, MediaUnavailableError } from '../media/media.service';
import type { OutboundJob } from '../queues/queue-names';
import { BACKOFF, RetryableSendError, backoffDelayMs } from './retry-policy';

/** Maximum runs of a send job that try to download the file of a media `url`. */
export const MEDIA_DOWNLOAD_MAX_RUNS = 3;

/**
 * The provider content of an outbound message. A media message always goes out as a pre-signed URL of
 * the private bucket (SEC-01):
 * - a `media_id` (from `POST /v1/media`) is checked and signed;
 * - a `url` (from `POST /v1/messages` or a bot reply) is first downloaded into the bucket. The job keeps
 *   the new `mediaId`, so a retry of the send does not download the file again.
 *
 * A download that can pass (a time limit, a network error, a 5xx answer) throws `RetryableSendError`
 * with the `unavailable` backoff, for at most `MEDIA_DOWNLOAD_MAX_RUNS` runs. Then, and for every other
 * download failure, it throws `MediaUnavailableError`: the message fails with its `failure_reason`.
 */
@Injectable()
export class OutboundMediaPreparer {
  private readonly logger = getLogger('outbound-media');

  constructor(
    private readonly media: MediaService,
    private readonly fetcher: MediaUrlFetcher,
  ) {}

  async content(
    job: Job<OutboundJob>,
    tenantId: string,
    content: MessageContent,
  ): Promise<OutboundContent> {
    if (content.type !== 'media') {
      return content;
    }
    if (content.media_id !== undefined) {
      return this.media.toProviderContent(tenantId, content);
    }
    const mediaId = job.data.mediaId ?? (await this.download(job, tenantId, content));
    return this.media.toProviderContent(tenantId, {
      type: 'media',
      media_type: content.media_type,
      media_id: mediaId,
      ...(content.caption !== undefined ? { caption: content.caption } : {}),
      ...(content.file_name !== undefined ? { file_name: content.file_name } : {}),
    });
  }

  private async download(
    job: Job<OutboundJob>,
    tenantId: string,
    content: MediaContent,
  ): Promise<string> {
    let mediaId: string;
    try {
      ({ mediaId } = await this.fetcher.fetch(
        tenantId,
        content.url ?? '',
        content.media_type,
        content.file_name,
      ));
    } catch (error) {
      if (!(error instanceof MediaDownloadRetryableError)) {
        throw error;
      }
      const run = job.attemptsMade + 1;
      if (run >= MEDIA_DOWNLOAD_MAX_RUNS) {
        throw new MediaUnavailableError('media_download_failed');
      }
      throw new RetryableSendError('unavailable', backoffDelayMs(BACKOFF.unavailable, run), {
        cause: error,
      });
    }
    try {
      await job.updateData({ ...job.data, mediaId });
    } catch (error) {
      this.logger.warn({ err: error }, 'media id not kept in the job; a retry downloads again');
    }
    return mediaId;
  }
}
