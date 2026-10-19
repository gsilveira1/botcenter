import { MEDIA_MAX_BYTES } from '@botcenter/contracts';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { ProviderError } from '@botcenter/whatsapp-provider';
import type { WhatsAppProvider } from '@botcenter/whatsapp-provider';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { MetricsService } from '../../metrics/metrics.service';
import type { AlertService } from '../../services/alert.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { MediaStorage } from '../../media/media.storage';
import {
  INBOUND_MEDIA_URL_TTL_SECONDS,
  InboundMediaService,
  inboundMediaKey,
} from './inbound-media.service';
import type { InstanceContext } from './instance-context';

const instance: InstanceContext = {
  tenantId: 't1',
  instanceId: 'i1',
  providerName: 'inst_1',
  externalRef: 'o1',
  botId: null,
};
const now = new Date('2026-10-19T12:00:00.000Z');

function build() {
  const downloadMedia = vi.fn(async () => ({
    data: Buffer.from('jpeg'),
    mimeType: 'image/jpeg',
    fileName: 'a.jpg',
  }));
  const storage = {
    put: vi.fn(async () => undefined),
    downloadUrl: vi.fn(async () => 'https://media.test/signed'),
  };
  const alerts = { notify: vi.fn(async () => undefined) };
  const service = new InboundMediaService(
    { downloadMedia } as unknown as WhatsAppProvider,
    storage as unknown as MediaStorage,
    alerts as unknown as AlertService,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  return { service, downloadMedia, storage, alerts };
}

describe('InboundMediaService', () => {
  it('copies the file to the bucket and gives the event media with a signed URL', async () => {
    const { service, storage } = build();
    const result = await service.copy(instance, 'wamid-1', now);
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
    expect(result.key).toBe(`tenants/t1/inbound/${result.mediaId}`);
    expect(storage.put).toHaveBeenCalledWith(result.key, Buffer.from('jpeg'), 'image/jpeg');
  });

  it('gives failed for a provider error, without an alert', async () => {
    const { service, downloadMedia, alerts } = build();
    downloadMedia.mockRejectedValueOnce(new ProviderError('rejected', 'no media', 400));
    await expect(service.copy(instance, 'wamid-1', now)).resolves.toEqual({ status: 'failed' });
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('gives too_large above the media limit', async () => {
    const { service, downloadMedia, storage } = build();
    downloadMedia.mockResolvedValueOnce({
      data: Buffer.alloc(MEDIA_MAX_BYTES + 1),
      mimeType: 'video/mp4',
      fileName: 'v.mp4',
    });
    await expect(service.copy(instance, 'wamid-1', now)).resolves.toEqual({ status: 'too_large' });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('gives failed with an alert when the bucket fails, and throws a programming error', async () => {
    const { service, storage, alerts } = build();
    storage.put.mockRejectedValueOnce(
      new S3ServiceException({ name: 'NoSuchBucket', $fault: 'client', $metadata: {} }),
    );
    await expect(service.copy(instance, 'wamid-1', now)).resolves.toEqual({ status: 'failed' });
    expect(alerts.notify).toHaveBeenCalledTimes(1);

    storage.put.mockRejectedValueOnce(new TypeError('bug'));
    await expect(service.copy(instance, 'wamid-1', now)).rejects.toThrow('bug');
  });
});
