import { WebhookSecret } from '@botcenter/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DNS_RESOLVER } from '../../src/external-http/ssrf-guard';
import type { Tenant } from '../../src/generated/prisma/client';
import { QueuesService } from '../../src/queues/queues.service';
import { SecretBox } from '../../src/services/secret-box';
import { deliveryJobId } from '../../src/webhooks/webhook-delivery.jobs';
import { MAX_WEBHOOKS_PER_TENANT } from '../../src/webhooks/webhook-subscriptions.service';
import { WebhooksApiModule } from '../../src/webhooks/webhooks.module';
import { TestHarness } from '../support/harness';
import { PUBLIC_ADDRESS, fakeDns, insertDelivery } from '../support/webhooks';

const URL_OK = 'https://hooks.example.com/botcenter';

let h: TestHarness;
let tenantA: Tenant;
let tenantB: Tenant;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  h = await TestHarness.start({
    modules: [WebhooksApiModule],
    override: (builder) =>
      builder.overrideProvider(DNS_RESOLVER).useValue(
        fakeDns({
          'hooks.example.com': [PUBLIC_ADDRESS],
          'other.example.com': [PUBLIC_ADDRESS],
          'internal.example.com': [{ address: '10.1.2.3', family: 4 }],
          'mixed.example.com': [PUBLIC_ADDRESS, { address: '192.168.0.10', family: 4 }],
          'meta.example.com': [{ address: '169.254.169.254', family: 4 }],
          'v6.example.com': [{ address: '::1', family: 6 }],
          'mapped.example.com': [{ address: '::ffff:127.0.0.1', family: 6 }],
        }),
      ),
  });
  tenantA = await h.createTenant();
  tenantB = await h.createTenant();
  keyA = (await h.createApiKey({ tenantId: tenantA.id, scopes: ['events:read'] })).key;
  keyB = (await h.createApiKey({ tenantId: tenantB.id, scopes: ['events:read'] })).key;
});

afterAll(async () => {
  await h?.close();
});

function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  key: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return h.inject({
    method,
    url,
    headers: { ...h.bearer(key), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function createWebhook(key: string, url = URL_OK, events = ['message.status']) {
  const response = await call('POST', '/v1/webhooks', key, { url, events });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; secret: string; url: string };
}

describe('POST /v1/webhooks', () => {
  it('registers the webhook, shows the secret once, and stores it encrypted for the row', async () => {
    const response = await call(
      'POST',
      '/v1/webhooks',
      keyA,
      { url: URL_OK, events: ['message.status', 'instance.status'] },
      { 'idempotency-key': 'create-1' },
    );
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ url: URL_OK, events: ['message.status', 'instance.status'] });
    expect(WebhookSecret.safeParse(body.secret).success).toBe(true);

    const row = await h.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.tenantId).toBe(tenantA.id);
    expect(row.secretEncrypted).not.toContain(body.secret);
    expect(h.get(SecretBox).decrypt(row.secretEncrypted, row.id)).toBe(body.secret);

    // The idempotency store keeps response bodies in plain text: the route must not use it.
    expect(await h.prisma.idempotencyKey.count({ where: { tenantId: tenantA.id } })).toBe(0);
    const list = await call('GET', '/v1/webhooks', keyA);
    expect(JSON.stringify(list.json())).not.toContain(body.secret);
    const audit = await h.prisma.auditLog.findFirst({ where: { targetId: body.id } });
    expect(audit).toMatchObject({ action: 'webhook.create', tenantId: tenantA.id });
  });

  it.each([
    'https://internal.example.com/hook',
    'https://mixed.example.com/hook',
    'https://meta.example.com/latest',
    'https://v6.example.com/hook',
    'https://mapped.example.com/hook',
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://unknown.example.com/hook',
  ])('refuses %s with 422 WEBHOOK_URL_FORBIDDEN', async (url) => {
    const response = await call('POST', '/v1/webhooks', keyA, { url, events: ['message.status'] });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'WEBHOOK_URL_FORBIDDEN' });
  });

  it('refuses an HTTP URL and a repeated event type with 400', async () => {
    const http = await call('POST', '/v1/webhooks', keyA, {
      url: 'http://hooks.example.com/',
      events: ['message.status'],
    });
    expect(http.statusCode).toBe(400);
    const repeated = await call('POST', '/v1/webhooks', keyA, {
      url: URL_OK,
      events: ['message.status', 'message.status'],
    });
    expect(repeated.statusCode).toBe(400);
  });

  it('refuses a key without the events:read scope', async () => {
    const { key } = await h.createApiKey({ tenantId: tenantA.id, scopes: ['messages:send'] });
    const response = await call('POST', '/v1/webhooks', key, {
      url: URL_OK,
      events: ['message.status'],
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'SCOPE_MISSING' });
  });

  it(`refuses more than ${MAX_WEBHOOKS_PER_TENANT} active webhooks for one tenant`, async () => {
    const tenant = await h.createTenant();
    const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['events:read'] });
    const results = await Promise.all(
      Array.from({ length: MAX_WEBHOOKS_PER_TENANT + 2 }, () =>
        call('POST', '/v1/webhooks', key, { url: URL_OK, events: ['message.status'] }),
      ),
    );
    const statuses = results.map((result) => result.statusCode);
    expect(statuses.filter((status) => status === 201)).toHaveLength(MAX_WEBHOOKS_PER_TENANT);
    expect(statuses.filter((status) => status === 409)).toHaveLength(2);
  });
});

