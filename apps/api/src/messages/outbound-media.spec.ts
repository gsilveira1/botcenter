import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { MediaDownloadRetryableError } from '../media/media-url.fetcher';
import { MediaUnavailableError } from '../media/media.service';
import type { OutboundJob } from '../queues/queue-names';
import { MEDIA_DOWNLOAD_MAX_RUNS, OutboundMediaPreparer } from './outbound-media';
import { RetryableSendError } from './retry-policy';

const URL_CONTENT = {
  type: 'media' as const,
  media_type: 'document' as const,
  url: 'https://files.example/a.pdf',
  file_name: 'a.pdf',
  caption: 'Plano',
};

function setup(fetch: () => Promise<{ mediaId: string }>, attemptsMade = 0) {
  const media = {
    toProviderContent: vi.fn(async (_tenant: string, content: Record<string, unknown>) => ({
      ...content,
      url: 'https://bucket.test/signed',
    })),
  };
  const fetcher = { fetch: vi.fn(fetch) };
  const job = {
    data: { tenantId: 't-1', messageId: 'm-1', instanceId: 'i-1' } as OutboundJob,
    attemptsMade,
    updateData: vi.fn(async (data: OutboundJob) => {
      job.data = data;
    }),
  };
  const preparer = new OutboundMediaPreparer(media as never, fetcher as never);
  return { preparer, media, fetcher, job: job as unknown as Job<OutboundJob> & typeof job };
}

describe('OutboundMediaPreparer (SEC-01)', () => {
  it('downloads a client URL into the bucket and gives the provider the signed URL of the copy', async () => {
    const s = setup(async () => ({ mediaId: 'media-9' }));
    const content = await s.preparer.content(s.job, 't-1', URL_CONTENT);
    expect(s.fetcher.fetch).toHaveBeenCalledWith(
      't-1',
      'https://files.example/a.pdf',
      'document',
      'a.pdf',
    );
    expect(s.media.toProviderContent).toHaveBeenCalledWith('t-1', {
      type: 'media',
      media_type: 'document',
      media_id: 'media-9',
      caption: 'Plano',
      file_name: 'a.pdf',
    });
    expect(content).toMatchObject({ url: 'https://bucket.test/signed' });
    expect(s.job.data.mediaId).toBe('media-9');
  });

  it('does not download again when the job has the copy', async () => {
    const s = setup(async () => ({ mediaId: 'other' }));
    s.job.data = { ...s.job.data, mediaId: 'media-9' };
    await s.preparer.content(s.job, 't-1', URL_CONTENT);
    expect(s.fetcher.fetch).not.toHaveBeenCalled();
    expect(s.media.toProviderContent).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ media_id: 'media-9' }),
    );
  });

  it('retries a download that can pass, then fails it after the last run', async () => {
    const retryable = async () => {
      throw new MediaDownloadRetryableError('timeout');
    };
    const first = await setup(retryable)
      .preparer.content(setup(retryable).job, 't-1', URL_CONTENT)
      .catch((error: unknown) => error);
    expect(first).toBeInstanceOf(RetryableSendError);
    const last = setup(retryable, MEDIA_DOWNLOAD_MAX_RUNS - 1);
    await expect(last.preparer.content(last.job, 't-1', URL_CONTENT)).rejects.toEqual(
      new MediaUnavailableError('media_download_failed'),
    );
  });

  it('passes a text message and a media id through the media service', async () => {
    const s = setup(async () => ({ mediaId: 'x' }));
    const text = { type: 'text' as const, text: 'Oi' };
    expect(await s.preparer.content(s.job, 't-1', text)).toBe(text);
    await s.preparer.content(s.job, 't-1', {
      type: 'media',
      media_type: 'image',
      media_id: 'media-1',
    });
    expect(s.fetcher.fetch).not.toHaveBeenCalled();
  });
});
