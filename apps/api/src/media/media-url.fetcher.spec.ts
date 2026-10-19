import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { ExternalHttpError } from '../ports/external-http.port';
import type { ExternalHttpBinaryResponse } from '../ports/external-http.port';
import { MediaDownloadRetryableError, MediaUrlFetcher } from './media-url.fetcher';
import { MediaUnavailableError } from './media.service';

const PDF: ExternalHttpBinaryResponse = {
  status: 200,
  contentType: 'application/pdf',
  body: Buffer.from('%PDF'),
};

function setup(answer: () => Promise<ExternalHttpBinaryResponse>) {
  const http = { getBinary: vi.fn(answer) };
  const storage = { put: vi.fn(async () => {}) };
  const mediaObject = {
    create: vi.fn(async () => ({ id: 'media-1' })),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  const prisma = { forTenant: vi.fn(() => ({ mediaObject })) };
  const tenants = { get: vi.fn(async () => ({ retentionDays: 30 })) };
  const fetcher = new MediaUrlFetcher(
    http as never,
    storage as never,
    prisma as never,
    tenants as never,
    testEnv(),
  );
  return { fetcher, http, storage, mediaObject };
}

const failing = (code: ExternalHttpError['code']) => async () => {
  throw new ExternalHttpError(code, 'test');
};

describe('MediaUrlFetcher (SEC-01)', () => {
  it('stores the file in the bucket with a new media row', async () => {
    const s = setup(async () => PDF);
    const now = new Date('2026-10-19T10:00:00Z');
    expect(await s.fetcher.fetch('t-1', 'https://f.test/a.pdf', 'document', 'a.pdf', now)).toEqual({
      mediaId: 'media-1',
    });
    expect(s.http.getBinary).toHaveBeenCalledWith({
      url: 'https://f.test/a.pdf',
      timeoutMs: 20_000,
      maxBytes: 16 * 1024 * 1024,
    });
    const created = s.mediaObject.create.mock.calls[0] as unknown as [{ data: { key: string } }];
    expect(created[0].data).toMatchObject({
      tenantId: 't-1',
      contentType: 'application/pdf',
      sizeBytes: 4,
      fileName: 'a.pdf',
      direction: 'outbound',
      expiresAt: new Date('2026-11-18T10:00:00Z'),
    });
    expect(s.storage.put).toHaveBeenCalledWith(created[0].data.key, PDF.body, 'application/pdf');
  });

  it('maps each failure to a final reason or a retry', async () => {
    const reason = async (answer: () => Promise<ExternalHttpBinaryResponse>) =>
      setup(answer)
        .fetcher.fetch('t-1', 'https://f.test/a', 'image', undefined)
        .catch((error: unknown) => error);
    expect(await reason(failing('forbidden_address'))).toEqual(
      new MediaUnavailableError('media_url_forbidden'),
    );
    expect(await reason(failing('response_too_large'))).toEqual(
      new MediaUnavailableError('media_too_large'),
    );
    expect(await reason(failing('timeout'))).toBeInstanceOf(MediaDownloadRetryableError);
    expect(await reason(failing('network'))).toBeInstanceOf(MediaDownloadRetryableError);
    expect(await reason(async () => ({ ...PDF, status: 503 }))).toBeInstanceOf(
      MediaDownloadRetryableError,
    );
    expect(await reason(async () => ({ ...PDF, status: 302 }))).toEqual(
      new MediaUnavailableError('media_download_failed'),
    );
    expect(await reason(async () => ({ ...PDF, status: 404 }))).toEqual(
      new MediaUnavailableError('media_download_failed'),
    );
    expect(await reason(async () => ({ ...PDF, body: Buffer.alloc(0) }))).toEqual(
      new MediaUnavailableError('media_download_failed'),
    );
    // A PDF is not an image, and an HTML page is never accepted.
    expect(await reason(async () => PDF)).toEqual(
      new MediaUnavailableError('media_type_not_accepted'),
    );
    expect(await reason(async () => ({ ...PDF, contentType: null }))).toEqual(
      new MediaUnavailableError('media_type_not_accepted'),
    );
  });

  it('deletes the media row when the bucket refuses the file', async () => {
    const s = setup(async () => PDF);
    s.storage.put.mockRejectedValueOnce(new Error('bucket down'));
    await expect(
      s.fetcher.fetch('t-1', 'https://f.test/a.pdf', 'document', undefined),
    ).rejects.toThrow('bucket down');
    expect(s.mediaObject.deleteMany).toHaveBeenCalledWith({ where: { id: 'media-1' } });
  });
});