describe('GET /v1/webhooks', () => {
  it('lists the active webhooks of the tenant only, newest first, with a cursor', async () => {
    const tenant = await h.createTenant();
    const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['events:read'] });
    const first = await createWebhook(key);
    const second = await createWebhook(key, 'https://other.example.com/a');
    const third = await createWebhook(key);
    expect((await call('DELETE', `/v1/webhooks/${second.id}`, key)).statusCode).toBe(204);

    const page1 = await call('GET', '/v1/webhooks?limit=1', key);
    expect(page1.json().data.map((item: { id: string }) => item.id)).toEqual([third.id]);
    const cursor = page1.json().next_cursor as string;
    const page2 = await call('GET', `/v1/webhooks?limit=1&cursor=${cursor}`, key);
    expect(page2.json()).toEqual({
      data: [expect.objectContaining({ id: first.id })],
      next_cursor: null,
    });
    expect(page2.json().data[0]).not.toHaveProperty('secret');
  });

  it('never shows a webhook of another tenant', async () => {
    const created = await createWebhook(keyA);
    const listB = await call('GET', '/v1/webhooks?limit=100', keyB);
    expect(listB.json().data.map((item: { id: string }) => item.id)).not.toContain(created.id);
  });
});

describe('DELETE /v1/webhooks/{id}', () => {
  it('soft deletes the webhook and stops its pending and failed deliveries', async () => {
    const created = await createWebhook(keyA);
    const pending = await insertDelivery(h.prisma, {
      tenantId: tenantA.id,
      subscriptionId: created.id,
    });
    const failed = await insertDelivery(h.prisma, {
      tenantId: tenantA.id,
      subscriptionId: created.id,
      status: 'failed',
      attempts: 2,
    });
    const done = await insertDelivery(h.prisma, {
      tenantId: tenantA.id,
      subscriptionId: created.id,
      status: 'succeeded',
      nextAttemptAt: null,
    });

    expect((await call('DELETE', `/v1/webhooks/${created.id}`, keyA)).statusCode).toBe(204);
    const row = await h.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ active: false, deletedAt: expect.any(Date) });
    const rows = await h.prisma.webhookDelivery.findMany({
      where: { id: { in: [pending.id, failed.id, done.id] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((delivery) => [delivery.status, delivery.lastError])).toEqual([
      ['dead', 'webhook_deleted'],
      ['dead', 'webhook_deleted'],
      ['succeeded', null],
    ]);
    expect((await call('DELETE', `/v1/webhooks/${created.id}`, keyA)).statusCode).toBe(404);
  });

  it('gives 404 to another tenant and changes nothing', async () => {
    const created = await createWebhook(keyA);
    const response = await call('DELETE', `/v1/webhooks/${created.id}`, keyB);
    expect(response.statusCode).toBe(404);
    const row = await h.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).toBeNull();
  });
});

describe('POST /v1/webhooks/{id}/rotate-secret', () => {
  it('returns a new secret and keeps the old one valid for 24 h', async () => {
    const created = await createWebhook(keyA);
    const response = await call('POST', `/v1/webhooks/${created.id}/rotate-secret`, keyA);
    expect(response.statusCode).toBe(200);
    const rotated = response.json();
    expect(rotated.id).toBe(created.id);
    expect(rotated.secret).not.toBe(created.secret);
    const row = await h.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: created.id } });
    const box = h.get(SecretBox);
    expect(box.decrypt(row.secretEncrypted, row.id)).toBe(rotated.secret);
    expect(box.decrypt(row.previousSecretEncrypted ?? '', row.id)).toBe(created.secret);
    const graceMs = (row.previousSecretExpiresAt?.getTime() ?? 0) - Date.now();
    expect(graceMs).toBeGreaterThan(23 * 3_600_000);
    expect(graceMs).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('gives 404 to another tenant', async () => {
    const created = await createWebhook(keyA);
    expect((await call('POST', `/v1/webhooks/${created.id}/rotate-secret`, keyB)).statusCode).toBe(
      404,
    );
  });
});

