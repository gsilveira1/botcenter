import { ProviderError } from '@botcenter/whatsapp-provider';
import { FakeWhatsAppProvider } from '@botcenter/whatsapp-provider/testing';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MediaUnavailableError } from '../media/media.service';
import { MetricsService } from '../metrics/metrics.service';
import type { OutboundJob } from '../queues/queue-names';
import { RetryLaterError, isDelayedError } from '../queues/worker.factory';
import { OutboundRateGate } from './outbound-rate-gate';
import { OutboundSender, blockedReason } from './outbound-sender';
import type { OutboundInstance } from './outbound-sender';
import { RetryableSendError } from './retry-policy';

const INSTANCE = 'inst_00000000-0000-0000-0000-000000000001';

function instance(overrides: Partial<OutboundInstance> = {}): OutboundInstance {
  return {
    providerName: INSTANCE,
    status: 'connected',
    deletedAt: null,
    rateLimitPerMinute: 20,
    firstConnectedAt: new Date('2026-01-01T00:00:00Z'),
    externalRef: 'owner-1',
    ...overrides,
  };
}

interface Setup {
  sender: OutboundSender;
  gate: OutboundRateGate;
  provider: FakeWhatsAppProvider;
  job: Job<OutboundJob>;
  message: Record<string, unknown>;
  writer: { apply: ReturnType<typeof vi.fn> };
  bucket: { take: ReturnType<typeof vi.fn>; refund: ReturnType<typeof vi.fn> };
  findFirst: ReturnType<typeof vi.fn>;
  media: { content: ReturnType<typeof vi.fn> };
  alerts: { notify: ReturnType<typeof vi.fn> };
  order: { hasOlderQueued: ReturnType<typeof vi.fn>; promoteNext: ReturnType<typeof vi.fn> };
  metrics: MetricsService;
}

async function setup(): Promise<Setup> {
  const provider = new FakeWhatsAppProvider();
  await provider.createInstance({ name: INSTANCE, webhookUrl: 'http://x', webhookSecret: 's' });
  provider.setState(INSTANCE, 'connected');
  const message: Record<string, unknown> = {
    id: 'm-1',
    tenantId: 't-1',
    instanceId: 'i-1',
    status: 'queued',
    contact: '5511987654321',
    priority: 'reply',
    seq: 7n,
    content: { type: 'text', text: 'Oi' },
    typingDelayMs: 1200,
    createdAt: new Date(Date.now() - 1_000),
    instance: instance(),
  };
  const findFirst = vi.fn(async () => message);
  const prisma = { forTenant: () => ({ message: { findFirst } }) };
  const limits = {
    get: vi.fn(async () => ({
      rateLimitPerMinute: 20,
      firstConnectedAt: new Date('2026-01-01T00:00:00Z'),
    })),
  };
  const writer = { apply: vi.fn(async () => true) };
  const bucket = {
    take: vi.fn(async () => ({ allowed: true, waitMs: 0 })),
    refund: vi.fn(async () => {}),
  };
  const media = {
    content: vi.fn(async (_job: unknown, _tenant: string, content: unknown) => content),
  };
  const alerts = { notify: vi.fn(async () => {}) };
  const order = {
    hasOlderQueued: vi.fn(async () => false),
    promoteNext: vi.fn(async () => {}),
  };
  const env = testEnv();
  const metrics = new MetricsService(env);
  const gate = new OutboundRateGate(bucket as never, limits as never, metrics, env);
  const sender = new OutboundSender(
    prisma as never,
    provider,
    writer as never,
    gate,
    media as never,
    metrics,
    alerts as never,
    order as never,
  );
  const job = {
    data: { tenantId: 't-1', messageId: 'm-1', instanceId: 'i-1' },
    opts: { priority: 1 },
    attemptsMade: 0,
    token: 'lock-token',
    moveToDelayed: vi.fn(async () => {}),
    updateData: vi.fn(async (data: OutboundJob) => {
      job.data = data;
    }),
  } as unknown as Job<OutboundJob>;
  return {
    sender,
    gate,
    provider,
    job,
    message,
    writer,
    bucket,
    findFirst,
    media,
    alerts,
    order,
    metrics,
  };
}

