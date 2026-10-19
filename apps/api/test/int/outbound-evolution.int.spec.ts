import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { MessagesApiModule, MessagesWorkerModule } from '../../src/messages/messages.module';
import { TestHarness } from '../support/harness';
import { waitFor } from '../support/wait-for';

/**
 * The full outbound path over HTTP: the API and the worker use the real `EvolutionProvider` against the
 * `FakeEvolutionServer`. The fake sends `messages.update` webhooks after each send (`autoStatus`) to the
 * internal webhook of the app, often before the worker writes the provider id.
 */
let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({
    modules: [MessagesApiModule],
    fakeEvolution: { autoStatus: 'delivered' },
  });
  await h.startWorker([MessagesWorkerModule]);
});

afterAll(async () => {
  await h?.close();
});

interface Fixture {
  tenant: Tenant;
  instance: Instance;
  key: string;
}

async function fixture(): Promise<Fixture> {
  const tenant = await h.createTenant();
  const name = `inst_${randomUUID()}`;
  await h.whatsapp.createInstance({
    name,
    webhookUrl: h.webhookUrl,
    webhookSecret: h.env.EVOLUTION_WEBHOOK_SECRET,
  });
  await h.evolution.emitConnected(name, '5511912345678');
  const instance = await h.createInstance(tenant.id, {
    providerName: name,
    status: 'connected',
    firstConnectedAt: new Date('2026-01-01T00:00:00Z'),
    rateLimitPerMinute: 600,
  });
  const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['messages:send'] });
  return { tenant, instance, key };
}

async function send(f: Fixture, body: Record<string, unknown> = { type: 'text', text: 'Oi' }) {
  const response = await fetch(`${h.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { ...h.bearer(f.key), 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: f.instance.id, to: '5511987654321', ...body }),
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { id: string }).id;
}

async function status(f: Fixture, id: string): Promise<string> {
  const response = await fetch(`${h.baseUrl}/v1/messages/${id}`, { headers: h.bearer(f.key) });
  return ((await response.json()) as { status: string }).status;
}

describe('outbound path over HTTP (fake Evolution)', () => {
  it('enqueue, send, sent, delivered (fake status webhook), then read', async () => {
    const f = await fixture();
    const id = await send(f);
    await waitFor(async () => (await status(f, id)) === 'delivered', 20_000);

    const row = await h.prisma.message.findUniqueOrThrow({ where: { id } });
    expect(row.providerMessageId).toBeTruthy();
    const calls = h.evolution.callsTo('/message/sendText');
    expect(calls.at(-1)?.body).toMatchObject({ number: '5511987654321', text: 'Oi' });

    await h.evolution.emitStatus(f.instance.providerName, {
      messageId: row.providerMessageId!,
      status: 'read',
    });
    await waitFor(async () => (await status(f, id)) === 'read', 10_000);
    const events = await h.prisma.outboxEvent.findMany({
      where: { tenantId: f.tenant.id, type: 'message.status' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => (event.payload as { status: string }).status)).toEqual([
      'sent',
      'delivered',
      'read',
    ]);
  });

  it('retries a provider 503 and then sends', async () => {
    const f = await fixture();
    h.evolution.failNext({ route: '/message/sendText', status: 503 });
    const id = await send(f);
    // The first retry waits 5 s (policy for an answer of the provider).
    await waitFor(async () => (await status(f, id)) !== 'queued', 20_000);
    expect(await status(f, id)).not.toBe('failed');
    const sends = h.evolution
      .callsTo('/message/sendText')
      .filter((call) => call.instanceName === f.instance.providerName);
    expect(sends).toHaveLength(2);
  });

  it('fails at once for a number without WhatsApp', async () => {
    const f = await fixture();
    h.evolution.addInvalidRecipient('5511900000002');
    const id = await send(f, { type: 'text', text: 'Oi', to: '5511900000002' });
    await waitFor(async () => (await status(f, id)) === 'failed', 10_000);
    const row = await h.prisma.message.findUniqueOrThrow({ where: { id } });
    expect(row.failureReason).toBe('invalid_recipient');
  });
});
