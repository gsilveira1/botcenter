import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import type { InboundHandlerRegistry } from '../../inbound/inbound-handler.registry';
import { MetricsService } from '../../metrics/metrics.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { RetryLaterError } from '../../queues/retry-later';
import { ConversationMetrics } from '../conversation-metrics';
import type { ConversationRuntime } from './conversation-runtime.service';
import type { InstanceContext, InstanceResolver } from './instance-context';
import { PENDING_SWEEP_MIN_AGE_MS, PendingInboundSweep } from './pending-inbound.sweep';

const instance: InstanceContext = {
  tenantId: 't1',
  instanceId: 'i1',
  providerName: 'inst_1',
  externalRef: 'o1',
  botId: 'b1',
};
const now = new Date('2026-10-19T12:00:00.000Z');

function build(groups: { tenantId: string; instanceId: string; contact: string }[]) {
  const queryRaw = vi.fn(async () => groups);
  const updateMany = vi.fn(async () => ({ count: 2 }));
  const prisma = {
    $queryRaw: queryRaw,
    forTenant: () => ({ message: { updateMany } }),
  } as unknown as PrismaService;
  const byId = vi.fn(async (_tenantId: string, instanceId: string) =>
    instanceId === 'gone' ? null : { ...instance, instanceId },
  );
  const drain = vi.fn(async (_instance: InstanceContext, _contact: string) => undefined);
  const registry = { registerSweep: vi.fn() };
  const metrics = new ConversationMetrics(new MetricsService(testEnv()));
  const sweep = new PendingInboundSweep(
    registry as unknown as InboundHandlerRegistry,
    prisma,
    { byId } as unknown as InstanceResolver,
    { drain } as unknown as ConversationRuntime,
    metrics,
  );
  return { sweep, queryRaw, updateMany, drain, registry, metrics };
}

describe('PendingInboundSweep (ARCH-01)', () => {
  it('registers itself as a task of the sweep-inbound job', () => {
    const { sweep, registry } = build([]);
    sweep.onModuleInit();
    expect(registry.registerSweep).toHaveBeenCalledWith(sweep);
  });

  it('drains each conversation with botPending rows older than one minute', async () => {
    const { sweep, queryRaw, drain, metrics } = build([
      { tenantId: 't1', instanceId: 'i1', contact: '5511900000001' },
      { tenantId: 't1', instanceId: 'i2', contact: '5511900000002' },
    ]);
    await expect(sweep.run(now)).resolves.toEqual({ drained: 2, busy: 0, dropped: 0 });
    const values = (queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toContainEqual(new Date(now.getTime() - PENDING_SWEEP_MIN_AGE_MS));
    expect(drain).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'i1' }),
      '5511900000001',
    );
    expect(drain).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'i2' }),
      '5511900000002',
    );
    expect((await metrics.repairs.get()).values).toEqual([
      { labels: { kind: 'pending_drained' }, value: 2 },
    ]);
  });

  it('leaves a busy conversation to the lock holder and continues', async () => {
    const { sweep, drain } = build([
      { tenantId: 't1', instanceId: 'i1', contact: 'a' },
      { tenantId: 't1', instanceId: 'i1', contact: 'b' },
    ]);
    drain.mockRejectedValueOnce(new RetryLaterError(1_000, 'conversation lock busy'));
    await expect(sweep.run(now)).resolves.toEqual({ drained: 1, busy: 1, dropped: 0 });
  });

  it('consumes the rows of a deleted instance, so the sweep does not read them again', async () => {
    const { sweep, updateMany, drain } = build([
      { tenantId: 't1', instanceId: 'gone', contact: 'a' },
    ]);
    await expect(sweep.run(now)).resolves.toEqual({ drained: 0, busy: 0, dropped: 2 });
    expect(drain).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { instanceId: 'gone', contact: 'a', botPending: true },
      data: { botPending: false },
    });
  });

  it('continues after a failed conversation and fails the run at the end', async () => {
    const { sweep, drain } = build([
      { tenantId: 't1', instanceId: 'i1', contact: 'a' },
      { tenantId: 't1', instanceId: 'i1', contact: 'b' },
    ]);
    drain.mockRejectedValueOnce(new Error('db down'));
    await expect(sweep.run(now)).rejects.toThrow(/1 of 2/);
    expect(drain).toHaveBeenCalledTimes(2);
  });
});
