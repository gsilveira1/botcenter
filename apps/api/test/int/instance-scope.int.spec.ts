import type { BotDefinitionInput } from '@botcenter/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsApiModule } from '../../src/conversations/conversations.module';
import { DNS_RESOLVER } from '../../src/external-http/ssrf-guard';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { WebhooksApiModule } from '../../src/webhooks/webhooks.module';
import { TestHarness } from '../support/harness';
import { PUBLIC_ADDRESS, fakeDns, insertDelivery } from '../support/webhooks';

/**
 * SEC-03: an API key with an instance list must not read or control the other instances of its tenant.
 * Each test uses two keys of ONE tenant: a key for all the instances, and a key for the instance A only.
 */

const URL_OK = 'https://hooks.example.com/botcenter';

let h: TestHarness;
let tenant: Tenant;
let instanceA: Instance;
let instanceB: Instance;
let fullKey: string;
let scopedKey: string;

const bot = (text: string): BotDefinitionInput => ({
  initial_state: 'inicio',
  states: {
    inicio: {
      on_enter: [{ type: 'send_message', message: { type: 'text', text } }],
      transitions: [{ condition: { type: 'any' }, target: 'fim' }],
    },
    fim: { final: true, transitions: [] },
  },
});

beforeAll(async () => {
  h = await TestHarness.start({
    modules: [WebhooksApiModule, ConversationsApiModule],
    override: (builder) =>
      builder
        .overrideProvider(DNS_RESOLVER)
        .useValue(fakeDns({ 'hooks.example.com': [PUBLIC_ADDRESS] })),
  });
  tenant = await h.createTenant();
  instanceA = await h.createInstance(tenant.id);
  instanceB = await h.createInstance(tenant.id);
  fullKey = (await h.createApiKey({ tenantId: tenant.id, scopes: ['events:read', 'bots:write'] }))
    .key;
  scopedKey = (
    await h.createApiKey({
      tenantId: tenant.id,
      scopes: ['events:read', 'bots:write'],
      instanceIds: [instanceA.id],
    })
  ).key;
});

afterAll(async () => {
  await h?.close();
});

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, key: string, body?: unknown) {
  return h.inject({
    method,
    url,
    headers: {
      ...h.bearer(key),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function putBot(key: string, slug: string, instanceIds: string[], text = 'Oi') {
  return call('PUT', `/v1/bots/${slug}`, key, {
    name: 'Bot',
    definition: bot(text),
    instance_ids: instanceIds,
  });
}

describe('SEC-03: /v1/webhooks and a key with an instance list', () => {
  it('refuses every webhooks route with 403 INSTANCE_NOT_ALLOWED and changes nothing', async () => {
    const created = await call('POST', '/v1/webhooks', fullKey, {
      url: URL_OK,
      events: ['message.received'],
    });
    expect(created.statusCode).toBe(201);
    const webhookId = created.json().id as string;
    const delivery = await insertDelivery(h.prisma, {
      tenantId: tenant.id,
      subscriptionId: webhookId,
      status: 'dead',
      nextAttemptAt: null,
    });

    const routes: Array<[method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown]> = [
      ['POST', '/v1/webhooks', { url: URL_OK, events: ['message.received'] }],
      ['GET', '/v1/webhooks'],
      ['GET', '/v1/webhooks/deliveries'],
      ['POST', `/v1/webhooks/deliveries/${delivery.id}/redeliver`],
      ['DELETE', `/v1/webhooks/${webhookId}`],
      ['POST', `/v1/webhooks/${webhookId}/rotate-secret`],
    ];
    for (const [method, url, body] of routes) {
      const response = await call(method, url, scopedKey, body);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json().code, `${method} ${url}`).toBe('INSTANCE_NOT_ALLOWED');
    }

    const subscriptions = await h.prisma.webhookSubscription.findMany({
      where: { tenantId: tenant.id },
    });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({ id: webhookId, deletedAt: null, active: true });
    expect(
      await h.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ status: 'dead' });
  });

  it('keeps every webhooks route open for the key without an instance list', async () => {
    const list = await call('GET', '/v1/webhooks', fullKey);
    expect(list.statusCode).toBe(200);
    const deliveries = await call('GET', '/v1/webhooks/deliveries', fullKey);
    expect(deliveries.statusCode).toBe(200);
  });
});

describe('SEC-03: /v1/bots and a key with an instance list', () => {
  it('refuses PUT for a bot that serves an instance outside the key list, and changes nothing', async () => {
    const created = await putBot(fullKey, 'main', [instanceA.id, instanceB.id], 'v1');
    expect(created.statusCode).toBe(200);

    const refused = await putBot(scopedKey, 'main', [instanceA.id], 'v2 by the scoped key');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('INSTANCE_NOT_ALLOWED');

    const row = await h.prisma.bot.findFirstOrThrow({
      where: { tenantId: tenant.id, slug: 'main' },
      include: { versions: true, instances: true },
    });
    expect(row.currentVersion).toBe(1);
    expect(row.versions).toHaveLength(1);
    expect(row.instances.map((instance) => instance.id).sort()).toEqual(
      [instanceA.id, instanceB.id].sort(),
    );
  });

  it('refuses GET for a bot that serves an instance outside the key list', async () => {
    const response = await call('GET', '/v1/bots/main', scopedKey);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('INSTANCE_NOT_ALLOWED');
    const full = await call('GET', '/v1/bots/main', fullKey);
    expect(full.statusCode).toBe(200);
  });

  it('accepts PUT and GET for a bot that serves only the instances of the key list', async () => {
    const tenantTwo = await h.createTenant();
    const a = await h.createInstance(tenantTwo.id);
    const b = await h.createInstance(tenantTwo.id);
    const scoped = (
      await h.createApiKey({ tenantId: tenantTwo.id, scopes: ['bots:write'], instanceIds: [a.id] })
    ).key;
    const full = (await h.createApiKey({ tenantId: tenantTwo.id, scopes: ['bots:write'] })).key;
    expect((await putBot(scoped, 'own', [a.id], 'v1')).statusCode).toBe(200);
    expect((await putBot(scoped, 'own', [a.id], 'v2')).statusCode).toBe(200);
    expect((await call('GET', '/v1/bots/own', scoped)).statusCode).toBe(200);
    expect((await putBot(scoped, 'empty', [], 'draft')).statusCode).toBe(200);

    // The full key binds B to the bot. From then on, the scoped key cannot change or read it.
    expect((await putBot(full, 'own', [a.id, b.id], 'v2')).statusCode).toBe(200);
    expect((await putBot(scoped, 'own', [a.id], 'v3')).statusCode).toBe(403);
    expect((await call('GET', '/v1/bots/own', scoped)).statusCode).toBe(403);
  });
});
