import { describe, expect, it, vi } from 'vitest';
import { ORDER_WAIT_MAX_MS, OutboundOrder, orderWaitMs } from './outbound-order';
import type { OrderedMessage } from './outbound-order';

const MESSAGE: OrderedMessage = {
  id: 'm-2',
  tenantId: 't-1',
  instanceId: 'i-1',
  contact: '5511987654321',
  priority: 'reply',
  seq: 12n,
};

function setup(next: { id: string } | null, delayed = true) {
  const message = { findFirst: vi.fn(async () => next) };
  const prisma = { forTenant: vi.fn(() => ({ message })) };
  const job = { isDelayed: vi.fn(async () => delayed), promote: vi.fn(async () => {}) };
  const queue = { getJob: vi.fn(async () => job) };
  const queues = { get: vi.fn(() => queue) };
  return { order: new OutboundOrder(prisma as never, queues as never), message, job, queue };
}

describe('OutboundOrder', () => {
  it('looks for an older queued row of the same instance, contact, and priority', async () => {
    const s = setup({ id: 'm-1' });
    expect(await s.order.hasOlderQueued(MESSAGE)).toBe(true);
    expect(s.message.findFirst).toHaveBeenCalledWith({
      where: {
        instanceId: 'i-1',
        contact: '5511987654321',
        priority: 'reply',
        direction: 'outbound',
        status: 'queued',
        seq: { lt: 12n },
      },
      select: { id: true },
    });
    expect(await setup(null).order.hasOlderQueued(MESSAGE)).toBe(false);
  });

  it('promotes the delayed job of the next queued row', async () => {
    const s = setup({ id: 'm-3' });
    await s.order.promoteNext(MESSAGE);
    expect(s.queue.getJob).toHaveBeenCalledWith('m-3');
    expect(s.job.promote).toHaveBeenCalled();
    expect(s.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { seq: 'asc' } }),
    );
  });

  it('does not promote a job that is not delayed, and never throws', async () => {
    const waiting = setup({ id: 'm-3' }, false);
    await waiting.order.promoteNext(MESSAGE);
    expect(waiting.job.promote).not.toHaveBeenCalled();
    const broken = setup({ id: 'm-3' });
    broken.job.promote.mockRejectedValue(new Error('Job m-3 is not in the delayed state'));
    await expect(broken.order.promoteNext(MESSAGE)).resolves.toBeUndefined();
    const failing = setup(null);
    failing.message.findFirst.mockRejectedValue(new Error('database down'));
    await expect(failing.order.promoteNext(MESSAGE)).resolves.toBeUndefined();
  });

  it('doubles the wait up to the maximum', () => {
    expect([0, 1, 2, 3].map(orderWaitMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(orderWaitMs(20)).toBe(ORDER_WAIT_MAX_MS);
  });
});
