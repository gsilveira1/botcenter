import { randomUUID } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import { ProviderError } from '@botcenter/whatsapp-provider';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { inboundJobId } from '../../src/inbound/inbound-ingest.service';
import { MessagesApiModule, MessagesWorkerModule } from '../../src/messages/messages.module';
import { OutboundSweep } from '../../src/messages/outbound-sweep';
import { InstanceTokenBucket } from '../../src/messages/token-bucket';
import { MetricsService } from '../../src/metrics/metrics.service';
import { OUTBOUND_MESSAGES } from '../../src/ports/outbound-messages.port';
import type { OutboundMessagesPort } from '../../src/ports/outbound-messages.port';
import { QueuesService } from '../../src/queues/queues.service';
import { evolutionStatus } from '../support/fake-provider';
import { TestHarness } from '../support/harness';
import { waitFor } from '../support/wait-for';

const LONG_AGO = new Date('2026-01-01T00:00:00Z');

let h: TestHarness;
let worker: TestingModule;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [MessagesApiModule] });
  worker = await h.startWorker([MessagesWorkerModule]);
});

afterAll(async () => {
  await h?.close();
});

interface Fixture {
  tenant: Tenant;
  instance: Instance;
  key: string;
}

async function fixture(instance: Partial<Instance> = {}): Promise<Fixture> {
  const tenant = await h.createTenant();
  const row = await h.createInstance(tenant.id, {
    status: 'connected',
    firstConnectedAt: LONG_AGO,
    rateLimitPerMinute: 600,
    ...instance,
  });
  await h.provider.createInstance({ name: row.providerName, webhookUrl: 'x', webhookSecret: 's' });
  h.provider.setState(row.providerName, 'connected');
  const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['messages:send'] });
  return { tenant, instance: row, key };
}

async function send(f: Fixture, to = '5511987654321'): Promise<string> {
  const response = await h.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { ...h.bearer(f.key), 'content-type': 'application/json' },
    payload: JSON.stringify({ instance_id: f.instance.id, to, type: 'text', text: 'Oi' }),
  });
  expect(response.statusCode).toBe(202);
  return response.json().id as string;
}

function message(id: string) {
  return h.prisma.message.findUniqueOrThrow({ where: { id } });
}

async function waitForStatus(id: string, status: string, timeoutMs = 10_000) {
  await waitFor(async () => (await message(id)).status === status, timeoutMs);
  return message(id);
}

async function statusEvents(messageId: string) {
  const rows = await h.prisma.outboxEvent.findMany({
    where: { type: 'message.status' },
    orderBy: { createdAt: 'asc' },
  });
  return rows
    .map((row) => row.payload as { message_id: string; status: string; failure_reason: string })
    .filter((payload) => payload.message_id === messageId);
}

/**
 * Moves a delayed job to the wait list at once (the test skips the backoff). The job can leave the
 * delayed state at the same time; then there is nothing to do.
 */
async function skipDelay(job: Job | undefined): Promise<void> {
  if ((await job?.getState()) !== 'delayed') {
    return;
  }
  try {
    await job?.promote();
  } catch (error) {
    if (!(error as Error).message.includes('is not in the delayed state')) {
      throw error;
    }
  }
}

function outboundJob(id: string) {
  return h.get(QueuesService).get('outbound').getJob(id);
}

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await worker.get(MetricsService).registry.getSingleMetric(name)?.get();
  return (
    metric?.values.find((value) =>
      Object.entries(labels).every(([key, label]) => value.labels[key] === label),
    )?.value ?? 0
  );
}

