import { describe, expect, it, vi } from 'vitest';
import { OutboundSweep, SWEEP_BATCH_SIZE, SWEEP_MIN_AGE_MS } from './outbound-sweep';

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
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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

  it('continues after the last row of a full page at the next run (ARCH-10)', async () => {
    const page = Array.from({ length: SWEEP_BATCH_SIZE }, (_, index) => ({
      ...row(`r-${index}`),
      createdAt: new Date(1_000 + index),
    }));
    const s = setup({});
    s.prisma.message.findMany.mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    s.queue.getJobState.mockResolvedValue('delayed');
    await s.sweep.run();
    await s.sweep.run();
    const second = (s.prisma.message.findMany.mock.calls as unknown[][])[1]?.[0] as {
      where: { OR?: unknown };
    };
    expect(second.where.OR).toEqual([
      { createdAt: { gt: new Date(1_000 + SWEEP_BATCH_SIZE - 1) } },
      {
        createdAt: new Date(1_000 + SWEEP_BATCH_SIZE - 1),
        id: { gt: `r-${SWEEP_BATCH_SIZE - 1}` },
      },
    ]);
    // A short page ends the pass: the next run starts at the oldest row again.
    await s.sweep.run();
    const third = (s.prisma.message.findMany.mock.calls as unknown[][])[2]?.[0] as {
      where: { OR?: unknown };
    };
    expect(third.where.OR).toBeUndefined();
  });
});
