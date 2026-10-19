import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import { MessageStatusWriter } from './message-status.writer';

const TARGET = { messageId: 'm-1', tenantId: 't-1', instanceId: 'i-1', externalRef: 'owner-1' };

function setup(count: number) {
  const tx = { message: { updateMany: vi.fn(async () => ({ count })) } };
  const prisma = { $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)) };
  const outbox = { enqueue: vi.fn(async () => 'event-1') };
  const metrics = new MetricsService(testEnv());
  const writer = new MessageStatusWriter(prisma as never, outbox as never, metrics);
  return { writer, tx, outbox, metrics };
}

describe('MessageStatusWriter', () => {
  it('updates only from the earlier statuses and writes the outbox event in the same transaction', async () => {
    const s = setup(1);
    const at = new Date('2026-10-19T10:00:00Z');
    expect(await s.writer.apply(TARGET, { status: 'read', at })).toBe(true);
    expect(s.tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'm-1',
        tenantId: 't-1',
        direction: 'outbound',
        status: { in: ['queued', 'sent', 'delivered'] },
      },
      data: { status: 'read', readAt: at },
    });
    expect(s.outbox.enqueue).toHaveBeenCalledWith(s.tx, {
      tenantId: 't-1',
      type: 'message.status',
      payload: {
        instance_id: 'i-1',
        external_ref: 'owner-1',
        message_id: 'm-1',
        status: 'read',
        failure_reason: null,
      },
    });
  });

  it('writes no event when the status is already at or after the new one', async () => {
    const s = setup(0);
    const changed = await s.writer.apply(TARGET, {
      status: 'failed',
      reason: 'rejected',
      at: new Date(),
    });
    expect(changed).toBe(false);
    expect(s.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('writes the failure reason and the provider id', async () => {
    const s = setup(1);
    await s.writer.apply(TARGET, { status: 'failed', reason: 'rejected', at: new Date() });
    expect(s.tx.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', failureReason: 'rejected' } }),
    );
    expect(s.outbox.enqueue).toHaveBeenCalledWith(
      s.tx,
      expect.objectContaining({ payload: expect.objectContaining({ failure_reason: 'rejected' }) }),
    );
    const at = new Date();
    await s.writer.apply(TARGET, { status: 'sent', providerMessageId: 'WAID', at });
    expect(s.tx.message.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: 'sent', providerMessageId: 'WAID', sentAt: at } }),
    );
  });
});
