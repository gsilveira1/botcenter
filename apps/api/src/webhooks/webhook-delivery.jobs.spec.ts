import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { RecordingAlertService } from '../../test/support/recording-alerts';
import type { QueuesService } from '../queues/queues.service';
import { SecretBox, SecretBoxError } from '../services/secret-box';
import { WebhookDeliveryJobs, deliveryJobId } from './webhook-delivery.jobs';
import { generateWebhookSecret } from './webhook-delivery.policy';
import { WebhookSecrets } from './webhook-secrets';

const ref = {
  id: '0199a1b2-0000-7000-8000-000000000001',
  tenantId: '0199a1b2-0000-7000-8000-00000000000a',
  nextAttemptAt: new Date(1_760_000_060_000),
};

function queuesWith(addBulk: (jobs: unknown[]) => Promise<unknown>): QueuesService {
  return { get: () => ({ addBulk }) } as unknown as QueuesService;
}

describe('deliveryJobId', () => {
  it('is deterministic for one schedule and changes with a new schedule (no ":")', () => {
    expect(deliveryJobId(ref)).toBe(`wh-${ref.id}-1760000060000`);
    expect(deliveryJobId({ ...ref, nextAttemptAt: new Date(1_760_000_120_000) })).not.toBe(
      deliveryJobId(ref),
    );
    expect(deliveryJobId(ref)).not.toContain(':');
  });
});

describe('WebhookDeliveryJobs.enqueue', () => {
  it('adds one delayed job for each delivery with the deterministic id', async () => {
    const addBulk = vi.fn(async () => []);
    const jobs = new WebhookDeliveryJobs(queuesWith(addBulk), new RecordingAlertService(testEnv()));
    await expect(jobs.enqueue([ref], 1_760_000_000_000)).resolves.toBe(1);
    expect(addBulk).toHaveBeenCalledWith([
      {
        name: 'deliver',
        data: { tenantId: ref.tenantId, deliveryId: ref.id },
        opts: expect.objectContaining({ jobId: deliveryJobId(ref), delay: 60_000, attempts: 5 }),
      },
    ]);
  });

  it('logs and alerts when Redis fails, and does not throw (the sweep adds the job later)', async () => {
    const alerts = new RecordingAlertService(testEnv());
    const jobs = new WebhookDeliveryJobs(
      queuesWith(async () => {
        throw new Error('Connection is closed.');
      }),
      alerts,
    );
    await expect(jobs.enqueue([ref])).resolves.toBe(0);
    expect(alerts.alerts).toEqual([
      expect.objectContaining({ dedupeKey: 'webhooks:enqueue', severity: 'warning' }),
    ]);
  });
});

describe('WebhookSecrets', () => {
  const box = new SecretBox({ DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const secrets = new WebhookSecrets(box);
  const id = '0199a1b2-0000-7000-8000-0000000000cc';

  it('binds the sealed secret to the subscription id', () => {
    const secret = generateWebhookSecret();
    const sealed = secrets.seal(id, secret);
    expect(sealed).not.toContain(secret);
    const row = {
      id,
      secretEncrypted: sealed,
      previousSecretEncrypted: null,
      previousSecretExpiresAt: null,
    };
    expect(secrets.signingSecrets(row)).toEqual([secret]);
    expect(() =>
      secrets.signingSecrets({ ...row, id: '0199a1b2-0000-7000-8000-0000000000dd' }),
    ).toThrow(SecretBoxError);
  });

  it('adds the previous secret only before its end time', () => {
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const now = new Date('2026-10-19T10:00:00.000Z');
    const row = {
      id,
      secretEncrypted: secrets.seal(id, current),
      previousSecretEncrypted: secrets.seal(id, previous),
      previousSecretExpiresAt: new Date('2026-10-20T10:00:00.000Z'),
    };
    expect(secrets.signingSecrets(row, now)).toEqual([current, previous]);
    expect(secrets.signingSecrets(row, new Date('2026-10-20T10:00:00.001Z'))).toEqual([current]);
  });
});
