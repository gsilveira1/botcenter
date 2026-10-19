import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { AlertService } from './alert.service';

const URL = 'https://discord.test/api/webhooks/1/abc';

describe('AlertService', () => {
  it('posts a Discord embed with the details and no mentions', async () => {
    const post = vi.fn(async () => 204);
    const service = new AlertService(testEnv({ ALERT_DISCORD_WEBHOOK_URL: URL }), post);
    await service.notify({
      severity: 'critical',
      title: 'Instance disconnected',
      details: { instance_id: 'i-1', skipped: undefined },
    });
    expect(post).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        allowed_mentions: { parse: [] },
        embeds: [
          expect.objectContaining({
            title: '[critical] Instance disconnected',
            fields: [{ name: 'instance_id', value: 'i-1', inline: true }],
          }),
        ],
      }),
      5000,
    );
  });

  it('never throws: a missing URL, a Discord error, and a network error are logged only', async () => {
    await expect(
      new AlertService(testEnv(), vi.fn()).notify({ severity: 'info', title: 'x' }),
    ).resolves.toBeUndefined();
    await expect(
      new AlertService(testEnv({ ALERT_DISCORD_WEBHOOK_URL: URL }), async () => 500).notify({
        severity: 'info',
        title: 'x',
      }),
    ).resolves.toBeUndefined();
    const failing = new AlertService(testEnv({ ALERT_DISCORD_WEBHOOK_URL: URL }), async () =>
      Promise.reject(new Error('timeout')),
    );
    await expect(failing.notify({ severity: 'info', title: 'x' })).resolves.toBeUndefined();
  });

  it('sends an alert with a dedupe key once in the window', async () => {
    const post = vi.fn(async () => 204);
    const service = new AlertService(testEnv({ ALERT_DISCORD_WEBHOOK_URL: URL }), post);
    await service.notify({ severity: 'warning', title: 'x', dedupeKey: 'k' }, 0);
    await service.notify({ severity: 'warning', title: 'x', dedupeKey: 'k' }, 60_000);
    await service.notify({ severity: 'warning', title: 'x', dedupeKey: 'k' }, 5 * 60_000);
    await service.notify({ severity: 'warning', title: 'x' }, 5 * 60_000);
    expect(post).toHaveBeenCalledTimes(3);
  });
});