describe('outbound worker (in-memory provider)', () => {
  it('sends a queued message, then moves it to delivered and read from the status webhooks', async () => {
    const f = await fixture();
    const id = await send(f);
    const sent = await waitForStatus(id, 'sent');
    expect(sent.providerMessageId).toBeTruthy();
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(h.provider.sentTo(f.instance.providerName)).toHaveLength(1);

    const delivered = evolutionStatus({
      instanceName: f.instance.providerName,
      messageId: sent.providerMessageId!,
      status: 'DELIVERY_ACK',
    });
    expect((await h.postProviderWebhook(delivered.body)).statusCode).toBe(200);
    expect((await waitForStatus(id, 'delivered')).deliveredAt).toBeInstanceOf(Date);

    const readEvent = evolutionStatus({
      instanceName: f.instance.providerName,
      messageId: sent.providerMessageId!,
      status: 'READ',
    });
    await h.postProviderWebhook(readEvent.body);
    expect((await waitForStatus(id, 'read')).readAt).toBeInstanceOf(Date);

    // A late `delivered` after `read` does not move the status back.
    const late = await h.postProviderWebhook(
      evolutionStatus({
        instanceName: f.instance.providerName,
        messageId: sent.providerMessageId!,
        status: 'SERVER_ACK',
      }).body,
    );
    expect(late.statusCode).toBe(200);
    expect((await statusEvents(id)).map((event) => event.status)).toEqual([
      'sent',
      'delivered',
      'read',
    ]);
    expect((await message(id)).status).toBe('read');
  });

  it('sends a bot reply of the port with its typing delay', async () => {
    const f = await fixture();
    const port = h.get<OutboundMessagesPort>(OUTBOUND_MESSAGES);
    const { messageId } = await h.prisma.$transaction(async (tx) =>
      port.createInTx(tx as never, {
        tenantId: f.tenant.id,
        instanceId: f.instance.id,
        to: '5511912345678',
        content: { type: 'text', text: 'Resposta' },
        priority: 'reply',
        typingDelayMs: 1500,
      }),
    );
    await port.dispatch([{ tenantId: f.tenant.id, messageId, instanceId: f.instance.id }]);
    await waitForStatus(messageId, 'sent');
    const [sendCall] = h.provider.sentTo(f.instance.providerName);
    expect(sendCall?.input).toMatchObject({ to: '5511912345678', typingDelayMs: 1500 });
    expect((await outboundJob(messageId))?.opts.priority).toBe(1);
  });

  it('fails at once for an invalid recipient, with the outbox event', async () => {
    const f = await fixture();
    h.provider.addInvalidRecipient('5511900000001');
    const id = await send(f, '5511900000001');
    const failed = await waitForStatus(id, 'failed');
    expect(failed.failureReason).toBe('invalid_recipient');
    expect(await statusEvents(id)).toEqual([
      expect.objectContaining({ status: 'failed', failure_reason: 'invalid_recipient' }),
    ]);
    // One run, no retry (BullMQ counts the completed run).
    expect((await outboundJob(id))?.attemptsMade).toBe(1);
  });

  it('retries an unavailable provider with backoff, then writes failed after the last attempt', async () => {
    const f = await fixture();
    h.provider.failNext('sendMessage', new ProviderError('unavailable', 'fake 503', 503), 6);
    const id = await send(f);
    // Skip the backoff waits: promote each delayed retry at once.
    await waitFor(async () => {
      await skipDelay(await outboundJob(id));
      return (await message(id)).status === 'failed';
    }, 30_000);
    const failed = await message(id);
    expect(failed.failureReason).toBe('provider_unavailable');
    const job = await outboundJob(id);
    // Six runs: five retries, then the policy writes `failed` and the job completes.
    expect(job?.attemptsMade).toBe(6);
    expect(await job?.getState()).toBe('completed');
    expect(h.alerts.map((alert) => alert.title)).toContain(
      'Outbound send failed after its retries',
    );
  });

  it('delays a send without a token: no failure, no attempt, and the denied metric', async () => {
    const f = await fixture({ rateLimitPerMinute: 1 });
    const first = await send(f);
    await waitForStatus(first, 'sent');
    const before = await metricValue('botcenter_rate_limit_denied_total', { scope: 'instance' });
    const second = await send(f);
    await waitFor(async () => (await (await outboundJob(second))?.getState()) === 'delayed');
    const job = await outboundJob(second);
    expect(job?.attemptsMade).toBe(0);
    expect(job?.failedReason).toBeFalsy();
    expect((await message(second)).status).toBe('queued');
    expect(
      await metricValue('botcenter_rate_limit_denied_total', { scope: 'instance' }),
    ).toBeGreaterThan(before);
    // The wait is about one minute (one token for each minute).
    expect(job!.delay).toBeGreaterThan(50_000);
  });

  it('sweeps a queued row without a job and sends it', async () => {
    const f = await fixture();
    const row = await h.prisma.message.create({
      data: {
        tenantId: f.tenant.id,
        instanceId: f.instance.id,
        direction: 'outbound',
        type: 'text',
        status: 'queued',
        contact: '5511987654321',
        content: { type: 'text', text: 'Oi' },
        createdAt: new Date(Date.now() - 120_000),
      },
    });
    const result = await worker.get(OutboundSweep).run();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    await waitForStatus(row.id, 'sent');
  });

  it('expires a queued row older than one day, with the status event', async () => {
    const f = await fixture({ status: 'connecting' });
    const row = await h.prisma.message.create({
      data: {
        tenantId: f.tenant.id,
        instanceId: f.instance.id,
        direction: 'outbound',
        type: 'text',
        status: 'queued',
        contact: '5511987654321',
        content: { type: 'text', text: 'Oi' },
        createdAt: new Date(Date.now() - 25 * 3_600_000),
      },
    });
    const result = await worker.get(OutboundSweep).run();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await message(row.id)).toMatchObject({ status: 'failed', failureReason: 'expired' });
    expect(await statusEvents(row.id)).toEqual([
      expect.objectContaining({ status: 'failed', failure_reason: 'expired' }),
    ]);
  });

  it('ends the inbound job of a status event for an unknown message', async () => {
    const f = await fixture();
    const webhook = evolutionStatus({
      instanceName: f.instance.providerName,
      messageId: `3EB0${randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase()}`,
      status: 'DELIVERY_ACK',
    });
    await h.postProviderWebhook(webhook.body);
    const queue = h.get(QueuesService).get('inbound');
    await waitFor(async () => {
      const job = await queue.getJob(inboundJobId(webhook.dedupeKey));
      await skipDelay(job);
      return (await job?.getState()) === 'completed';
    }, 20_000);
  });
});

