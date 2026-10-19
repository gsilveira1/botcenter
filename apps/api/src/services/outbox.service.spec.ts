import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../prisma/prisma.service';
import { OutboxPayloadError, OutboxService } from './outbox.service';

const payload = {
  instance_id: '0192a0b0-0000-7000-8000-000000000001',
  external_ref: 'trainer-1',
  status: 'connected' as const,
  phone_masked: '5511*****4321',
};

describe('OutboxService', () => {
  it('validates the payload with the contracts and inserts it with the transaction client', async () => {
    const create = vi.fn(async () => ({ id: 'evt-1' }));
    const tx = { outboxEvent: { create } } as unknown as TransactionClient;
    await expect(
      new OutboxService().enqueue(tx, { tenantId: 't', type: 'instance.status', payload }),
    ).resolves.toBe('evt-1');
    expect(create).toHaveBeenCalledWith({
      data: { tenantId: 't', type: 'instance.status', payload },
      select: { id: true },
    });
  });

  it('throws OutboxPayloadError for a payload that does not match', async () => {
    const tx = { outboxEvent: { create: vi.fn() } } as unknown as TransactionClient;
    await expect(
      new OutboxService().enqueue(tx, {
        tenantId: 't',
        type: 'instance.status',
        payload: { ...payload, phone_masked: '5511987654321' },
      }),
    ).rejects.toBeInstanceOf(OutboxPayloadError);
  });
});
