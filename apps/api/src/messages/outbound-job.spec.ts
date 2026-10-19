import { describe, expect, it } from 'vitest';
import { JOB_PRIORITY, outboundJobOptions } from './outbound-job';
import { OUTBOUND_MAX_ATTEMPTS } from './retry-policy';

describe('outboundJobOptions', () => {
  it('uses the message id as the job id and puts a reply before a bulk send', () => {
    const reply = outboundJobOptions('m-1', 'reply');
    const bulk = outboundJobOptions('m-2', 'bulk');
    expect(reply).toEqual({
      jobId: 'm-1',
      priority: JOB_PRIORITY.reply,
      attempts: OUTBOUND_MAX_ATTEMPTS,
      backoff: { type: 'outbound' },
    });
    // BullMQ: a lower number goes first.
    expect(reply.priority).toBeLessThan(bulk.priority ?? 0);
  });
});