describe('instance token bucket (Lua script in Redis)', () => {
  it('gives the burst, then one token for each interval, with the wait time', async () => {
    const bucket = worker.get(InstanceTokenBucket);
    const id = randomUUID();
    const limits = { ratePerMinute: 60, burst: 2 };
    const t0 = 1_000_000;
    expect(await bucket.take(id, limits, { nowMs: t0 })).toEqual({ allowed: true, waitMs: 0 });
    expect(await bucket.take(id, limits, { nowMs: t0 })).toEqual({ allowed: true, waitMs: 0 });
    expect(await bucket.take(id, limits, { nowMs: t0 })).toEqual({ allowed: false, waitMs: 1_000 });
    expect(await bucket.take(id, limits, { nowMs: t0 + 400 })).toEqual({
      allowed: false,
      waitMs: 600,
    });
    expect(await bucket.take(id, limits, { nowMs: t0 + 1_000 })).toEqual({
      allowed: true,
      waitMs: 0,
    });
    // After a long idle time, the bucket holds the burst, not more.
    await bucket.take(id, limits, { nowMs: t0 + 600_000 });
    await bucket.take(id, limits, { nowMs: t0 + 600_000 });
    expect((await bucket.take(id, limits, { nowMs: t0 + 600_000 })).allowed).toBe(false);
  });

  it('gives each denied bulk job its own place in the line, one interval apart (ARCH-10)', async () => {
    const bucket = worker.get(InstanceTokenBucket);
    const id = randomUUID();
    const limits = { ratePerMinute: 4, burst: 1 };
    const t0 = 2_000_000;
    expect((await bucket.take(id, limits, { spread: true, nowMs: t0 })).allowed).toBe(true);
    const waits = [];
    for (let index = 0; index < 4; index += 1) {
      waits.push((await bucket.take(id, limits, { spread: true, nowMs: t0 })).waitMs);
    }
    // One token every 15 s: the jobs wake one at a time, not all at the next token.
    expect(waits).toEqual([15_000, 30_000, 45_000, 60_000]);
    // A reply is not in the line: it waits only for the next token.
    expect(await bucket.take(id, limits, { nowMs: t0 })).toEqual({
      allowed: false,
      waitMs: 15_000,
    });
    // The first job of the line gets the token at its time.
    expect((await bucket.take(id, limits, { spread: true, nowMs: t0 + 15_000 })).allowed).toBe(
      true,
    );
    // A token that a job gives back is free for the next take.
    await bucket.refund(id, limits);
    expect((await bucket.take(id, limits, { nowMs: t0 + 15_000 })).allowed).toBe(true);
  });

  it('is atomic: parallel takes never give more than the burst', async () => {
    const bucket = worker.get(InstanceTokenBucket);
    const id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => bucket.take(id, { ratePerMinute: 1, burst: 5 })),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    const ttl = await h.redis.pttl(`bc:bucket:instance:${id}`);
    expect(ttl).toBeGreaterThan(0);
  });
});

describe('instances.firstConnectedAt (trigger)', () => {
  it('is set by the first connected status and does not move after', async () => {
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    expect(instance.firstConnectedAt).toBeNull();
    const connected = await h.prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'connected' },
    });
    expect(connected.firstConnectedAt).toBeInstanceOf(Date);
    await h.prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'disconnected' },
    });
    const again = await h.prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'connected' },
    });
    expect(again.firstConnectedAt).toEqual(connected.firstConnectedAt);
  });
});