async function counter(metrics: MetricsService, name: string, labels: Record<string, string>) {
  const metric = (await metrics.registry.getSingleMetric(name)?.get()) ?? { values: [] };
  return (
    metric.values.find((value) =>
      Object.entries(labels).every(([key, label]) => value.labels[key] === label),
    )?.value ?? 0
  );
}

describe('OutboundSender', () => {
  let s: Setup;

  beforeEach(async () => {
    s = await setup();
  });

  it('sends with the typing delay, keeps the provider id in the job, and writes sent', async () => {
    expect(await s.sender.process(s.job)).toBe('sent');
    const [send] = s.provider.sentTo(INSTANCE);
    expect(send?.input).toEqual({
      to: '5511987654321',
      content: { type: 'text', text: 'Oi' },
      typingDelayMs: 1200,
    });
    expect(s.job.data.providerMessageId).toBe(send?.providerMessageId);
    expect(s.writer.apply).toHaveBeenCalledWith(
      { messageId: 'm-1', tenantId: 't-1', instanceId: 'i-1', externalRef: 'owner-1' },
      expect.objectContaining({ status: 'sent', providerMessageId: send?.providerMessageId }),
    );
  });

  it('does nothing for a message that is not queued', async () => {
    s.message['status'] = 'sent';
    expect(await s.sender.process(s.job)).toBe('skipped');
    expect(s.provider.sent).toHaveLength(0);
    expect(s.writer.apply).not.toHaveBeenCalled();
  });

  it('moves the job back without an attempt when the bucket has no token', async () => {
    s.bucket.take.mockResolvedValueOnce({ allowed: false, waitMs: 2_500 });
    const before = Date.now();
    const error = await s.sender.process(s.job).catch((caught: unknown) => caught);
    expect(isDelayedError(error)).toBe(true);
    const [timestamp, token] = vi.mocked(s.job.moveToDelayed).mock.calls[0] ?? [];
    expect(timestamp).toBeGreaterThanOrEqual(before + 2_500);
    expect(token).toBe('lock-token');
    expect(s.provider.sent).toHaveLength(0);
    expect(s.writer.apply).not.toHaveBeenCalled();
    expect(
      await counter(s.metrics, 'botcenter_rate_limit_denied_total', { scope: 'instance' }),
    ).toBe(1);
  });

  it('waits without an attempt while an older row of the contact is queued (ARCH-02)', async () => {
    s.order.hasOlderQueued.mockResolvedValue(true);
    const first = await s.sender.process(s.job).catch((caught: unknown) => caught);
    expect(first).toBeInstanceOf(RetryLaterError);
    expect((first as RetryLaterError).delayMs).toBe(1_000);
    const second = await s.sender.process(s.job).catch((caught: unknown) => caught);
    expect((second as RetryLaterError).delayMs).toBe(2_000);
    expect(s.job.data.orderWaits).toBe(2);
    // The job gives its send token back.
    expect(s.bucket.refund).toHaveBeenCalledTimes(2);
    expect(s.provider.sent).toHaveLength(0);
    expect(s.order.hasOlderQueued).toHaveBeenCalledWith(
      expect.objectContaining({ contact: '5511987654321', priority: 'reply', seq: 7n }),
    );
  });

  it('promotes the next row of the contact after a send and after a failure', async () => {
    expect(await s.sender.process(s.job)).toBe('sent');
    expect(s.order.promoteNext).toHaveBeenCalledTimes(1);
    s.message['instance'] = instance({ status: 'logged_out' });
    expect(await s.sender.process(s.job)).toBe('failed');
    expect(s.order.promoteNext).toHaveBeenCalledTimes(2);
  });

  it('takes the token before the database read, and keeps the ready time in the job (ARCH-10)', async () => {
    s.bucket.take.mockResolvedValueOnce({ allowed: false, waitMs: 9_000 });
    const before = Date.now();
    const error = await s.sender.process(s.job).catch((caught: unknown) => caught);
    expect(isDelayedError(error)).toBe(true);
    expect(s.findFirst).not.toHaveBeenCalled();
    expect(s.job.data.readyAt).toBeGreaterThanOrEqual(before + 9_000);
    // A reply does not wait in the line of the bulk sends.
    expect(s.bucket.take).toHaveBeenCalledWith(
      'i-1',
      { ratePerMinute: 20, burst: 3 },
      {
        spread: false,
      },
    );
  });

  it('asks the bucket for a place in the line for a bulk send (ARCH-10)', async () => {
    (s.job.opts as { priority: number }).priority = 10;
    await s.sender.process(s.job);
    expect(s.bucket.take).toHaveBeenCalledWith('i-1', expect.anything(), { spread: true });
  });

  it('gives the token back when the message is not sent now (ARCH-10)', async () => {
    s.message['status'] = 'sent';
    expect(await s.sender.process(s.job)).toBe('skipped');
    s.message['status'] = 'queued';
    s.order.hasOlderQueued.mockResolvedValueOnce(true);
    await s.sender.process(s.job).catch(() => undefined);
    expect(s.bucket.refund).toHaveBeenCalledTimes(2);
    expect(s.bucket.refund).toHaveBeenCalledWith('i-1', { ratePerMinute: 20, burst: 3 });
  });

  it('fails at once for an invalid recipient', async () => {
    s.provider.addInvalidRecipient('5511987654321');
    expect(await s.sender.process(s.job)).toBe('failed');
    expect(s.writer.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', reason: 'invalid_recipient' }),
    );
  });

  it('throws RetryableSendError for an unavailable provider and writes nothing', async () => {
    s.provider.failNext('sendMessage', new ProviderError('unavailable', 'x', 503));
    const error = await s.sender.process(s.job).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetryableSendError);
    expect((error as RetryableSendError).delayMs).toBe(5_000);
    expect(s.writer.apply).not.toHaveBeenCalled();
  });

  it('counts a timeout as an ambiguous send and fails after the second one', async () => {
    s.provider.failNext('sendMessage', new ProviderError('unavailable', 'timed out'), 2);
    const first = await s.sender.process(s.job).catch((caught: unknown) => caught);
    expect(first).toMatchObject({ kind: 'ambiguous', delayMs: 60_000 });
    expect(s.job.data.ambiguousSends).toBe(1);

    (s.job as { attemptsMade: number }).attemptsMade = 1;
    expect(await s.sender.process(s.job)).toBe('failed');
    expect(s.writer.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', reason: 'send_timeout' }),
    );
    expect(s.alerts.notify).toHaveBeenCalledOnce();
  });

  it('writes failed on the last attempt of a retryable error', async () => {
    s.provider.setState(INSTANCE, 'disconnected');
    (s.job as { attemptsMade: number }).attemptsMade = 5;
    expect(await s.sender.process(s.job)).toBe('failed');
    expect(s.writer.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', reason: 'not_connected' }),
    );
  });

  it('does not send again when an earlier run kept the provider id', async () => {
    s.job.data.providerMessageId = 'WAID-1';
    expect(await s.sender.process(s.job)).toBe('sent');
    expect(s.provider.sent).toHaveLength(0);
    expect(s.bucket.take).not.toHaveBeenCalled();
    expect(s.writer.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'sent', providerMessageId: 'WAID-1' }),
    );
  });

  it('fails a media message whose file is missing', async () => {
    s.message['content'] = { type: 'media', media_type: 'image', media_id: 'x' };
    s.media.content.mockRejectedValueOnce(new MediaUnavailableError('media_not_uploaded'));
    expect(await s.sender.process(s.job)).toBe('failed');
    expect(s.writer.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'media_not_uploaded' }),
    );
  });

  it('fails a message of a deleted or logged out instance without a send', async () => {
    s.message['instance'] = instance({ status: 'logged_out' });
    expect(await s.sender.process(s.job)).toBe('failed');
    expect(s.provider.sent).toHaveLength(0);
    expect(blockedReason(instance({ deletedAt: new Date() }))).toBe('instance_deleted');
    expect(blockedReason(instance({ status: 'disconnected' }))).toBeNull();
  });

  it('uses the warm-up rate for a new number', () => {
    const fresh = instance({ firstConnectedAt: new Date() });
    expect(s.gate.limitsFor(fresh)).toEqual({ ratePerMinute: 4, burst: 3 });
    expect(s.gate.limitsFor(instance())).toEqual({ ratePerMinute: 20, burst: 3 });
  });
});
