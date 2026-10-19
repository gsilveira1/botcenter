import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tenant } from '../../src/generated/prisma/client';
import { InstancesApiModule, InstancesWorkerModule } from '../../src/instances/instances.module';
import { redisKeys } from '../../src/redis/redis-keys';
import { TestHarness } from '../support/harness';
import { connectionWebhook, createInstanceViaApi, qrcodeWebhook } from '../support/instances';
import { waitFor } from '../support/wait-for';

/**
 * The instance routes and the worker handlers with the in-memory provider (`h.provider`). The full
 * connect flow over HTTP (SSE) is in `connect-flow.int.spec.ts`.
 */
let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [InstancesApiModule] });
  await h.startWorker([InstancesWorkerModule]);
});

afterAll(async () => {
  await h?.close();
});

const JSON_HEADERS = { 'content-type': 'application/json' };

async function setupTenant(overrides: Partial<Tenant> = {}) {
  const tenant = await h.createTenant(overrides);
  const { key, prefix } = await h.createApiKey({
    tenantId: tenant.id,
    scopes: ['instances:manage'],
  });
  return { tenant, key, prefix };
}

function call(
  key: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return h.inject({
    method,
    url,
    headers: { ...h.bearer(key), ...(body === undefined ? {} : JSON_HEADERS), ...headers },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function createBody(externalRef = `trainer-${randomUUID()}`, extra: Record<string, unknown> = {}) {
  return { external_ref: externalRef, consent_at: '2026-10-19T09:00:00.000Z', ...extra };
}

async function outboxOf(tenantId: string) {
  return h.prisma.outboxEvent.findMany({
    where: { tenantId, type: 'instance.status' },
    orderBy: { createdAt: 'asc' },
  });
}

async function auditOf(instanceId: string) {
  return h.prisma.auditLog.findMany({
    where: { targetId: instanceId },
    orderBy: { createdAt: 'asc' },
  });
}

describe('POST /v1/instances', () => {
  it('creates the instance (201), creates it in the provider, and audits the consent', async () => {
    const { tenant, key, prefix } = await setupTenant({ instanceRateLimitPerMinute: 15 });

    const response = await call(key, 'POST', '/v1/instances', createBody('trainer-42'));

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      external_ref: 'trainer-42',
      status: 'created',
      phone_masked: null,
      bot_id: null,
      rate_limit_per_minute: 15,
    });
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.providerName).toMatch(/^inst_[0-9a-f-]{36}$/);
    expect(row.tenantId).toBe(tenant.id);
    expect(row.consentAt.toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(row.providerCreatedAt).not.toBeNull();
    expect(h.provider.instances.get(row.providerName)).toMatchObject({
      webhookUrl: h.webhookUrl,
      webhookSecret: h.env.EVOLUTION_WEBHOOK_SECRET,
    });
    const audit = await auditOf(body.id);
    expect(audit.map((entry) => entry.action)).toEqual(['instance.consent', 'instance.create']);
    expect(audit[0]).toMatchObject({
      actor: `api_key:${prefix}`,
      tenantId: tenant.id,
      metadata: { consent_at: '2026-10-19T09:00:00.000Z' },
    });
  });

  it('returns the active instance of the owner (200) and replays an Idempotency-Key', async () => {
    const { key } = await setupTenant();
    const first = await call(key, 'POST', '/v1/instances', createBody('owner-a'), {
      'idempotency-key': 'create-owner-a',
    });
    const again = await call(key, 'POST', '/v1/instances', createBody('owner-a'));
    const replay = await call(key, 'POST', '/v1/instances', createBody('owner-a'), {
      'idempotency-key': 'create-owner-a',
    });

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
  });

  it('refuses a new instance above the tenant quota (429 QUOTA_EXCEEDED)', async () => {
    const { key } = await setupTenant({ maxInstances: 1 });
    expect((await call(key, 'POST', '/v1/instances', createBody('one'))).statusCode).toBe(201);

    const second = await call(key, 'POST', '/v1/instances', createBody('two'));

    expect(second.statusCode).toBe(429);
    expect(second.json().code).toBe('QUOTA_EXCEEDED');
    // The owner of the existing instance still gets it back.
    expect((await call(key, 'POST', '/v1/instances', createBody('one'))).statusCode).toBe(200);
  });

  it('refuses a key with an instance list and a key without the scope', async () => {
    const { tenant } = await setupTenant();
    const instance = await h.createInstance(tenant.id);
    const limited = await h.createApiKey({
      tenantId: tenant.id,
      scopes: ['instances:manage'],
      instanceIds: [instance.id],
    });
    const noScope = await h.createApiKey({ tenantId: tenant.id, scopes: ['messages:send'] });

    const limitedResponse = await call(limited.key, 'POST', '/v1/instances', createBody());
    const noScopeResponse = await call(noScope.key, 'POST', '/v1/instances', createBody());

    expect(limitedResponse.statusCode).toBe(403);
    expect(limitedResponse.json().code).toBe('INSTANCE_NOT_ALLOWED');
    expect(noScopeResponse.statusCode).toBe(403);
    expect(noScopeResponse.json().code).toBe('SCOPE_MISSING');
  });

  it('keeps the instance when the provider fails, alerts, and creates it in the provider at connect', async () => {
    const { key } = await setupTenant();
    h.provider.failNext('createInstance', 'unavailable');

    const created = await call(key, 'POST', '/v1/instances', createBody());

    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('created');
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.json().id } });
    expect(row.providerCreatedAt).toBeNull();
    expect(h.alerts).toContainEqual(
      expect.objectContaining({ title: 'Provider instance not created at create time' }),
    );

    const connect = await call(key, 'POST', `/v1/instances/${row.id}/connect`, {
      method: 'qrcode',
    });

    expect(connect.statusCode).toBe(201);
    expect(h.provider.instances.has(row.providerName)).toBe(true);
    const after = await h.prisma.instance.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.providerCreatedAt).not.toBeNull();
  });
});

