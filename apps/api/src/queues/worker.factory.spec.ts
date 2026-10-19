import { DelayedError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { isDelayedError } from './worker.factory';

describe('isDelayedError', () => {
  it('knows the BullMQ delay error by class and by name', () => {
    expect(isDelayedError(new DelayedError())).toBe(true);
    const copy = new Error('moved');
    copy.name = 'DelayedError';
    expect(isDelayedError(copy)).toBe(true);
    expect(isDelayedError(new Error('other'))).toBe(false);
    expect(isDelayedError(undefined)).toBe(false);
  });
});
