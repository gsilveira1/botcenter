import { Injectable, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core/core.module';
import { WorkerCoreModule } from '../../src/core/worker-core.module';
import { InboundWorkerModule } from '../../src/inbound/inbound.module';
import { InboundHandlerRegistry } from '../../src/inbound/inbound-handler.registry';
import type {
  InboundHandler,
  InboundJobContext,
  ProviderEventOf,
} from '../../src/inbound/inbound-handler.registry';
import { inboundJobId } from '../../src/inbound/inbound-ingest.service';
import { QueuesService } from '../../src/queues/queues.service';
import { evolutionInboundText, evolutionStatus } from '../support/fake-provider';
import { TestHarness } from '../support/harness';
import { waitFor } from '../support/wait-for';

const handled: { event: ProviderEventOf<'message.received'>; context: InboundJobContext }[] = [];

@Injectable()
class RecordingMessageHandler implements InboundHandler<'message.received'>, OnModuleInit {
  constructor(private readonly registry: InboundHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register('message.received', this);
  }

  async handle(
    event: ProviderEventOf<'message.received'>,
    context: InboundJobContext,
  ): Promise<void> {
    handled.push({ event, context });
  }
}

/** A wave 2 style worker module: it registers one inbound handler. */
@Module({ providers: [RecordingMessageHandler] })
class RecordingWorkerModule {}

/** The worker core without the handlers of the feature slices, so `message.status` has no handler. */
@Module({ imports: [CoreModule, WorkerCoreModule, InboundWorkerModule] })
class CoreWorkerRoot {}

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start();
});

afterAll(async () => {
  await h?.close();
});

function post(body: unknown, headers = h.internalHeaders()) {
  return h.postProviderWebhook(body, headers);
}

describe('POST /internal/evolution/webhook', () => {
  it('refuses a missing or wrong secret (401) and a public address (404)', async () => {
    const body = { events: [] };
    expect((await post(body, { 'content-type': 'application/json' })).statusCode).toBe(401);
    expect(
      (await post(body, h.internalHeaders('wrong-secret-0123456789abcdef0123'))).statusCode,
    ).toBe(401);
    const publicCall = await post(body, {
      ...h.internalHeaders(),
      'x-forwarded-for': '203.0.113.1',
    });
    expect(publicCall.statusCode).toBe(404);
  });

  it('stores the raw body, dedupes each event for 24 h, and enqueues it with the dedupe job id', async () => {
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    const webhook = evolutionInboundText({ instanceName: instance.providerName, text: 'Oi' });
    expect(webhook.dedupeKey).toBe(
      `message.received:${instance.providerName}:${webhook.messageId}`,
    );

    const first = await post(webhook.body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      received: 1,
      enqueued: 1,
      duplicates: 0,
      ignored: 0,
    });

    const second = await post(webhook.body);
    expect(second.json()).toMatchObject({ enqueued: 0, duplicates: 1 });

    const job = await h.get(QueuesService).get('inbound').getJob(inboundJobId(webhook.dedupeKey));
    expect(job?.name).toBe('message.received');
    expect(job?.data.event).toMatchObject({
      kind: 'message.received',
      instanceName: instance.providerName,
      providerMessageId: webhook.messageId,
      content: { type: 'text', text: 'Oi' },
    });
    expect(typeof job?.data.event.occurredAt).toBe('string');
    expect(await h.redis.ttl(`bc:dedupe:inbound:${webhook.dedupeKey}`)).toBeGreaterThan(86_000);

    const raw = await h.prisma.rawEvent.findMany({ where: { instanceId: instance.id } });
    expect(raw).toHaveLength(2);
    expect(raw[0]?.eventType).toBe('message.received');
    expect(job?.data.rawEventId).toBe(raw.find((row) => row.id === job?.data.rawEventId)?.id);
  });

  it('answers 200 and stores an event that the normalizer ignores (a message from the instance)', async () => {
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    const webhook = evolutionInboundText({ instanceName: instance.providerName });
    const data = webhook.body['data'] as { key: { fromMe: boolean } };
    data.key.fromMe = true;

    const response = await post(webhook.body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: 0, enqueued: 0, duplicates: 0, ignored: 1 });
    expect(await h.prisma.rawEvent.count({ where: { eventType: 'ignored' } })).toBe(1);
  });

  it('answers 400 for a body that the normalizer rejects (Evolution does not retry it) and keeps it', async () => {
    const response = await post({ unknown: true });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await h.prisma.rawEvent.count({ where: { eventType: 'rejected' } })).toBe(1);
  });

  it('stores a body with a NUL character (jsonb refuses \\u0000) instead of a 500 on each retry', async () => {
    const webhook = evolutionInboundText({ instanceName: 'inst_unknown', text: 'a\u0000b' });
    const response = await post(webhook.body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enqueued: 1 });
  });
});

describe('inbound worker', () => {
  it('dispatches each event to the handler of its kind and finishes jobs without a handler', async () => {
    await h.startWorker([RecordingWorkerModule], CoreWorkerRoot);
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    const message = evolutionInboundText({ instanceName: instance.providerName });
    const status = evolutionStatus({
      instanceName: instance.providerName,
      messageId: 'SENT-BY-THE-INSTANCE',
      status: 'DELIVERY_ACK',
    });
    expect((await post(message.body)).json()).toMatchObject({ enqueued: 1 });
    expect((await post(status.body)).json()).toMatchObject({ enqueued: 1 });

    await waitFor(() => handled.some((item) => item.event.dedupeKey === message.dedupeKey));
    const item = handled.find((entry) => entry.event.dedupeKey === message.dedupeKey)!;
    expect(item.event.occurredAt).toBeInstanceOf(Date);
    expect(item.context.rawEventId).toBeTruthy();

    const queue = h.get(QueuesService).get('inbound');
    await waitFor(
      async () => (await queue.getJob(inboundJobId(status.dedupeKey)))?.finishedOn !== undefined,
    );
    const statusJob = await queue.getJob(inboundJobId(status.dedupeKey));
    expect(statusJob?.returnvalue).toEqual({ handled: false });
  });
});
