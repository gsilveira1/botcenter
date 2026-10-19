import { describe, expect, it, vi } from 'vitest';
import { OutboundSweep, SWEEP_MIN_AGE_MS } from './outbound-sweep';

const row = (id: string) => ({
  id,
  tenantId: 't-1',
  instanceId: 'i-1',
  priority: 'bulk' as const,
  instance: { externalRef: 'owner-1' },
});

function setup(states: Record<string, string>) {
  const rows = Object.keys(states).map(row);
  const prisma = { message: { findMany: vi.fn(async () => rows) } };
  const queue = {
    getJobState: vi.fn(async (id: string) => states[id]),
    remove: vi.fn(async () => 1),
  };
  const queues = { get: () => queue };
  const outbound = { enqueue: vi.fn(async (list: unknown[]) => list.length) };
  const writer = { apply: vi.fn(async () => true) };
  const sweep = new OutboundSweep(
    prisma as never,
    queues as never,
    outbound as never,
    writer as never,
  );
  return { sweep, prisma, queue, outbound, writer };
}

describe('OutboundSweep', () => {
  it('reads only queued outbound rows older than one minute', async () => {
    const s = setup({});
    const now = new Date('2026-10-19T10:00:00Z');
    expect(await s.sweep.run(now)).toEqual({ checked: 0, requeued: 0, failed: 0 });
    expect(s.prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          direction: 'outbound',
          status: 'queued',
          createdAt: { lt: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  it('enqueues rows without a job, replaces completed jobs, fails rows with a failed job', async () => {
    const s = setup({ a: 'unknown', b: 'completed', c: 'failed', d: 'delayed', e: 'prioritized' });
    expect(await s.sweep.run()).toEqual({ checked: 5, requeued: 2, failed: 1 });
    expect(s.queue.remove).toHaveBeenCalledWith('b');
    expect(s.outbound.enqueue).toHaveBeenCalledWith([
      expect.objectContaining({ messageId: 'a', priority: 'bulk' }),
      expect.objectContaining({ messageId: 'b' }),
    ]);
    expect(s.writer.apply).toHaveBeenCalledWith(
      { messageId: 'c', tenantId: 't-1', instanceId: 'i-1', externalRef: 'owner-1' },
      expect.objectContaining({ status: 'failed', reason: 'internal_error' }),
    );
  });
});
