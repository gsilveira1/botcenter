import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import { OutboundMessagesService } from './outbound-messages.service';

function setup(addBulk = vi.fn(async () => [])) {
  const prisma = {
    message: {
      findMany: vi.fn(async () => [
        { id: 'm-1', tenantId: 't-1', instanceId: 'i-1', priority: 'reply' },
      ]),
    },
  };
  const queues = { get: () => ({ addBulk }) };
  const quota = { consume: vi.fn(async () => async () => {}) };
  const alerts = { notify: vi.fn(async () => {}) };
  const service = new OutboundMessagesService(
    prisma as never,
    queues as never,
    quota as never,
    new MetricsService(testEnv()),
    alerts as never,
  );
  return { service, prisma, addBulk, quota, alerts };
}

const INPUT = {
  tenantId: 't-1',
  instanceId: 'i-1',
  to: '5511987654321',
  content: { type: 'text' as const, text: 'Oi' },
  conversationId: 'c-1',
  typingDelayMs: 800,
};

describe('OutboundMessagesService', () => {
  it('writes a queued row in the caller transaction; a reply does not use the quota', async () => {
    const s = setup();
    const tx = { message: { create: vi.fn(async () => ({ id: 'm-1' })) } };
    const result = await s.service.createInTx(tx as never, { ...INPUT, priority: 'reply' });
    expect(result).toEqual({ messageId: 'm-1' });
    expect(s.quota.consume).not.toHaveBeenCalled();
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 't-1',
        direction: 'outbound',
        status: 'queued',
        type: 'text',
        contact: '5511987654321',
        priority: 'reply',
        conversationId: 'c-1',
        typingDelayMs: 800,
      }),
      select: { id: true },
    });
    await s.service.createInTx(tx as never, { ...INPUT, priority: 'bulk' });
    expect(s.quota.consume).toHaveBeenCalledWith('t-1');
  });

  it('dispatches with the stored priority and the message id as the job id', async () => {
    const s = setup();
    await s.service.dispatch([{ tenantId: 't-1', messageId: 'm-1', instanceId: 'i-1' }]);
    expect(s.addBulk).toHaveBeenCalledWith([
      {
        name: 'send',
        data: { tenantId: 't-1', messageId: 'm-1', instanceId: 'i-1' },
        opts: expect.objectContaining({ jobId: 'm-1', priority: 1 }),
      },
    ]);
  });

  it('never throws when Redis fails: it logs, alerts, and leaves the rows to the sweep', async () => {
    const s = setup(vi.fn(async () => Promise.reject(new Error('redis down'))));
    await expect(
      s.service.dispatch([{ tenantId: 't-1', messageId: 'm-1', instanceId: 'i-1' }]),
    ).resolves.toBeUndefined();
    expect(s.alerts.notify).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'outbound:enqueue' }),
    );
  });

  it('never throws when the dispatch query fails', async () => {
    const s = setup();
    s.prisma.message.findMany.mockRejectedValueOnce(new Error('database down'));
    await expect(
      s.service.dispatch([{ tenantId: 't-1', messageId: 'm-1', instanceId: 'i-1' }]),
    ).resolves.toBeUndefined();
    expect(s.addBulk).not.toHaveBeenCalled();
  });
});
