import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectEventsBus } from '../../src/instances/connect-events.bus';
import { ConnectStreamService } from '../../src/instances/connect-stream.service';
import { InstancesApiModule, InstancesWorkerModule } from '../../src/instances/instances.module';
import { TestHarness } from '../support/harness';
import { createInstanceViaApi } from '../support/instances';
import { openSse } from '../support/sse-client';
import type { SseClient } from '../support/sse-client';
import { waitFor } from '../support/wait-for';

/**
 * The full connect flow over HTTP: the real `EvolutionProvider` against the `FakeEvolutionServer`, the
 * provider webhooks through the worker, and a browser-like SSE client on the listening app.
 */
const ALLOWED_ORIGIN = 'https://app.example.com';
let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({
    fakeEvolution: true,
    modules: [InstancesApiModule],
    env: { CONNECT_ALLOWED_ORIGINS: ALLOWED_ORIGIN },
  });
  await h.startWorker([InstancesWorkerModule]);
});

afterAll(async () => {
  await h?.close();
});

async function setup() {
  const tenant = await h.createTenant();
  const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['instances:manage'] });
  const created = await createInstanceViaApi(h, key, `trainer-${randomUUID()}`);
  const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: created.id } });
  return { tenant, key, row };
}

async function connect(
  key: string,
  instanceId: string,
  body: Record<string, unknown> = { method: 'qrcode' },
) {
  const response = await h.inject({
    method: 'POST',
    url: `/v1/instances/${instanceId}/connect`,
    headers: { ...h.bearer(key), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  expect(response.statusCode).toBe(201);
  const json = response.json() as { connect_token: string; events_url: string };
  // `events_url` uses PUBLIC_BASE_URL; the test app listens on a random loopback port.
  return { ...json, url: `${h.baseUrl}${new URL(json.events_url).pathname}` };
}

async function streamsClosed() {
  await waitFor(
    () => h.get(ConnectStreamService).openCount === 0 && h.get(ConnectEventsBus).channelCount === 0,
  );
}

describe('connect flow', () => {
  it('create, connect, QR codes over SSE, connected closes the stream, and the events are in the outbox', async () => {
    const { tenant, key, row } = await setup();
    const { url } = await connect(key, row.id);

    const sse = await openSse(url, { origin: ALLOWED_ORIGIN });

    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(sse.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(sse.headers.get('x-accel-buffering')).toBe('no');
    expect(sse.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    const first = await sse.next();
    expect(first.event).toBe('qrcode');
    expect(first.data.png_base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(first.data.code).toBe(h.evolution.instance(row.providerName)?.qrcode?.code);
    expect((await sse.next('status')).data).toEqual({ type: 'status', status: 'connecting' });

    await h.evolution.emitQrcode(row.providerName);
    const renewed = await sse.next('qrcode');
    expect(renewed.data.code).not.toBe(first.data.code);
    expect(renewed.data.code).toBe(h.evolution.instance(row.providerName)?.qrcode?.code);

    await h.evolution.emitConnected(row.providerName, '5511912345678');
    expect((await sse.next('status')).data).toEqual({ type: 'status', status: 'connected' });
    await sse.closed;

    const instance = await h.prisma.instance.findUniqueOrThrow({ where: { id: row.id } });
    expect(instance).toMatchObject({ status: 'connected', phoneMasked: '5511*****5678' });
    const outbox = await h.prisma.outboxEvent.findMany({
      where: { tenantId: tenant.id, type: 'instance.status' },
      orderBy: { createdAt: 'asc' },
    });
    expect(outbox.map((event) => event.payload)).toEqual([
      expect.objectContaining({ status: 'connecting', previous_status: 'created' }),
      expect.objectContaining({
        status: 'connected',
        previous_status: 'connecting',
        external_ref: row.externalRef,
        phone_masked: '5511*****5678',
      }),
    ]);
    const audit = await h.prisma.auditLog.findMany({ where: { targetId: row.id } });
    expect(audit.map((entry) => entry.action)).toContain('instance.connect_stream.open');
    await streamsClosed();
  });

  it('refuses a second open of the same token (one use), also at the same time', async () => {
    const { key, row } = await setup();
    const { url } = await connect(key, row.id);

    const [a, b] = await Promise.all([openSse(url), openSse(url)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    const third = await openSse(url);
    expect(third.status).toBe(401);
    a.close();
    b.close();
    await streamsClosed();
  });

  it('sends the pairing code of the pairing_code method', async () => {
    const { key, row } = await setup();
    const { url } = await connect(key, row.id, { method: 'pairing_code', phone: '5511987654321' });

    const sse = await openSse(url);
    const pairing = await sse.next('pairing_code');

    expect(pairing.data.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(pairing.data.code).toBe(h.evolution.instance(row.providerName)?.qrcode?.pairingCode);
    sse.close();
    await streamsClosed();
  });

  it('writes expired at the end of the token and closes the stream', async () => {
    const { key, row } = await setup();
    const { url } = await connect(key, row.id);
    await h.prisma.connectToken.updateMany({
      where: { instanceId: row.id },
      data: { expiresAt: new Date(Date.now() + 1_500) },
    });

    const sse = await openSse(url);
    expect((await sse.next('expired', 5_000)).data).toEqual({ type: 'expired' });
    await sse.closed;
    await streamsClosed();
  });

  it('closes the stream of the older token when a new connect call makes a new token', async () => {
    const { key, row } = await setup();
    const older = await connect(key, row.id);
    const sse = await openSse(older.url);
    await sse.next('status');

    const newer = await connect(key, row.id);

    expect((await sse.next('expired')).data).toEqual({ type: 'expired' });
    await sse.closed;
    const fresh = await openSse(newer.url);
    expect(fresh.status).toBe(200);
    expect((await fresh.next('status')).data.status).toBe('connecting');
    fresh.close();
    await streamsClosed();
  });

  it('sends logged_out and closes the stream when the instance is deleted', async () => {
    const { key, row } = await setup();
    const { url } = await connect(key, row.id);
    const sse = await openSse(url);
    await sse.next('status');

    const deleted = await h.inject({
      method: 'DELETE',
      url: `/v1/instances/${row.id}`,
      headers: h.bearer(key),
    });

    expect(deleted.statusCode).toBe(200);
    expect((await sse.next('status')).data).toEqual({ type: 'status', status: 'logged_out' });
    await sse.closed;
    expect(h.evolution.instance(row.providerName)).toBeUndefined();
    await streamsClosed();
  });

  it('removes the Redis subscription when the client closes the stream', async () => {
    const { key, row } = await setup();
    const { url } = await connect(key, row.id);
    const sse: SseClient = await openSse(url);
    await sse.next('status');
    expect(h.get(ConnectStreamService).openCount).toBe(1);
    expect(h.get(ConnectEventsBus).channelCount).toBe(1);

    sse.close();

    await streamsClosed();
  });
});

describe('shutdown', () => {
  it('closes the open streams when the module stops, so the HTTP server can close', async () => {
    const { key, row } = await setup();
    const { url } = await connect(key, row.id);
    const sse = await openSse(url);
    await sse.next('status');

    h.get(ConnectStreamService).onModuleDestroy();

    await sse.closed;
    await streamsClosed();
  });
});

describe('CORS of the connect stream', () => {
  it('allows only the configured origins, also on a 401, and not on the other routes', async () => {
    const { key, row } = await setup();
    const { url } = await connect(key, row.id);

    const other = await openSse(url, { origin: 'https://evil.example.com' });
    expect(other.status).toBe(200);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect(other.headers.get('vary')).toContain('Origin');
    other.close();

    const refused = await fetch(url, { headers: { origin: ALLOWED_ORIGIN } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);

    const list = await fetch(`${h.baseUrl}/v1/instances`, {
      headers: { ...h.bearer(key), origin: ALLOWED_ORIGIN },
    });
    expect(list.status).toBe(200);
    expect(list.headers.get('access-control-allow-origin')).toBeNull();
    await streamsClosed();
  });
});
