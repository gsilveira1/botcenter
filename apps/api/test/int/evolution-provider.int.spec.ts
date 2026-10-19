import { EvolutionProvider } from '@botcenter/whatsapp-provider';
import { newMessageId } from '@botcenter/whatsapp-provider/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inboundJobId } from '../../src/inbound/inbound-ingest.service';
import { QueuesService } from '../../src/queues/queues.service';
import { TestHarness } from '../support/harness';

/**
 * The full provider path over HTTP: the real `providerFactory` binds the real `EvolutionProvider` to a
 * `FakeEvolutionServer`, and the fake server posts real Evolution v2.3.7 webhooks to the app.
 */
let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({ fakeEvolution: true });
});

afterAll(async () => {
  await h?.close();
});

const CONTACT = '5511987654321';

async function inboundJobsOf(instanceName: string) {
  const jobs = await h
    .get(QueuesService)
    .get('inbound')
    .getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs.filter((job) => job.data.event.instanceName === instanceName);
}

describe('Evolution provider over HTTP', () => {
  it('binds the real EvolutionProvider, and /health/ready reports the provider check as up', async () => {
    expect(h.whatsapp).toBeInstanceOf(EvolutionProvider);

    const response = await h.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json().checks.provider).toMatchObject({ status: 'up' });
    const [ping] = h.evolution.callsTo('/instance/fetchInstances', 'GET');
    expect(ping?.headers['apikey']).toBe(h.env.EVOLUTION_API_KEY);
  });

  it('stores and enqueues an inbound text webhook one time, and dedupes the second delivery', async () => {
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    const name = instance.providerName;

    await h.whatsapp.createInstance({
      name,
      webhookUrl: h.webhookUrl,
      webhookSecret: h.env.EVOLUTION_WEBHOOK_SECRET,
    });
    expect(h.evolution.instance(name)?.webhook).toMatchObject({
      url: h.webhookUrl,
      headers: { 'x-botcenter-webhook-secret': h.env.EVOLUTION_WEBHOOK_SECRET },
    });

    const id = newMessageId();
    const first = await h.evolution.emitInboundText(name, { from: CONTACT, text: 'Oi', id });
    expect(first.error).toBeUndefined();
    expect(first.status).toBe(200);

    const dedupeKey = `message.received:${name}:${id}`;
    const job = await h.get(QueuesService).get('inbound').getJob(inboundJobId(dedupeKey));
    expect(job?.name).toBe('message.received');
    expect(job?.data.event).toMatchObject({
      kind: 'message.received',
      instanceName: name,
      providerMessageId: id,
      from: CONTACT,
      content: { type: 'text', text: 'Oi' },
    });

    // Evolution sends the same message again (for example after a retry): the body is new, the event is not.
    const second = await h.evolution.emitInboundText(name, { from: CONTACT, text: 'Oi', id });
    expect(second.status).toBe(200);

    const raw = await h.prisma.rawEvent.findMany({
      where: { instanceId: instance.id },
      orderBy: { receivedAt: 'asc' },
    });
    expect(raw).toHaveLength(2);
    expect(raw.map((row) => row.eventType)).toEqual(['message.received', 'message.received']);
    expect(raw[0]?.payload).toMatchObject({ event: 'messages.upsert', instance: name });
    expect(job?.data.rawEventId).toBe(raw[0]?.id);

    const jobs = await inboundJobsOf(name);
    expect(jobs.map((item) => item.id)).toEqual([inboundJobId(dedupeKey)]);
  });

  it('answers 401 to a webhook with a wrong secret, so Evolution does not retry it', async () => {
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    const name = instance.providerName;
    await h.whatsapp.createInstance({
      name,
      webhookUrl: h.webhookUrl,
      webhookSecret: 'a-wrong-secret-0123456789abcdef0123',
    });

    const delivery = await h.evolution.emitInboundText(name, { from: CONTACT, text: 'Oi' });

    expect(delivery.status).toBe(401);
    expect(await h.prisma.rawEvent.count({ where: { instanceId: instance.id } })).toBe(0);
    expect(await inboundJobsOf(name)).toHaveLength(0);
  });
});