describe('GET /v1/webhooks/deliveries', () => {
  it('lists the deliveries of the tenant with a status filter and a cursor', async () => {
    const tenant = await h.createTenant();
    const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['events:read'] });
    const created = await createWebhook(key);
    const base = { tenantId: tenant.id, subscriptionId: created.id };
    const dead = await insertDelivery(h.prisma, { ...base, status: 'dead', attempts: 6 });
    await insertDelivery(h.prisma, { ...base, status: 'succeeded', attempts: 1 });
    const dead2 = await insertDelivery(h.prisma, { ...base, status: 'dead', attempts: 6 });

    const all = await call('GET', '/v1/webhooks/deliveries', key);
    expect(all.json().data).toHaveLength(3);
    const page1 = await call('GET', '/v1/webhooks/deliveries?status=dead&limit=1', key);
    expect(page1.json().data).toEqual([
      expect.objectContaining({
        id: dead2.id,
        webhook_id: created.id,
        event_id: dead2.eventId,
        event_type: 'message.status',
        status: 'dead',
        attempts: 6,
      }),
    ]);
    const page2 = await call(
      'GET',
      `/v1/webhooks/deliveries?status=dead&limit=1&cursor=${page1.json().next_cursor as string}`,
      key,
    );
    expect(page2.json().data.map((item: { id: string }) => item.id)).toEqual([dead.id]);

    const listB = await call('GET', '/v1/webhooks/deliveries?limit=100', keyB);
    expect(listB.json().data.map((item: { id: string }) => item.id)).not.toContain(dead.id);
  });

  it('refuses an unknown status filter', async () => {
    expect((await call('GET', '/v1/webhooks/deliveries?status=lost', keyA)).statusCode).toBe(400);
  });
});

describe('POST /v1/webhooks/deliveries/{id}/redeliver', () => {
  it('starts a new attempt cycle for a dead delivery, adds the job, and writes an audit row', async () => {
    const created = await createWebhook(keyA);
    const dead = await insertDelivery(h.prisma, {
      tenantId: tenantA.id,
      subscriptionId: created.id,
      status: 'dead',
      attempts: 6,
      nextAttemptAt: null,
      lastError: 'http_500',
    });
    const response = await call('POST', `/v1/webhooks/deliveries/${dead.id}/redeliver`, keyA);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id: dead.id, status: 'pending', attempts: 0 });

    const row = await h.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: dead.id } });
    expect(row).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    const job = await h.get(QueuesService).get('webhooks').getJob(deliveryJobId(row));
    expect(job?.data).toEqual({ tenantId: tenantA.id, deliveryId: dead.id });
    const audit = await h.prisma.auditLog.findFirst({
      where: { targetId: dead.id, action: 'webhook_delivery.redeliver' },
    });
    expect(audit?.tenantId).toBe(tenantA.id);
  });

  it('refuses a delivery in another state (409), of a deleted webhook (409), or of another tenant (404)', async () => {
    const created = await createWebhook(keyA);
    const base = { tenantId: tenantA.id, subscriptionId: created.id };
    const succeeded = await insertDelivery(h.prisma, { ...base, status: 'succeeded' });
    const dead = await insertDelivery(h.prisma, { ...base, status: 'dead', attempts: 6 });

    const wrongState = await call(
      'POST',
      `/v1/webhooks/deliveries/${succeeded.id}/redeliver`,
      keyA,
    );
    expect(wrongState.statusCode).toBe(409);
    const otherTenant = await call('POST', `/v1/webhooks/deliveries/${dead.id}/redeliver`, keyB);
    expect(otherTenant.statusCode).toBe(404);
    expect(
      (await h.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: dead.id } })).status,
    ).toBe('dead');

    expect((await call('DELETE', `/v1/webhooks/${created.id}`, keyA)).statusCode).toBe(204);
    const deleted = await call('POST', `/v1/webhooks/deliveries/${dead.id}/redeliver`, keyA);
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().detail).toContain('deleted');
  });
});
