import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import type { InboundHandlerRegistry } from '../../inbound/inbound-handler.registry';
import { MetricsService } from '../../metrics/metrics.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_JOB_OPTIONS } from '../../queues/queues.service';
import type { QueuesService } from '../../queues/queues.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { ConversationTimersService } from '../conversation-timers.service';
import { TIMER_REPAIR_MIN_LATE_MS, TimerRepairSweep } from './timer-repair.sweep';

const now = new Date('2026-10-19T12:00:00.000Z');
const fireAt = new Date('2026-10-19T11:50:00.000Z');

function conversation(id: string) {
  return { id, tenantId: 't1', state: 'espera', version: 4, timerFireAt: fireAt };
}

function build(states: Record<string, string>) {
  const findMany = vi.fn(async () => Object.keys(states).map(conversation));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    conversation: { findMany },
    forTenant: () => ({ conversation: { updateMany } }),
  } as unknown as PrismaService;
  const retry = vi.fn(async () => undefined);
  const queue = {
    getJobState: vi.fn(async (jobId: string) => states[jobId.slice(6, -3)] ?? 'unknown'),
    getJob: vi.fn(async () => ({ retry })),
  };
  const queues = { get: vi.fn(() => queue) } as unknown as QueuesService;
  const timers = { schedule: vi.fn(async () => true) };
  const metrics = new ConversationMetrics(new MetricsService(testEnv()));
  const registry = { registerSweep: vi.fn() };
  const sweep = new TimerRepairSweep(
    registry as unknown as InboundHandlerRegistry,
    prisma,
    queues,
    timers as unknown as ConversationTimersService,
    metrics,
  );
  return { sweep, findMany, updateMany, queue, retry, timers, metrics, registry };
}

describe('TimerRepairSweep (ARCH-08)', () => {
  it('registers itself as a task of the sweep-inbound job', () => {
    const { sweep, registry } = build({});
    sweep.onModuleInit();
    expect(registry.registerSweep).toHaveBeenCalledWith(sweep);
  });

  it('reads the overdue timers of the conversations that the bot runs', async () => {
    const { sweep, findMany } = build({});
    await sweep.run(now);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          timerFireAt: { lt: new Date(now.getTime() - TIMER_REPAIR_MIN_LATE_MS) },
          handoff: false,
        },
        orderBy: { timerFireAt: 'asc' },
      }),
    );
  });

  it('adds a lost timer job again with its deterministic id', async () => {
    const { sweep, timers, metrics } = build({ c1: 'unknown' });
    await expect(sweep.run(now)).resolves.toEqual({ rearmed: 1, cleared: 0, checked: 1 });
    expect(timers.schedule).toHaveBeenCalledWith(
      { state: 'espera', version: 4, jobId: 'timer-c1-v4', fireAt },
      { tenantId: 't1', conversationId: 'c1' },
      now,
    );
    expect((await metrics.repairs.get()).values).toEqual([
      { labels: { kind: 'timer_rearmed' }, value: 1 },
    ]);
  });

  it('retries a failed timer job, clears a completed one, and leaves a waiting one', async () => {
    const { sweep, retry, updateMany, timers } = build({
      c1: 'failed',
      c2: 'completed',
      c3: 'delayed',
      c4: 'active',
    });
    await expect(sweep.run(now)).resolves.toEqual({ rearmed: 1, cleared: 1, checked: 4 });
    expect(retry).toHaveBeenCalledWith('failed');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'c2', version: 4 },
      data: { timerFireAt: null },
    });
    expect(timers.schedule).not.toHaveBeenCalled();
  });

  it('gives a timer job a retry budget of at least 10 minutes', () => {
    const { attempts, backoff } = DEFAULT_JOB_OPTIONS.timers;
    const delay = (backoff as { delay: number }).delay;
    let total = 0;
    for (let retry = 1; retry < (attempts ?? 1); retry += 1) {
      total += delay * 2 ** (retry - 1);
    }
    expect(total).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
