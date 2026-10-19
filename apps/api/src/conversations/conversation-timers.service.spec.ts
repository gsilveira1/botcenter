import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import type { QueuesService } from '../queues/queues.service';
import type { AlertService } from '../services/alert.service';
import { ConversationMetrics } from './conversation-metrics';
import { ConversationTimersService, TIMER_JOB_NAME } from './conversation-timers.service';

function build() {
  const add = vi.fn(async () => ({}));
  const remove = vi.fn(async () => 1);
  const queues = { add, get: vi.fn(() => ({ remove })) } as unknown as QueuesService;
  const alerts = { notify: vi.fn(async () => undefined) };
  const service = new ConversationTimersService(
    queues,
    alerts as unknown as AlertService,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  return { service, add, remove, alerts };
}

const now = new Date('2026-10-19T12:00:00.000Z');
const plan = {
  state: 'inicio',
  version: 3,
  jobId: 'timer-c1-v3',
  fireAt: new Date('2026-10-19T12:30:00.000Z'),
};

describe('ConversationTimersService', () => {
  it('adds the timer job with the deterministic id and the delay fireAt - now', async () => {
    const { service, add } = build();
    await service.schedule(plan, { tenantId: 't1', conversationId: 'c1' }, now);
    expect(add).toHaveBeenCalledWith(
      'timers',
      TIMER_JOB_NAME,
      { tenantId: 't1', conversationId: 'c1', state: 'inicio', conversationVersion: 3 },
      { jobId: 'timer-c1-v3', delay: 1_800_000 },
    );
  });

  it('alerts when the add fails, and only logs when a remove fails', async () => {
    const { service, add, remove, alerts } = build();
    add.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      service.schedule(plan, { tenantId: 't1', conversationId: 'c1' }, now),
    ).resolves.toBeUndefined();
    expect(alerts.notify).toHaveBeenCalledTimes(1);
    remove.mockRejectedValueOnce(new Error('locked'));
    await expect(service.cancel('timer-c1-v2')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith('timer-c1-v2');
  });
});
