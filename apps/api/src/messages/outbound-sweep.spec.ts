import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { OutboundSweep, SWEEP_BATCH_SIZE, SWEEP_MIN_AGE_MS } from './outbound-sweep';

const row = (id: string) => ({
  id,
  tenantId: 't-1',
  instanceId: 'i-1',
  priority: 'bulk' as const,
  instance: { externalRef: 'owner-1' },
});

const DAY_MS = 86_400_000;

interface FindArgs {
  where: { createdAt: { lt: Date }; OR?: unknown };
}

/** The expiry query reads rows older than one day; the sweep page reads rows older than one minute. */
const isExpiryQuery = (args: FindArgs) =>
  args.where.createdAt.lt.getTime() < Date.now() - DAY_MS / 2;

function setup(states: Record<string, string>, expired: ReturnType<typeof row>[] = []) {
  const rows = Object.keys(states).map(row);
  const pages: unknown[][] = [];
  const prisma = {
    message: {
      findMany: vi.fn(async (args: FindArgs) => {
        if (isExpiryQuery(args)) {
          return expired;
        }
        return pages.shift() ?? rows;
      }),
    },
  };
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
    testEnv(),
  );
  const pageCalls = () =>
    (prisma.message.findMany.mock.calls as unknown as [FindArgs][])
      .map(([args]) => args)
      .filter((args) => !isExpiryQuery(args));
  return { sweep, prisma, queue, outbound, writer, pages, pageCalls };
}

describe('OutboundSweep', () => {
  it('reads only queued outbound rows older than one minute', async () => {
    const s = setup({});
    const now = new Date('2026-10-19T10:00:00Z');
    expect(await s.sweep.run(now)).toEqual({ checked: 0, requeued: 0, failed: 0, expired: 0 });
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
    expect(await s.sweep.run()).toEqual({ checked: 5, requeued: 2, failed: 1, expired: 0 });
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
    s.pages.push(page, []);
    s.queue.getJobState.mockResolvedValue('delayed');
    await s.sweep.run();
    await s.sweep.run();
    const second = s.pageCalls()[1]!;
    expect(second.where.OR).toEqual([
      { createdAt: { gt: new Date(1_000 + SWEEP_BATCH_SIZE - 1) } },
      {
        createdAt: new Date(1_000 + SWEEP_BATCH_SIZE - 1),
        id: { gt: `r-${SWEEP_BATCH_SIZE - 1}` },
      },
    ]);
    // A short page ends the pass: the next run starts at the oldest row again.
    await s.sweep.run();
    const third = s.pageCalls()[2]!;
    expect(third.where.OR).toBeUndefined();
  });

  it('fails the queued rows older than the maximum age with the reason expired', async () => {
    const s = setup({}, [row('old-1'), row('old-2')]);
    const now = new Date('2026-10-19T10:00:00Z');
    const result = await s.sweep.run(now);
    expect(result.expired).toBe(2);
    const expiry = (s.prisma.message.findMany.mock.calls as unknown as [FindArgs][])[0]![0];
    expect(expiry.where).toEqual({
      direction: 'outbound',
      status: 'queued',
      createdAt: { lt: new Date(now.getTime() - DAY_MS) },
    });
    expect(s.writer.apply).toHaveBeenCalledWith(
      { messageId: 'old-1', tenantId: 't-1', instanceId: 'i-1', externalRef: 'owner-1' },
      expect.objectContaining({ status: 'failed', reason: 'expired' }),
    );
  });
});
