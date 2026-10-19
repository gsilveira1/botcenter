import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MediaStorage, createS3Client } from './media.storage';

describe('MediaStorage.deleteObjects', () => {
  it('deletes the keys in one DeleteObjects call and returns the keys that failed', async () => {
    const s3 = createS3Client(testEnv());
    const send = vi.spyOn(s3, 'send').mockImplementation(async () => ({
      Errors: [{ Key: 'tenants/t/inbound/b', Code: 'AccessDenied' }],
    }));
    const storage = new MediaStorage(s3, testEnv());
    const result = await storage.deleteObjects(['tenants/t/inbound/a', 'tenants/t/inbound/b']);
    expect(result).toEqual({ failedKeys: ['tenants/t/inbound/b'] });
    const command = send.mock.calls[0]?.[0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input).toEqual({
      Bucket: 'media',
      Delete: {
        Objects: [{ Key: 'tenants/t/inbound/a' }, { Key: 'tenants/t/inbound/b' }],
        Quiet: true,
      },
    });
    storage.onApplicationShutdown();
  });

  it('sends nothing for an empty list', async () => {
    const s3 = new S3Client({ region: 'auto' });
    const send = vi.spyOn(s3, 'send');
    await expect(new MediaStorage(s3, testEnv()).deleteObjects([])).resolves.toEqual({
      failedKeys: [],
    });
    expect(send).not.toHaveBeenCalled();
    s3.destroy();
  });
});
