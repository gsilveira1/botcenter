import { MEDIA_MAX_BYTES } from '@botcenter/contracts';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { MediaTooLargeError, ProviderError } from '@botcenter/whatsapp-provider';
import type { WhatsAppProvider } from '@botcenter/whatsapp-provider';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { MetricsService } from '../../metrics/metrics.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AlertService } from '../../services/alert.service';
import type { TenantsService } from '../../services/tenants.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { MediaStorage } from '../../media/media.storage';
import {
  INBOUND_MEDIA_URL_TTL_SECONDS,
  InboundMediaService,
  inboundMediaKey,
} from './inbound-media.service';
import type { InboundMediaFile } from './inbound-media.service';
import type { InstanceContext } from './instance-context';

const instance: InstanceContext = {
  tenantId: 't1',
  instanceId: 'i1',
  providerName: 'inst_1',
  externalRef: 'o1',
  botId: null,
};
const now = new Date('2026-10-19T12:00:00.000Z');
const file: InboundMediaFile = {
  messageId: '0192f1a4-7c2e-7b51-9a0e-3f5d2c8b6e41',
  providerMessageId: 'wamid-1',
  mimeType: 'image/jpeg',
};

function build(env: Record<string, string> = {}) {
  const order: string[] = [];
  const downloadMedia = vi.fn(async (_name: string, _id: string, _options?: unknown) => ({
    data: Buffer.from('jpeg'),
    mimeType: 'image/jpeg',
    fileName: 'a.jpg',
  }));
  const storage = {
    put: vi.fn(async () => {
      order.push('put');
    }),
    downloadUrl: vi.fn(async () => 'https://media.test/signed'),
  };
  const mediaObject = {
    createMany: vi.fn(async () => {
      order.push('reserve');
      return { count: 1 };
    }),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const alerts = { notify: vi.fn(async () => undefined) };
  const tenants = { get: vi.fn(async () => ({ retentionDays: 30 })) };
  const service = new InboundMediaService(
    testEnv(env),
    { downloadMedia } as unknown as WhatsAppProvider,
    storage as unknown as MediaStorage,
    { forTenant: () => ({ mediaObject }) } as unknown as PrismaService,
    tenants as unknown as TenantsService,
    alerts as unknown as AlertService,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  return { service, downloadMedia, storage, mediaObject, alerts, order };
}

describe('InboundMediaService', () => {
  it('copies the file to the bucket and gives the event media with a signed URL', async () => {
    const { service, storage } = build();
    const result = await service.copy(instance, file, now);
    expect(result).toMatchObject({
      status: 'stored',
      contentType: 'image/jpeg',
      sizeBytes: 4,
      fileName: 'a.jpg',
      event: {
        mime_type: 'image/jpeg',
        url: 'https://media.test/signed',
        expires_at: new Date(now.getTime() + INBOUND_MEDIA_URL_TTL_SECONDS * 1000).toISOString(),
      },
    });
    if (result.status !== 'stored') throw new Error('not stored');
    expect(result.key).toBe(inboundMediaKey('t1', result.mediaId));
    expect(storage.put).toHaveBeenCalledWith(result.key, Buffer.from('jpeg'), 'image/jpeg');
  });

  it('gives failed for a provider error, without an alert', async () => {
    const { service, downloadMedia, alerts } = build();
    downloadMedia.mockRejectedValueOnce(new ProviderError('rejected', 'no media', 400));
    await expect(service.copy(instance, file, now)).resolves.toEqual({ status: 'failed' });
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('gives failed with an alert when the bucket fails, and throws a programming error', async () => {
    const { service, storage, alerts } = build();
    storage.put.mockRejectedValueOnce(
      new S3ServiceException({ name: 'NoSuchBucket', $fault: 'client', $metadata: {} }),
    );
    await expect(service.copy(instance, file, now)).resolves.toEqual({ status: 'failed' });
    expect(alerts.notify).toHaveBeenCalledTimes(1);

    storage.put.mockRejectedValueOnce(new TypeError('bug'));
    await expect(service.copy(instance, file, now)).rejects.toThrow('bug');
  });
});

describe('InboundMediaService: size limit (ARCH-03, SEC-02)', () => {
  it('gives too_large for a declared size above the limit and does not download the file', async () => {
    const { service, downloadMedia, storage } = build();
    const result = await service.copy(
      instance,
      { ...file, declaredBytes: MEDIA_MAX_BYTES + 1 },
      now,
    );
    expect(result).toEqual({ status: 'too_large' });
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('asks the provider to stop at the limit, and gives too_large when it stops', async () => {
    const { service, downloadMedia, storage } = build();
    downloadMedia.mockRejectedValueOnce(new MediaTooLargeError(MEDIA_MAX_BYTES));
    await expect(service.copy(instance, file, now)).resolves.toEqual({ status: 'too_large' });
    expect(downloadMedia).toHaveBeenCalledWith('inst_1', 'wamid-1', { maxBytes: MEDIA_MAX_BYTES });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('runs at most INBOUND_MEDIA_DOWNLOAD_CONCURRENCY downloads at the same time', async () => {
    const { service, downloadMedia } = build({ INBOUND_MEDIA_DOWNLOAD_CONCURRENCY: '2' });
    let active = 0;
    let peak = 0;
    downloadMedia.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { data: Buffer.from('x'), mimeType: 'image/jpeg', fileName: 'a.jpg' };
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        service.copy(instance, { ...file, providerMessageId: `w${index}` }, now),
      ),
    );
    expect(downloadMedia).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });
});

describe('InboundMediaService: no orphan objects (ARCH-13)', () => {
  it('uses the message id as the media id, so a retry writes the same object key', async () => {
    const first = await build().service.copy(instance, file, now);
    const retry = await build().service.copy(instance, file, new Date(now.getTime() + 5_000));
    if (first.status !== 'stored' || retry.status !== 'stored') throw new Error('not stored');
    expect(first.mediaId).toBe(file.messageId);
    expect(retry.key).toBe(first.key);
    expect(first.key).toBe(`tenants/t1/inbound/${file.messageId}`);
  });

  it('writes the media_objects row with expiresAt before the upload, so the purge finds every object', async () => {
    const { service, mediaObject, order } = build();
    await service.copy(instance, { ...file, declaredBytes: 4, fileName: 'a.jpg' }, now);
    expect(order).toEqual(['reserve', 'put']);
    expect(mediaObject.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: file.messageId,
          tenantId: 't1',
          key: `tenants/t1/inbound/${file.messageId}`,
          contentType: 'image/jpeg',
          sizeBytes: 4,
          fileName: 'a.jpg',
          direction: 'inbound',
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
      ],
      skipDuplicates: true,
    });
  });

  it('lets the purge delete the reserved row and a partial object at once when the upload fails', async () => {
    const { service, storage, mediaObject } = build();
    storage.put.mockRejectedValueOnce(
      new S3ServiceException({ name: 'InternalError', $fault: 'server', $metadata: {} }),
    );
    await expect(service.copy(instance, file, now)).resolves.toEqual({ status: 'failed' });
    expect(mediaObject.updateMany).toHaveBeenCalledWith({
      where: { id: file.messageId },
      data: { expiresAt: now },
    });
  });
});
