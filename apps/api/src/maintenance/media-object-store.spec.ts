import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { S3MediaObjectStore } from './media-purge.task';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('S3MediaObjectStore', () => {
  it('deletes the keys in one DeleteObjects call and returns the keys that failed', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({
      Errors: [{ Key: 'tenant/b.jpg', Code: 'AccessDenied' }],
    }));
    const store = new S3MediaObjectStore(testEnv());
    const result = await store.deleteObjects(['tenant/a.jpg', 'tenant/b.jpg']);
    expect(result).toEqual({ failedKeys: ['tenant/b.jpg'] });
    const command = send.mock.calls[0]?.[0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input).toEqual({
      Bucket: 'media',
      Delete: { Objects: [{ Key: 'tenant/a.jpg' }, { Key: 'tenant/b.jpg' }], Quiet: true },
    });
    store.onApplicationShutdown();
  });

  it('sends nothing for an empty list', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    await expect(new S3MediaObjectStore(testEnv()).deleteObjects([])).resolves.toEqual({
      failedKeys: [],
    });
    expect(send).not.toHaveBeenCalled();
  });
});
