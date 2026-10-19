import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness } from '../support/harness';
import { ProbeController, probeCalls } from '../support/probe.controller';

let h: TestHarness;
let tenantId: string;
let key: string;

beforeAll(async () => {
  h = await TestHarness.start({
    controllers: [ProbeController],
    env: { BODY_LIMIT_BYTES: '2048' },
  });
  tenantId = (await h.createTenant()).id;
  key = (await h.createApiKey({ tenantId, scopes: ['messages:send'] })).key;
});

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  probeCalls.echo = 0;
});

function echo(idempotencyKey: string | undefined, body: unknown, apiKey = key) {
  return h.inject({
    method: 'POST',
    url: '/v1/probe/echo',
    headers: {
      ...h.bearer(apiKey),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

describe('Idempotency-Key', () => {
  it('replays the stored status and body for the same key and the same body', async () => {
    const first = await echo('replay-1', { value: 'a' });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBe('false');
    const second = await echo('replay-1', { value: 'a' });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(probeCalls.echo).toBe(1);
  });

  it('treats the same body in a different key order as the same request', async () => {
    const first = await echo('order-1', { value: 'a', delay_ms: 1 });
    const second = await echo('order-1', { delay_ms: 1, value: 'a' });
    expect(second.json()).toEqual(first.json());
  });

  it('refuses the same key with a different body (409 IDEMPOTENCY_KEY_REUSED)', async () => {
    await echo('reuse-1', { value: 'a' });
    const response = await echo('reuse-1', { value: 'b' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refuses a concurrent request with the same key (409 IDEMPOTENCY_IN_PROGRESS)', async () => {
    const slow = echo('concurrent-1', { value: 'a', delay_ms: 600 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const concurrent = await echo('concurrent-1', { value: 'a', delay_ms: 600 });
    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json()).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect(concurrent.headers['retry-after']).toBe('1');
    expect((await slow).statusCode).toBe(201);
    expect(
      (await echo('concurrent-1', { value: 'a', delay_ms: 600 })).headers['idempotency-replayed'],
    ).toBe('true');
  });

  it('frees the key after a failed request, so that a retry runs again', async () => {
    const headers = { ...h.bearer(key), 'idempotency-key': 'fail-1' };
    const first = await h.inject({ method: 'POST', url: '/v1/probe/fail', headers, payload: {} });
    expect(first.statusCode).toBe(409);
    expect(
      await h.prisma.idempotencyKey.count({ where: { tenantId, key: { endsWith: ':fail-1' } } }),
    ).toBe(0);
  });

  it('scopes the key by tenant', async () => {
    const otherTenant = await h.createTenant();
    const otherKey = (await h.createApiKey({ tenantId: otherTenant.id, scopes: ['messages:send'] }))
      .key;
    await echo('tenant-1', { value: 'a' });
    const other = await echo('tenant-1', { value: 'b' }, otherKey);
    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotency-replayed']).toBe('false');
  });

  it('runs every request without the header', async () => {
    await echo(undefined, { value: 'a' });
    await echo(undefined, { value: 'a' });
    expect(probeCalls.echo).toBe(2);
  });

  it('refuses an invalid key header (400)', async () => {
    const response = await echo('x'.repeat(300), { value: 'a' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'Idempotency-Key' }],
    });
  });
});

describe('rate limit of the API key', () => {
  it('sends the RateLimit headers and refuses above the limit with 429 and Retry-After', async () => {
    const limited = await h.createApiKey({
      tenantId,
      scopes: ['messages:send'],
      rateLimitPerMinute: 2,
    });
    const first = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(limited.key),
    });
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    await h.inject({ method: 'GET', url: '/v1/probe/scoped', headers: h.bearer(limited.key) });
    const refused = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(limited.key),
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(refused.headers['ratelimit-limit']).toBe('2');
    expect(refused.headers['ratelimit-remaining']).toBe('0');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('uses the default of the tenant when the key has no limit', async () => {
    const tenant = await h.createTenant({ rateLimitPerMinute: 7 });
    const created = await h.createApiKey({ tenantId: tenant.id, scopes: ['messages:send'] });
    const response = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(created.key),
    });
    expect(response.headers['ratelimit-limit']).toBe('7');
  });
});

describe('Problem Details', () => {
  it('maps an unknown route to 404 NOT_FOUND', async () => {
    const response = await h.inject({ method: 'GET', url: '/v1/nothing-here?x=1' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      type: 'urn:botcenter:problem:not-found',
      code: 'NOT_FOUND',
      status: 404,
      instance: '/v1/nothing-here',
    });
  });

  it('maps a Zod validation error to 400 with field errors', async () => {
    const response = await echo(undefined, { value: '' });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors).toEqual([{ path: 'value', message: expect.any(String) }]);
  });

  it('maps query errors with the query prefix and coerces the query', async () => {
    const bad = await h.inject({
      method: 'GET',
      url: '/v1/probe/page?limit=1000',
      headers: h.bearer(key),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0].path).toBe('query.limit');
    const good = await h.inject({
      method: 'GET',
      url: '/v1/probe/page?limit=5',
      headers: h.bearer(key),
    });
    expect(good.json()).toEqual({ limit: 5 });
  });

  it('maps malformed JSON to 400, a large body to 413, and a non-JSON body to 415', async () => {
    const headers = { ...h.bearer(key), 'content-type': 'application/json' };
    const malformed = await h.inject({
      method: 'POST',
      url: '/v1/probe/echo',
      headers,
      payload: '{"value":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe('VALIDATION_FAILED');

    const large = await h.inject({
      method: 'POST',
      url: '/v1/probe/echo',
      headers,
      payload: JSON.stringify({ value: 'x'.repeat(4096) }),
    });
    expect(large.statusCode).toBe(413);
    expect(large.headers['content-type']).toContain('application/problem+json');

    const text = await h.inject({
      method: 'POST',
      url: '/v1/probe/echo',
      headers: { ...h.bearer(key), 'content-type': 'text/plain' },
      payload: 'value',
    });
    expect(text.statusCode).toBe(415);
  });

  it('hides the detail of an unexpected error and sends an alert', async () => {
    const response = await h.inject({
      method: 'GET',
      url: '/v1/probe/boom',
      headers: { 'x-request-id': 'req-boom-1' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: 'urn:botcenter:problem:internal',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Internal error',
      code: 'INTERNAL',
      instance: '/v1/probe/boom',
      request_id: 'req-boom-1',
    });
    expect(response.headers['x-request-id']).toBe('req-boom-1');
    expect(h.alerts.some((alert) => alert.title.includes('/v1/probe/boom'))).toBe(true);
  });

  it('sets the security headers', async () => {
    const response = await h.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
