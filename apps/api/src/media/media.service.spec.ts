import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { AppError } from '../common/errors/app-error';
import { ExternalHttpError } from '../ports/external-http.port';
import { MediaService, MediaUnavailableError, outboundMediaKey } from './media.service';

const ROW = {
  id: 'media-1',
  key: 'tenants/t-1/outbound/abc',
  contentType: 'image/png',
  sizeBytes: 10,
  fileName: 'photo.png',
};

function setup(
  row: typeof ROW | null = ROW,
  stored: { sizeBytes: number } | null = { sizeBytes: 10 },
) {
  const mediaObject = {
    findFirst: vi.fn(async () => row),
    create: vi.fn(async () => ({ id: 'media-1' })),
  };
  const prisma = { forTenant: vi.fn(() => ({ mediaObject })) };
  const storage = {
    head: vi.fn(async () => stored),
    downloadUrl: vi.fn(async () => 'https://storage.test/get'),
    uploadUrl: vi.fn(async () => 'https://storage.test/put'),
  };
  const tenants = { get: vi.fn(async () => ({ retentionDays: 90 })) };
  const guard = {
    check: vi.fn(async (url: string) => {
      if (url.includes('metadata')) {
        throw new ExternalHttpError('forbidden_address', 'The address is in a forbidden range');
      }
      return { url: new URL(url), addresses: [] };
    }),
  };
  const service = new MediaService(
    prisma as never,
    storage as never,
    tenants as never,
    testEnv(),
    guard as never,
  );
  return { service, mediaObject, storage, guard };
}

describe('MediaService', () => {
  it('never gives a client URL to the provider (SEC-01)', async () => {
    const s = setup();
    await expect(
      s.service.toProviderContent('t-1', {
        type: 'media',
        media_type: 'document',
        url: 'https://files.example/a.pdf',
        file_name: 'a.pdf',
      }),
    ).rejects.toThrow('A media URL must be stored in the bucket before the send (SEC-01)');
    expect(s.storage.downloadUrl).not.toHaveBeenCalled();
  });

  it('refuses at request time a media URL that the SSRF guard refuses (SEC-01)', async () => {
    const s = setup();
    const error = await s.service
      .assertSendable('t-1', {
        type: 'media',
        media_type: 'document',
        url: 'https://metadata.example/latest',
      })
      .catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('MEDIA_URL_FORBIDDEN');
    expect((error as AppError).status).toBe(422);
    await expect(
      s.service.assertSendable('t-1', {
        type: 'media',
        media_type: 'document',
        url: 'https://files.example/a.pdf',
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves a media id to a short-lived download URL with the stored type and name', async () => {
    const s = setup();
    const content = await s.service.toProviderContent('t-1', {
      type: 'media',
      media_type: 'image',
      media_id: 'media-1',
      caption: 'Treino',
    });
    expect(content).toEqual({
      type: 'media',
      media_type: 'image',
      url: 'https://storage.test/get',
      mime_type: 'image/png',
      caption: 'Treino',
      file_name: 'photo.png',
    });
    expect(s.storage.downloadUrl).toHaveBeenCalledWith(ROW.key, 900);
  });

  it('throws MediaUnavailableError for a missing row or a missing upload', async () => {
    const content = { type: 'media' as const, media_type: 'image' as const, media_id: 'media-1' };
    await expect(setup(null).service.toProviderContent('t-1', content)).rejects.toEqual(
      new MediaUnavailableError('media_not_found'),
    );
    await expect(setup(ROW, null).service.toProviderContent('t-1', content)).rejects.toEqual(
      new MediaUnavailableError('media_not_uploaded'),
    );
    await expect(
      setup(ROW, { sizeBytes: 9 }).service.toProviderContent('t-1', content),
    ).rejects.toEqual(new MediaUnavailableError('media_not_uploaded'));
  });

  it('refuses an unknown media id and a file that does not fit the media type', async () => {
    const unknown = await setup(null)
      .service.assertSendable('t-1', { type: 'media', media_type: 'image', media_id: 'x' })
      .catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(AppError);
    expect((unknown as AppError).errors).toEqual([
      { path: 'media_id', message: 'Unknown media id' },
    ]);
    const wrongType = await setup()
      .service.assertSendable('t-1', { type: 'media', media_type: 'video', media_id: 'media-1' })
      .catch((error: unknown) => error);
    expect((wrongType as AppError).errors?.[0]?.path).toBe('media_type');
  });

  it('refuses an active content type for an upload', async () => {
    const s = setup();
    const error = await s.service
      .createUpload('t-1', { content_type: 'text/html', size_bytes: 10, file_name: 'a.html' })
      .catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('VALIDATION_FAILED');
    expect(s.mediaObject.create).not.toHaveBeenCalled();
  });

  it('makes object keys without the file name', () => {
    expect(outboundMediaKey('t-1')).toMatch(/^tenants\/t-1\/outbound\/[0-9a-f-]{36}$/);
  });
});
