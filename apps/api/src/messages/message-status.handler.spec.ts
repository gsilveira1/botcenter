import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { InboundHandlerRegistry } from '../inbound/inbound-handler.registry';
import type { ProviderEventOf } from '../inbound/inbound-handler.registry';
import { MetricsService } from '../metrics/metrics.service';
import { MessageStatusHandler, StatusTargetNotReadyError } from './message-status.handler';

const INSTANCE = { id: 'i-1', tenantId: 't-1', externalRef: 'owner-1' };

function setup(message: { id: string; status: string } | null, instance = INSTANCE) {
  const findFirst = vi.fn(async () => message);
  const prisma = {
    instance: { findUnique: vi.fn(async () => instance) },
    forTenant: vi.fn(() => ({ message: { findFirst } })),
  };
  const writer = { apply: vi.fn(async () => true) };
  const metrics = new MetricsService(testEnv());
  const registry = new InboundHandlerRegistry();
  const handler = new MessageStatusHandler(registry, prisma as never, writer as never, metrics);
  handler.onModuleInit();
  return { handler, prisma, findFirst, writer, metrics, registry };
}

const RECEIVED_AT = new Date('2026-10-19T10:00:01Z');
const NOW = new Date('2026-10-19T10:00:02Z');

function context(attemptsMade: number) {
  return { jobId: 'in-1', attemptsMade, rawEventId: null, receivedAt: RECEIVED_AT };
}

function event(
  status: 'sent' | 'delivered' | 'read' | 'failed',
): ProviderEventOf<'message.status'> {
  return {
    kind: 'message.status',
    instanceName: 'inst_x',
    dedupeKey: `message.status:inst_x:WAID:${status}`,
    occurredAt: new Date('2026-10-19T10:00:00Z'),
    providerMessageId: 'WAID',
    status,
  };
}

describe('MessageStatusHandler', () => {
  it('registers for message.status and moves the status forward with the event time', async () => {
    const s = setup({ id: 'm-1', status: 'sent' });
    expect(s.registry.get('message.status')).toBe(s.handler);
    await s.handler.handle(event('delivered'), context(0), NOW);
    expect(s.prisma.forTenant).toHaveBeenCalledWith('t-1');
    expect(s.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instanceId: 'i-1', providerMessageId: 'WAID', direction: 'outbound' },
      }),
    );
    expect(s.writer.apply).toHaveBeenCalledWith(
      { messageId: 'm-1', tenantId: 't-1', instanceId: 'i-1', externalRef: 'owner-1' },
      { status: 'delivered', at: new Date('2026-10-19T10:00:00Z') },
    );
  });

  it('ignores an event that does not move the status forward', async () => {
    const s = setup({ id: 'm-1', status: 'read' });
    await s.handler.handle(event('delivered'), context(0), NOW);
    await s.handler.handle(event('failed'), context(0), NOW);
    expect(s.writer.apply).not.toHaveBeenCalled();
  });

  it('maps a provider failure to failure_reason provider_error', async () => {
    const s = setup({ id: 'm-1', status: 'sent' });
    await s.handler.handle(event('failed'), context(0), NOW);
    expect(s.writer.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', reason: 'provider_error' }),
    );
  });

  it('retries a young event for an unknown message (the worker can still write the provider id)', async () => {
    const s = setup(null);
    await expect(s.handler.handle(event('delivered'), context(0), NOW)).rejects.toBeInstanceOf(
      StatusTargetNotReadyError,
    );
    const late = new Date(RECEIVED_AT.getTime() + 61_000);
    await expect(s.handler.handle(event('delivered'), context(1), late)).resolves.toBeUndefined();
  });

  it('counts an unknown message after the retries and ends without an error', async () => {
    const s = setup(null);
    await expect(s.handler.handle(event('read'), context(3), NOW)).resolves.toBeUndefined();
    expect(s.writer.apply).not.toHaveBeenCalled();
    const metric = await s.metrics.registry
      .getSingleMetric('botcenter_inbound_events_total')
      ?.get();
    expect(metric?.values).toEqual([
      expect.objectContaining({ labels: { result: 'unknown_message' }, value: 1 }),
    ]);
  });
});
