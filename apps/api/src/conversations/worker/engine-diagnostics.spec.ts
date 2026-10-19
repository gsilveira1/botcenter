import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { MetricsService } from '../../metrics/metrics.service';
import type { AlertService } from '../../services/alert.service';
import { ConversationMetrics } from '../conversation-metrics';
import { EngineDiagnosticsReporter } from './engine-diagnostics';

describe('EngineDiagnosticsReporter', () => {
  it('counts every diagnostic and alerts only for the error severity', async () => {
    const metrics = new ConversationMetrics(new MetricsService(testEnv()));
    const alerts = { notify: vi.fn(async () => undefined) };
    const reporter = new EngineDiagnosticsReporter(alerts as unknown as AlertService, metrics);
    await reporter.report(
      [
        { code: 'no_transition_matched', severity: 'info', message: 'x' },
        { code: 'external_call_failed', severity: 'warning', message: 'x' },
        { code: 'message_invalid', severity: 'error', message: 'x', path: ['states', 'a'] },
      ],
      { tenantId: 't1', conversationId: 'c1', botSlug: 'bot', botVersion: 2 },
    );
    const values = (await metrics.diagnostics.get()).values;
    expect(values.map((value) => value.labels['severity']).sort()).toEqual([
      'error',
      'info',
      'warning',
    ]);
    expect(alerts.notify).toHaveBeenCalledTimes(1);
    expect(alerts.notify).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'engine:t1:bot:message_invalid' }),
    );
  });

  it('does not wait for a slow alert while the step holds the lock (ARCH-20)', async () => {
    const metrics = new ConversationMetrics(new MetricsService(testEnv()));
    const alerts = { notify: vi.fn(() => new Promise<void>(() => undefined)) };
    const reporter = new EngineDiagnosticsReporter(alerts as unknown as AlertService, metrics);
    await expect(
      reporter.report([{ code: 'message_invalid', severity: 'error', message: 'x' }], {
        tenantId: 't1',
        conversationId: 'c1',
        botSlug: 'bot',
        botVersion: 2,
      }),
    ).resolves.toBeUndefined();
    expect(alerts.notify).toHaveBeenCalledTimes(1);
  });
});
