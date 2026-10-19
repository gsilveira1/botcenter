import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboundHandlerRegistry } from '../../src/inbound/inbound-handler.registry';
import type {
  InboundHandler,
  InboundJobContext,
  ProviderEventOf,
} from '../../src/inbound/inbound-handler.registry';
import { inboundJobId } from '../../src/inbound/inbound-ingest.service';
import { QueuesService } from '../../src/queues/queues.service';
import { fakeMessageReceived } from '../support/fake-provider';
import { TestHarness } from '../support/harness';

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

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start();
});

afterAll(async () => {
  await h?.close();
});

function post(body: unknown, headers = h.internalHeaders()) {
  return h.inject({
    method: 'POST',
    url: '/internal/evolution/webhook',
    headers,
    payload: JSON.stringify(body),
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(50);
  }
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
    const event = fakeMessageReceived({
      instanceName: instance.providerName,
      dedupeKey: 'evo:msg:ABC',
    });

    const first = await post({ events: [event], ignored: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      received: 1,
      enqueued: 1,
      duplicates: 0,
      ignored: 1,
    });

    const second = await post({ events: [event] });
    expect(second.json()).toMatchObject({ enqueued: 0, duplicates: 1 });

    const job = await h.get(QueuesService).get('inbound').getJob(inboundJobId('evo:msg:ABC'));
    expect(job?.name).toBe('message.received');
    expect(job?.data.event).toMatchObject({
      kind: 'message.received',
      instanceName: instance.providerName,
    });
    expect(typeof job?.data.event.occurredAt).toBe('string');
    expect(await h.redis.ttl('bc:dedupe:inbound:evo:msg:ABC')).toBeGreaterThan(86_000);

    const raw = await h.prisma.rawEvent.findMany({ where: { instanceId: instance.id } });
    expect(raw).toHaveLength(2);
    expect(raw[0]?.eventType).toBe('message.received');
    expect(job?.data.rawEventId).toBe(raw.find((row) => row.id === job?.data.rawEventId)?.id);
  });

  it('answers 400 for a body that the normalizer rejects (Evolution does not retry it) and keeps it', async () => {
    const response = await post({ unknown: true });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await h.prisma.rawEvent.count({ where: { eventType: 'rejected' } })).toBe(1);
  });

  it('stores a body with a NUL character (jsonb refuses \\u0000) instead of a 500 on each retry', async () => {
    const event = fakeMessageReceived({
      instanceName: 'inst_unknown',
      dedupeKey: 'evo:msg:NUL',
      content: { type: 'text', text: 'a\u0000b' },
    });
    const response = await post({ events: [event] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enqueued: 1 });
  });
});

describe('inbound worker', () => {
  it('dispatches each event to the handler of its kind and finishes jobs without a handler', async () => {
    await h.startWorker([RecordingWorkerModule]);
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    const message = fakeMessageReceived({
      instanceName: instance.providerName,
      dedupeKey: 'evo:msg:WORKER',
    });
    const status = {
      kind: 'message.status',
      instanceName: instance.providerName,
      dedupeKey: 'evo:status:WORKER',
      occurredAt: new Date().toISOString(),
      providerMessageId: 'x',
      status: 'delivered',
    };
    expect((await post({ events: [message, status] })).json()).toMatchObject({ enqueued: 2 });

    await waitFor(() => handled.some((item) => item.event.dedupeKey === 'evo:msg:WORKER'));
    const item = handled.find((entry) => entry.event.dedupeKey === 'evo:msg:WORKER')!;
    expect(item.event.occurredAt).toBeInstanceOf(Date);
    expect(item.context.rawEventId).toBeTruthy();

    const queue = h.get(QueuesService).get('inbound');
    await waitFor(
      async () => (await queue.getJob(inboundJobId('evo:status:WORKER')))?.finishedOn !== undefined,
    );
    const statusJob = await queue.getJob(inboundJobId('evo:status:WORKER'));
    expect(statusJob?.returnvalue).toEqual({ handled: false });
  });
});
