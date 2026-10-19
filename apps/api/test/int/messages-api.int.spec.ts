import { randomUUID } from 'node:crypto';
import type { Scope } from '@botcenter/contracts';
import { MessageResponse } from '@botcenter/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { MessagesApiModule } from '../../src/messages/messages.module';
import { QueuesService } from '../../src/queues/queues.service';
import { TestHarness } from '../support/harness';

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [MessagesApiModule], minio: true });
});

afterAll(async () => {
  await h?.close();
});

interface Fixture {
  tenant: Tenant;
  instance: Instance;
  key: string;
}

async function fixture(
  options: { tenant?: Partial<Tenant>; instance?: Partial<Instance>; scopes?: Scope[] } = {},
): Promise<Fixture> {
  const tenant = await h.createTenant(options.tenant);
  const instance = await h.createInstance(tenant.id, { status: 'connected', ...options.instance });
  const { key } = await h.createApiKey({
    tenantId: tenant.id,
    scopes: options.scopes ?? ['messages:send'],
  });
  return { tenant, instance, key };
}

function text(instanceId: string, extra: Record<string, unknown> = {}) {
  return { instance_id: instanceId, to: '5511987654321', type: 'text', text: 'Oi', ...extra };
}

function send(key: string, body: unknown, headers: Record<string, string> = {}) {
  return h.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { ...h.bearer(key), 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

function read(key: string, id: string) {
  return h.inject({ method: 'GET', url: `/v1/messages/${id}`, headers: h.bearer(key) });
}

function createUpload(key: string, body: unknown) {
  return h.inject({
    method: 'POST',
    url: '/v1/media',
    headers: { ...h.bearer(key), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

describe('POST /v1/messages', () => {
  it('refuses an invalid body with 400 VALIDATION_FAILED', async () => {
    const f = await fixture();
    const badPhone = await send(f.key, text(f.instance.id, { to: '+55 11 98765' }));
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const twoSources = await send(f.key, {
      instance_id: f.instance.id,
      to: '5511987654321',
      type: 'media',
      media_type: 'image',
      media_id: randomUUID(),
      url: 'https://files.example/a.png',
    });
    expect(twoSources.statusCode).toBe(400);
    expect(await h.prisma.message.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });

  it('answers 202 with the queued message and adds one job with the message id', async () => {
    const f = await fixture();
    const response = await send(f.key, text(f.instance.id, { priority: 'reply' }));
    expect(response.statusCode).toBe(202);
    const body = MessageResponse.parse(response.json());
    expect(body).toMatchObject({
      instance_id: f.instance.id,
      to_masked: '5511*****4321',
      type: 'text',
      status: 'queued',
      failure_reason: null,
    });
    const row = await h.prisma.message.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({
      tenantId: f.tenant.id,
      direction: 'outbound',
      status: 'queued',
      contact: '5511987654321',
      priority: 'reply',
      content: { type: 'text', text: 'Oi' },
    });
    const job = await h.get(QueuesService).get('outbound').getJob(body.id);
    expect(job?.name).toBe('send');
    expect(job?.data).toEqual({
      tenantId: f.tenant.id,
      messageId: body.id,
      instanceId: f.instance.id,
    });
    expect(job?.opts.priority).toBe(1);
  });

  it('replays the same Idempotency-Key and refuses the key with a different body (409)', async () => {
    const f = await fixture();
    const headers = { 'idempotency-key': `send-${randomUUID()}` };
    const first = await send(f.key, text(f.instance.id), headers);
    const second = await send(f.key, text(f.instance.id), headers);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    expect(await h.prisma.message.count({ where: { tenantId: f.tenant.id } })).toBe(1);

    const reused = await send(f.key, text(f.instance.id, { text: 'Outro' }), headers);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refuses a message above the daily quota with 429 and Retry-After until 00:00 UTC', async () => {
    const f = await fixture({ tenant: { maxMessagesPerDay: 2 } });
    expect((await send(f.key, text(f.instance.id))).statusCode).toBe(202);
    expect((await send(f.key, text(f.instance.id))).statusCode).toBe(202);
    const refused = await send(f.key, text(f.instance.id));
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const expected = Math.ceil((midnight - now.getTime()) / 1000);
    expect(Math.abs(Number(refused.headers['retry-after']) - expected)).toBeLessThanOrEqual(2);
    expect(await h.prisma.message.count({ where: { tenantId: f.tenant.id } })).toBe(2);
  });

  it('refuses the instance of another tenant, an unknown instance, and a deleted instance (403)', async () => {
    const a = await fixture();
    const b = await fixture();
    const deleted = await h.createInstance(b.tenant.id, {
      status: 'connected',
      deletedAt: new Date(),
    });
    for (const instanceId of [a.instance.id, randomUUID(), deleted.id]) {
      const response = await send(b.key, text(instanceId));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'INSTANCE_NOT_ALLOWED' });
    }
    expect(
      await h.prisma.message.count({ where: { tenantId: { in: [a.tenant.id, b.tenant.id] } } }),
    ).toBe(0);
  });

  it('refuses an instance outside the instance list of the key (403)', async () => {
    const f = await fixture();
    const other = await h.createInstance(f.tenant.id, { status: 'connected' });
    const { key } = await h.createApiKey({
      tenantId: f.tenant.id,
      scopes: ['messages:send'],
      instanceIds: [other.id],
    });
    const response = await send(key, text(f.instance.id));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'INSTANCE_NOT_ALLOWED' });
    expect((await send(key, text(other.id))).statusCode).toBe(202);
  });

  it('refuses an instance without a session (409) and queues for a disconnected instance', async () => {
    const f = await fixture();
    for (const status of ['logged_out', 'created'] as const) {
      const instance = await h.createInstance(f.tenant.id, { status });
      const response = await send(f.key, text(instance.id));
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'INSTANCE_NOT_CONNECTED' });
    }
    for (const status of ['disconnected', 'connecting'] as const) {
      const instance = await h.createInstance(f.tenant.id, { status });
      expect((await send(f.key, text(instance.id))).statusCode).toBe(202);
    }
  });

  it('answers 202 and keeps the row queued when the enqueue fails (the sweep sends it later)', async () => {
    const f = await fixture();
    const queues = h.get(QueuesService);
    const original = queues.get.bind(queues);
    const spy = vi.spyOn(queues, 'get').mockImplementation((name) => {
      const queue = original(name);
      return Object.assign(Object.create(queue) as typeof queue, {
        addBulk: () => Promise.reject(new Error('redis down')),
      });
    });
    try {
      const response = await send(f.key, text(f.instance.id));
      expect(response.statusCode).toBe(202);
      const row = await h.prisma.message.findUniqueOrThrow({ where: { id: response.json().id } });
      expect(row.status).toBe('queued');
      expect(await original('outbound').getJob(row.id)).toBeUndefined();
      expect(h.alerts.map((alert) => alert.dedupeKey)).toContain('outbound:enqueue');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GET /v1/messages/{id}', () => {
  it('reads a message of the tenant and hides it from other tenants and other instance lists', async () => {
    const a = await fixture();
    const b = await fixture();
    const id = (await send(a.key, text(a.instance.id))).json().id as string;

    const own = await read(a.key, id);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id, status: 'queued', instance_id: a.instance.id });

    expect((await read(b.key, id)).statusCode).toBe(404);
    const other = await h.createInstance(a.tenant.id, { status: 'connected' });
    const { key: limited } = await h.createApiKey({
      tenantId: a.tenant.id,
      scopes: ['messages:send'],
      instanceIds: [other.id],
    });
    expect((await read(limited, id)).statusCode).toBe(404);
    expect((await read(a.key, randomUUID())).statusCode).toBe(404);
    expect((await read(a.key, 'not-a-uuid')).statusCode).toBe(400);
  });

  it('does not show an inbound message', async () => {
    const f = await fixture();
    const inbound = await h.prisma.message.create({
      data: {
        tenantId: f.tenant.id,
        instanceId: f.instance.id,
        direction: 'inbound',
        type: 'text',
        status: 'received',
        contact: '5511987654321',
        content: { type: 'text', text: 'Oi' },
      },
    });
    expect((await read(f.key, inbound.id)).statusCode).toBe(404);
  });
});

describe('POST /v1/media', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('gives a pre-signed PUT URL that accepts only the declared type and size', async () => {
    const f = await fixture();
    const response = await createUpload(f.key, {
      content_type: 'image/png',
      size_bytes: PNG.length,
      file_name: 'treino.png',
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { media_id: string; upload_url: string; expires_at: string };
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now() + 800_000);
    const row = await h.prisma.mediaObject.findUniqueOrThrow({ where: { id: body.media_id } });
    expect(row).toMatchObject({
      tenantId: f.tenant.id,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      direction: 'outbound',
    });
    expect(row.key).not.toContain('treino');

    const wrongType = await fetch(body.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: PNG,
    });
    expect(wrongType.status).toBe(403);
    const wrongSize = await fetch(body.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: Buffer.concat([PNG, PNG]),
    });
    expect(wrongSize.ok).toBe(false);
    const upload = await fetch(body.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: PNG,
    });
    expect(upload.status).toBe(200);

    // The bucket is private: no anonymous read.
    const anonymous = await fetch(`${h.minio.endpoint}/${h.minio.bucket}/${row.key}`);
    expect(anonymous.status).toBe(403);
  });

  it('refuses an active content type and a size above the contract limit', async () => {
    const f = await fixture();
    const html = await createUpload(f.key, {
      content_type: 'text/html',
      size_bytes: 10,
      file_name: 'a.html',
    });
    expect(html.statusCode).toBe(400);
    expect(html.json().errors).toEqual([expect.objectContaining({ path: 'content_type' })]);
    const big = await createUpload(f.key, {
      content_type: 'video/mp4',
      size_bytes: 16 * 1024 * 1024 + 1,
      file_name: 'a.mp4',
    });
    expect(big.statusCode).toBe(400);
  });

  it('accepts a media_id of the tenant in a message and refuses it for another tenant', async () => {
    const a = await fixture();
    const b = await fixture();
    const mediaId = (
      await createUpload(a.key, { content_type: 'image/png', size_bytes: 8, file_name: 'a.png' })
    ).json().media_id as string;
    const message = (instanceId: string, mediaType = 'image') => ({
      instance_id: instanceId,
      to: '5511987654321',
      type: 'media',
      media_type: mediaType,
      media_id: mediaId,
      caption: 'Treino',
    });

    const accepted = await send(a.key, message(a.instance.id));
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ type: 'media', status: 'queued' });

    const wrongType = await send(a.key, message(a.instance.id, 'audio'));
    expect(wrongType.statusCode).toBe(400);
    const foreign = await send(b.key, message(b.instance.id));
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().errors).toEqual([expect.objectContaining({ path: 'media_id' })]);
  });

  it('needs the messages:send scope', async () => {
    const f = await fixture({ scopes: ['bots:write'] });
    const response = await createUpload(f.key, {
      content_type: 'image/png',
      size_bytes: 8,
      file_name: 'a.png',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'SCOPE_MISSING' });
  });
});
