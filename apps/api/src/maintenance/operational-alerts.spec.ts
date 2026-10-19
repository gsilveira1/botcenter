import { describe, expect, it } from 'vitest';
import { testEnv } from '../../test/support/env';
import { RecordingAlertService } from '../../test/support/recording-alerts';
import { IncidentService } from './incident.service';
import {
  SEND_FAILURE_MIN_SAMPLE,
  sendFailureRateExceeded,
  webhookTenantFailing,
} from './operational-alerts.task';

/** A Redis double with the hash commands of `IncidentService`. */
function fakeRedis() {
  const hash = new Map<string, string>();
  return {
    hsetnx: async (_key: string, field: string, value: string) =>
      hash.has(field) ? 0 : (hash.set(field, value), 1),
    hget: async (_key: string, field: string) => hash.get(field) ?? null,
    hdel: async (_key: string, field: string) => (hash.delete(field) ? 1 : 0),
    hkeys: async () => [...hash.keys()],
  };
}

describe('IncidentService', () => {
  const alert = { severity: 'critical' as const, title: 'Down' };
  const recovery = { severity: 'info' as const, title: 'Resolved' };

  it('sends one alert for each incident and one recovery message', async () => {
    const alerts = new RecordingAlertService(testEnv());
    const incidents = new IncidentService(fakeRedis() as never, alerts);
    expect(await incidents.update('outbound-delay', true, alert, recovery)).toBe('opened');
    expect(await incidents.update('outbound-delay', true, alert, recovery)).toBe('unchanged');
    expect(await incidents.update('outbound-delay', false, alert, recovery)).toBe('resolved');
    expect(await incidents.update('outbound-delay', false, alert, recovery)).toBe('unchanged');
    expect(alerts.alerts.map((sent) => sent.title)).toEqual(['Down', 'Resolved']);
    expect(alerts.alerts[1]?.details?.['open_since']).toEqual(expect.any(String));
  });

  it('lists the open incidents by prefix', async () => {
    const incidents = new IncidentService(
      fakeRedis() as never,
      new RecordingAlertService(testEnv()),
    );
    await incidents.raise('webhook-failures:a', alert);
    await incidents.raise('outbox-lag', alert);
    expect(await incidents.openKeys('webhook-failures:')).toEqual(['webhook-failures:a']);
  });
});

describe('alert rules', () => {
  it('needs a minimum sample and more than 5 % failures for the send rate', () => {
    expect(sendFailureRateExceeded({ failed: 2, finished: SEND_FAILURE_MIN_SAMPLE - 1 })).toBe(
      false,
    );
    expect(sendFailureRateExceeded({ failed: 1, finished: 20 })).toBe(false);
    expect(sendFailureRateExceeded({ failed: 2, finished: 20 })).toBe(true);
  });

  it('marks a tenant as failing for one dead delivery or for half of the attempts failing', () => {
    const base = { tenantId: 't', dead: 0, failing: 0, attempted: 0 };
    expect(webhookTenantFailing(base)).toBe(false);
    expect(webhookTenantFailing({ ...base, dead: 1, failing: 1, attempted: 1 })).toBe(true);
    expect(webhookTenantFailing({ ...base, failing: 4, attempted: 9 })).toBe(false);
    expect(webhookTenantFailing({ ...base, failing: 5, attempted: 10 })).toBe(true);
    expect(webhookTenantFailing({ ...base, failing: 4, attempted: 10 })).toBe(false);
  });
});
