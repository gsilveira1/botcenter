import { WebhookEvent } from '@botcenter/contracts';
import { describe, expect, it } from 'vitest';
import { fanOut } from './fan-out';
import type { OutboxRow } from './fan-out';

const TENANT_A = '0199a1b2-0000-7000-8000-00000000000a';
const TENANT_B = '0199a1b2-0000-7000-8000-00000000000b';
const now = new Date('2026-10-19T10:00:01.000Z');

function event(id: string, tenantId: string, type: string): OutboxRow {
  return {
    id,
    tenantId,
    type,
    createdAt: new Date('2026-10-19T10:00:00.000Z'),
    payload: {
      instance_id: '0199a1b2-0000-7000-8000-0000000000aa',
      external_ref: 'trainer-1',
      message_id: '0199a1b2-0000-7000-8000-0000000000bb',
      status: 'delivered',
      failure_reason: null,
    },
  };
}

describe('fanOut', () => {
  const subscriptions = [
    { id: 'sub-a-all', tenantId: TENANT_A, events: ['message.status', 'instance.status'] },
    { id: 'sub-a-received', tenantId: TENANT_A, events: ['message.received'] },
    { id: 'sub-b-all', tenantId: TENANT_B, events: ['message.status'] },
  ];

  it('makes one pending delivery for each matching subscription of the same tenant only', () => {
    const rows = fanOut(
      [event('0199a1b2-0000-7000-8000-000000000001', TENANT_A, 'message.status')],
      subscriptions,
      now,
    );
    expect(rows.map((row) => row.subscriptionId)).toEqual(['sub-a-all']);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT_A,
      eventId: '0199a1b2-0000-7000-8000-000000000001',
      eventType: 'message.status',
      status: 'pending',
      nextAttemptAt: now,
    });
  });

  it('writes the contracts WebhookEvent envelope as the body', () => {
    const [row] = fanOut(
      [event('0199a1b2-0000-7000-8000-000000000002', TENANT_B, 'message.status')],
      subscriptions,
      now,
    );
    const parsed = WebhookEvent.safeParse(row?.payload);
    expect(parsed.success).toBe(true);
    expect(row?.payload).toMatchObject({
      id: '0199a1b2-0000-7000-8000-000000000002',
      type: 'message.status',
      created_at: '2026-10-19T10:00:00.000Z',
    });
  });

  it('keeps the order of the events and gives nothing for an event without a subscription', () => {
    const rows = fanOut(
      [
        event('0199a1b2-0000-7000-8000-000000000003', TENANT_A, 'instance.status'),
        event('0199a1b2-0000-7000-8000-000000000004', TENANT_A, 'conversation.transitioned'),
        event('0199a1b2-0000-7000-8000-000000000005', TENANT_A, 'message.status'),
      ],
      subscriptions,
      now,
    );
    expect(rows.map((row) => row.eventId)).toEqual([
      '0199a1b2-0000-7000-8000-000000000003',
      '0199a1b2-0000-7000-8000-000000000005',
    ]);
  });
});