describe('GET /v1/instances', () => {
  it('reads an instance and hides it from other tenants and other key lists', async () => {
    const a = await setupTenant();
    const b = await setupTenant();
    const created = await createInstanceViaApi(h, a.key, 'reader');
    const other = await h.createInstance(a.tenant.id);
    const limited = await h.createApiKey({
      tenantId: a.tenant.id,
      scopes: ['instances:manage'],
      instanceIds: [other.id],
    });

    const own = await call(a.key, 'GET', `/v1/instances/${created.id}`);
    const foreign = await call(b.key, 'GET', `/v1/instances/${created.id}`);
    const notInList = await call(limited.key, 'GET', `/v1/instances/${created.id}`);
    const missing = await call(a.key, 'GET', `/v1/instances/${randomUUID()}`);

    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual(created);
    expect(foreign.statusCode).toBe(404);
    expect(notInList.statusCode).toBe(403);
    expect(notInList.json().code).toBe('INSTANCE_NOT_ALLOWED');
    expect(missing.statusCode).toBe(404);
  });

  it('lists the instances with the external_ref filter, the cursor, and the key list', async () => {
    const a = await setupTenant();
    const b = await setupTenant();
    const first = await createInstanceViaApi(h, a.key, 'list-1');
    const second = await createInstanceViaApi(h, a.key, 'list-2');
    await createInstanceViaApi(h, b.key, 'list-1');
    const limited = await h.createApiKey({
      tenantId: a.tenant.id,
      scopes: ['instances:manage'],
      instanceIds: [first.id],
    });

    const page1 = (await call(a.key, 'GET', '/v1/instances?limit=1')).json();
    const page2 = (
      await call(a.key, 'GET', `/v1/instances?limit=1&cursor=${page1.next_cursor}`)
    ).json();
    const filtered = (await call(a.key, 'GET', '/v1/instances?external_ref=list-1')).json();
    const limitedList = (await call(limited.key, 'GET', '/v1/instances')).json();

    expect(page1.data.map((item: { id: string }) => item.id)).toEqual([second.id]);
    expect(page2).toEqual({ data: [first], next_cursor: null });
    expect(filtered.data).toEqual([first]);
    expect(limitedList.data).toEqual([first]);
    const bad = await call(a.key, 'GET', '/v1/instances?cursor=bad');
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /v1/instances/{id}/connect', () => {
  it('makes a connect token (hash only), moves to connecting, audits, and caches the QR code', async () => {
    const { tenant, key, prefix } = await setupTenant();
    const created = await createInstanceViaApi(h, key, 'connect-qr');
    const before = Date.now();

    const response = await call(key, 'POST', `/v1/instances/${created.id}/connect`, {
      method: 'qrcode',
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.connect_token).toMatch(/^ct_/);
    expect(body.events_url).toBe(
      `${h.env.PUBLIC_BASE_URL}/v1/connect/${body.connect_token}/events`,
    );
    const expiresAt = new Date(body.expires_at).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(600_000 - 1_000);
    expect(expiresAt - before).toBeLessThanOrEqual(600_000 + 5_000);

    const tokens = await h.prisma.connectToken.findMany({ where: { instanceId: created.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      method: 'qrcode',
      usedAt: null,
      tokenHash: createHash('sha256').update(body.connect_token).digest('hex'),
    });
    expect(JSON.stringify(tokens)).not.toContain(body.connect_token);

    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('connecting');
    expect(row.disconnectedSince).toBeNull();
    const events = await outboxOf(tenant.id);
    expect(events.map((event) => event.payload)).toEqual([
      {
        instance_id: created.id,
        external_ref: 'connect-qr',
        status: 'connecting',
        previous_status: 'created',
        phone_masked: null,
      },
    ]);
    const audit = (await auditOf(created.id)).find((entry) => entry.action === 'instance.connect');
    expect(audit).toMatchObject({
      actor: `api_key:${prefix}`,
      metadata: { method: 'qrcode', result: 'token', token_id: tokens[0]!.id },
    });
    const cached = JSON.parse((await h.redis.get(redisKeys.connectCodes(created.id))) ?? '[]');
    expect(cached).toEqual([
      expect.objectContaining({ type: 'qrcode', png_base64: expect.not.stringContaining('data:') }),
    ]);
  });

  it('revokes the older token, ignores Idempotency-Key, and caches a pairing code', async () => {
    const { key } = await setupTenant();
    const created = await createInstanceViaApi(h, key, 'connect-twice');
    const url = `/v1/instances/${created.id}/connect`;
    const headers = { 'idempotency-key': 'same-key' };

    const first = await call(key, 'POST', url, { method: 'qrcode' }, headers);
    const second = await call(
      key,
      'POST',
      url,
      { method: 'pairing_code', phone: '5511987654321' },
      headers,
    );

    expect(second.statusCode).toBe(201);
    expect(second.json().connect_token).not.toBe(first.json().connect_token);
    const tokens = await h.prisma.connectToken.findMany({
      where: { instanceId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(tokens[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(tokens[1]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const old = await h.inject({
      method: 'GET',
      url: `/v1/connect/${first.json().connect_token}/events`,
    });
    expect(old.statusCode).toBe(401);
    expect(old.json().code).toBe('CONNECT_TOKEN_INVALID');
    const cached = JSON.parse((await h.redis.get(redisKeys.connectCodes(created.id))) ?? '[]');
    expect(cached).toContainEqual({
      type: 'pairing_code',
      code: expect.stringMatching(/^[A-Z0-9]{8}$/),
    });
  });

  it('answers 200 with the status and no token when the instance is already connected', async () => {
    const { tenant, key } = await setupTenant();
    const created = await createInstanceViaApi(h, key, 'already');
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } });
    h.provider.setState(row.providerName, 'connected');

    const response = await call(key, 'POST', `/v1/instances/${created.id}/connect`, {
      method: 'qrcode',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'connected' });
    expect(await h.prisma.connectToken.count({ where: { instanceId: created.id } })).toBe(0);
    expect((await outboxOf(tenant.id)).map((event) => event.payload)).toEqual([
      expect.objectContaining({ status: 'connected', previous_status: 'created' }),
    ]);
  });

  it('answers 503 PROVIDER_UNAVAILABLE without a token or a status change', async () => {
    const { key } = await setupTenant();
    const created = await createInstanceViaApi(h, key, 'down');
    h.provider.failNext('connect', 'unavailable');

    const response = await call(key, 'POST', `/v1/instances/${created.id}/connect`, {
      method: 'qrcode',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('PROVIDER_UNAVAILABLE');
    expect(response.headers['retry-after']).toBe('30');
    expect(await h.prisma.connectToken.count({ where: { instanceId: created.id } })).toBe(0);
    expect((await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } })).status).toBe(
      'created',
    );
  });

  it('refuses another tenant (404), a key list without the instance (403), and a bad body (400)', async () => {
    const a = await setupTenant();
    const b = await setupTenant();
    const created = await createInstanceViaApi(h, a.key, 'isolated');
    const limited = await h.createApiKey({
      tenantId: a.tenant.id,
      scopes: ['instances:manage'],
      instanceIds: [randomUUID()],
    });
    const url = `/v1/instances/${created.id}/connect`;

    expect((await call(b.key, 'POST', url, { method: 'qrcode' })).statusCode).toBe(404);
    expect((await call(limited.key, 'POST', url, { method: 'qrcode' })).statusCode).toBe(403);
    expect((await call(a.key, 'POST', url, { method: 'pairing_code' })).statusCode).toBe(400);
    expect(await h.prisma.connectToken.count({ where: { instanceId: created.id } })).toBe(0);
  });
});

describe('GET /v1/connect/{token}/events (refusals)', () => {
  it('refuses an unknown, a malformed, and an expired token with 401 CONNECT_TOKEN_INVALID', async () => {
    const { key } = await setupTenant();
    const created = await createInstanceViaApi(h, key, 'expired-token');
    const token = (
      await call(key, 'POST', `/v1/instances/${created.id}/connect`, { method: 'qrcode' })
    ).json().connect_token as string;
    await h.prisma.connectToken.updateMany({
      where: { instanceId: created.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    for (const value of [token, 'ct_unknown', `ct_${'A'.repeat(43)}`]) {
      const response = await h.inject({ method: 'GET', url: `/v1/connect/${value}/events` });
      expect(response.statusCode, value).toBe(401);
      expect(response.json().code).toBe('CONNECT_TOKEN_INVALID');
    }
    expect(
      (await h.prisma.connectToken.findFirstOrThrow({ where: { instanceId: created.id } })).usedAt,
    ).toBeNull();
  });
});

describe('DELETE /v1/instances/{id}', () => {
  it('logs out, deletes in the provider, soft deletes, revokes the tokens, and frees the external_ref', async () => {
    const { tenant, key, prefix } = await setupTenant({ maxInstances: 1 });
    const created = await createInstanceViaApi(h, key, 'leaving');
    await call(key, 'POST', `/v1/instances/${created.id}/connect`, { method: 'qrcode' });
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } });

    const response = await call(key, 'DELETE', `/v1/instances/${created.id}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id, status: 'logged_out' });
    expect(h.provider.instances.has(row.providerName)).toBe(false);
    const after = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.providerCreatedAt).toBeNull();
    const token = await h.prisma.connectToken.findFirstOrThrow({
      where: { instanceId: created.id },
    });
    expect(token.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await outboxOf(tenant.id)).at(-1)!.payload).toMatchObject({
      status: 'logged_out',
      previous_status: 'connecting',
    });
    expect((await auditOf(created.id)).at(-1)).toMatchObject({
      action: 'instance.delete',
      actor: `api_key:${prefix}`,
      metadata: { previous_status: 'connecting', revoked_tokens: 1 },
    });
    expect(await h.redis.exists(redisKeys.connectCodes(created.id))).toBe(0);

    expect((await call(key, 'GET', `/v1/instances/${created.id}`)).statusCode).toBe(404);
    expect((await call(key, 'DELETE', `/v1/instances/${created.id}`)).statusCode).toBe(404);
    const again = await call(key, 'POST', '/v1/instances', createBody('leaving'));
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(created.id);
  });

  it('answers 503 and changes nothing when the provider fails', async () => {
    const { key } = await setupTenant();
    const created = await createInstanceViaApi(h, key, 'stays');
    h.provider.failNext('deleteInstance', 'unavailable');

    const response = await call(key, 'DELETE', `/v1/instances/${created.id}`);

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('PROVIDER_UNAVAILABLE');
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.status).toBe('created');
    // The retry succeeds: the provider calls are idempotent.
    expect((await call(key, 'DELETE', `/v1/instances/${created.id}`)).statusCode).toBe(200);
  });

  it('refuses another tenant (404) and a key list without the instance (403)', async () => {
    const a = await setupTenant();
    const b = await setupTenant();
    const created = await createInstanceViaApi(h, a.key, 'protected');
    const limited = await h.createApiKey({
      tenantId: a.tenant.id,
      scopes: ['instances:manage'],
      instanceIds: [randomUUID()],
    });

    expect((await call(b.key, 'DELETE', `/v1/instances/${created.id}`)).statusCode).toBe(404);
    expect((await call(limited.key, 'DELETE', `/v1/instances/${created.id}`)).statusCode).toBe(403);
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).toBeNull();
  });
});

describe('worker: connection.updated and qrcode.updated', () => {
  async function connectingInstance() {
    const { tenant, key } = await setupTenant();
    const created = await createInstanceViaApi(h, key, `worker-${randomUUID()}`);
    await call(key, 'POST', `/v1/instances/${created.id}/connect`, { method: 'qrcode' });
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } });
    return { tenant, row };
  }

  async function statusOf(id: string) {
    return h.prisma.instance.findUniqueOrThrow({ where: { id } });
  }

  async function post(body: Record<string, unknown>) {
    const response = await h.postProviderWebhook(body);
    expect(response.statusCode).toBe(200);
  }

  it('applies connected with the masked phone, writes the event, and clears the cached codes', async () => {
    const { tenant, row } = await connectingInstance();

    await post(
      connectionWebhook({ instanceName: row.providerName, state: 'open', phone: '5511912345678' }),
    );
    await waitFor(async () => (await statusOf(row.id)).status === 'connected');

    const after = await statusOf(row.id);
    expect(after.phoneMasked).toBe('5511*****5678');
    expect(after.disconnectedSince).toBeNull();
    expect((await outboxOf(tenant.id)).at(-1)!.payload).toEqual({
      instance_id: row.id,
      external_ref: row.externalRef,
      status: 'connected',
      previous_status: 'connecting',
      phone_masked: '5511*****5678',
    });
    expect(await h.redis.exists(redisKeys.connectCodes(row.id))).toBe(0);
  });

  it('ignores a duplicate status and a stale event, and tracks an incident until logged_out', async () => {
    const { tenant, row } = await connectingInstance();
    const name = row.providerName;
    const t0 = Date.now();
    await post(connectionWebhook({ instanceName: name, state: 'open', at: new Date(t0) }));
    await waitFor(async () => (await statusOf(row.id)).status === 'connected');
    const eventsAfterConnect = (await outboxOf(tenant.id)).length;

    // A duplicate (same status, later time) and a stale event (older time) change nothing.
    await post(connectionWebhook({ instanceName: name, state: 'open', at: new Date(t0 + 1_000) }));
    await post(
      connectionWebhook({
        instanceName: name,
        state: 'close',
        statusReason: 428,
        at: new Date(t0 - 60_000),
      }),
    );
    await waitFor(async () => (await statusOf(row.id)).providerEventAt?.getTime() === t0 + 1_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await statusOf(row.id)).status).toBe('connected');
    expect(await outboxOf(tenant.id)).toHaveLength(eventsAfterConnect);

    // A lost connection: Evolution reports `connecting`. The incident starts.
    await post(
      connectionWebhook({ instanceName: name, state: 'connecting', at: new Date(t0 + 2_000) }),
    );
    await waitFor(async () => (await statusOf(row.id)).status === 'connecting');
    expect((await statusOf(row.id)).disconnectedSince).not.toBeNull();

    // The person removes the device: `close` with 401 is `logged_out`. The incident ends.
    await post(
      connectionWebhook({
        instanceName: name,
        state: 'close',
        statusReason: 401,
        at: new Date(t0 + 3_000),
      }),
    );
    await waitFor(async () => (await statusOf(row.id)).status === 'logged_out');
    expect((await statusOf(row.id)).disconnectedSince).toBeNull();
    expect((await outboxOf(tenant.id)).slice(-2).map((event) => event.payload)).toEqual([
      expect.objectContaining({ status: 'connecting', previous_status: 'connected' }),
      expect.objectContaining({ status: 'logged_out', previous_status: 'connecting' }),
    ]);
  });

  it('caches a new QR code and pairing code, and drops a code for a connected instance', async () => {
    const { row } = await connectingInstance();
    await h.redis.del(redisKeys.connectCodes(row.id));

    await post(qrcodeWebhook(row.providerName, { code: '2@new-code', pairingCode: 'WZYEH1YY' }));
    await waitFor(async () => (await h.redis.exists(redisKeys.connectCodes(row.id))) === 1);

    const cached = JSON.parse((await h.redis.get(redisKeys.connectCodes(row.id))) ?? '[]');
    expect(cached).toEqual([
      expect.objectContaining({ type: 'qrcode', code: '2@new-code' }),
      { type: 'pairing_code', code: 'WZYEH1YY' },
    ]);

    await post(connectionWebhook({ instanceName: row.providerName, state: 'open' }));
    await waitFor(async () => (await statusOf(row.id)).status === 'connected');
    const late = qrcodeWebhook(row.providerName, { code: '2@late-code' });
    await post(late);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await h.redis.exists(redisKeys.connectCodes(row.id))).toBe(0);
  });
});
