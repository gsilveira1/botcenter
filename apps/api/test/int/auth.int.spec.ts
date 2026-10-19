import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminOperationsService } from '../../src/admin/admin-operations.service';
import { AdminService } from '../../src/admin/admin.service';
import { ApiKeyService } from '../../src/auth/api-key.service';
import {
  AUTH_FAILURE_LIMIT_PER_MINUTE,
  CONNECT_REQUEST_LIMIT_PER_MINUTE,
} from '../../src/rate-limit/rate-limit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/services/audit.service';
import { TenantsService } from '../../src/services/tenants.service';
import { redisKeys } from '../../src/redis/redis-keys';
import { TestHarness } from '../support/harness';
import { ProbeController } from '../support/probe.controller';

let h: TestHarness;
let tenantId: string;

beforeAll(async () => {
  h = await TestHarness.start({ controllers: [ProbeController] });
  tenantId = (await h.createTenant()).id;
});

afterAll(async () => {
  await h?.close();
});

describe('API key authentication', () => {
  it('accepts a valid key with the scope and gives the AuthContext', async () => {
    const { key } = await h.createApiKey({ tenantId, scopes: ['messages:send'] });
    const response = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(key),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tenant_id: tenantId, scopes: ['messages:send'] });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('refuses a request without a key, with a malformed key, and with a wrong secret (401)', async () => {
    const { key } = await h.createApiKey({ tenantId, scopes: ['messages:send'] });
    const wrongSecret = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;
    for (const headers of [{}, h.bearer('bc_live_nope'), h.bearer(wrongSecret)]) {
      const response = await h.inject({ method: 'GET', url: '/v1/probe/scoped', headers });
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    }
  });

  it('refuses a revoked key at once: the revocation deletes the cache entry', async () => {
    const created = await h.createApiKey({ tenantId, scopes: ['messages:send'] });
    const first = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(created.key),
    });
    expect(first.statusCode).toBe(200);
    expect(await h.redis.exists(redisKeys.apiKey(created.prefix))).toBe(1);

    await h.prisma.apiKey.update({ where: { id: created.id }, data: { revokedAt: new Date() } });
    // Without the invalidation, the cached record (60 s) still accepts the key.
    const cached = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(created.key),
    });
    expect(cached.statusCode).toBe(200);

    await h.get(ApiKeyService).invalidate(created.prefix);
    const refused = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(created.key),
    });
    expect(refused.statusCode).toBe(401);
  });

  it('refuses a revoked key after a cache fill that read the row before the revocation (SEC-08)', async () => {
    const created = await h.createApiKey({ tenantId, scopes: ['messages:send'] });
    const keys = h.get(ApiKeyService);
    const admin = new AdminService(
      h.env,
      h.get(PrismaService),
      h.get(AuditService),
      keys,
      h.get(TenantsService),
      {} as AdminOperationsService,
    );
    // A request misses the cache and reads the row. The operator revokes the key before the request
    // writes the cache entry.
    const slowReader = {
      apiKey: {
        findUnique: async (args: { where: { prefix: string } }) => {
          const row = await h.prisma.apiKey.findUnique(args);
          await admin.revokeKey(created.prefix, 'cli:test');
          return row;
        },
      },
    } as unknown as PrismaService;
    const inFlight = await new ApiKeyService(slowReader, h.redis).findByPrefix(created.prefix);
    expect(inFlight?.revokedAt).toBeNull();

    const refused = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(created.key),
    });
    expect(refused.statusCode).toBe(401);
  });

  it('refuses an expired key (401)', async () => {
    const { key } = await h.createApiKey({
      tenantId,
      scopes: ['messages:send'],
      expiresAt: new Date(Date.now() - 1000),
    });
    const response = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(key),
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a key without the scope (403 SCOPE_MISSING)', async () => {
    const { key } = await h.createApiKey({ tenantId, scopes: ['bots:write'] });
    const response = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(key),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'SCOPE_MISSING' });
  });

  it('refuses an instance outside the instance list of the key (403 INSTANCE_NOT_ALLOWED)', async () => {
    const allowed = await h.createInstance(tenantId);
    const other = await h.createInstance(tenantId);
    const { key } = await h.createApiKey({
      tenantId,
      scopes: ['messages:send'],
      instanceIds: [allowed.id],
    });

    const ok = await h.inject({
      method: 'GET',
      url: `/v1/probe/instances/${allowed.id}`,
      headers: h.bearer(key),
    });
    expect(ok.statusCode).toBe(200);
    const refused = await h.inject({
      method: 'GET',
      url: `/v1/probe/instances/${other.id}`,
      headers: h.bearer(key),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'INSTANCE_NOT_ALLOWED' });

    const { key: allInstances } = await h.createApiKey({ tenantId, scopes: ['messages:send'] });
    const any = await h.inject({
      method: 'GET',
      url: `/v1/probe/instances/${other.id}`,
      headers: h.bearer(allInstances),
    });
    expect(any.statusCode).toBe(200);
  });

  it('applies the allowed IP list of the key to the client address after the trusted proxies', async () => {
    const { key } = await h.createApiKey({
      tenantId,
      scopes: ['messages:send'],
      allowedIps: ['203.0.113.0/24'],
    });
    const allowed = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: { ...h.bearer(key), 'x-forwarded-for': '203.0.113.9' },
    });
    expect(allowed.statusCode).toBe(200);
    const refused = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: { ...h.bearer(key), 'x-forwarded-for': '198.51.100.1' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a route without an access policy (403)', async () => {
    const { key } = await h.createApiKey({ tenantId, scopes: ['messages:send'] });
    const response = await h.inject({
      method: 'GET',
      url: '/v1/probe/undecorated',
      headers: h.bearer(key),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an unknown prefix and does not cache the miss: a scan cannot fill Redis (SEC-10)', async () => {
    const unknown = `bc_live_aaaaaaaaaaaa_${'A'.repeat(43)}`;
    const response = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(unknown),
    });
    expect(response.statusCode).toBe(401);
    expect(await h.redis.exists(redisKeys.apiKey('aaaaaaaaaaaa'))).toBe(0);
  });

  it('updates lastUsedAt at most once a minute', async () => {
    const created = await h.createApiKey({ tenantId, scopes: ['messages:send'] });
    await h.inject({ method: 'GET', url: '/v1/probe/scoped', headers: h.bearer(created.key) });
    let row = await h.prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    for (let attempt = 0; attempt < 20 && !row.lastUsedAt; attempt += 1) {
      await sleep(50);
      row = await h.prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    }
    const first = row.lastUsedAt;
    expect(first).toBeInstanceOf(Date);

    await h.inject({ method: 'GET', url: '/v1/probe/scoped', headers: h.bearer(created.key) });
    await sleep(200);
    row = await h.prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.lastUsedAt).toEqual(first);
  });
});

describe('limits for each client address without a valid key (SEC-10)', () => {
  it('answers 429 after 30 failed authentications in one minute, before the key lookup', async () => {
    const remoteAddress = '203.0.113.7';
    const { key } = await h.createApiKey({ tenantId, scopes: ['messages:send'] });
    for (let attempt = 0; attempt < AUTH_FAILURE_LIMIT_PER_MINUTE; attempt += 1) {
      const response = await h.inject({
        method: 'GET',
        url: '/v1/probe/scoped',
        remoteAddress,
        headers: h.bearer(`bc_live_${'r'.repeat(11)}${attempt % 10}_${'x'.repeat(43)}`),
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      remoteAddress,
      headers: h.bearer(key),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // Another client address is not limited.
    const other = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      remoteAddress: '203.0.113.8',
      headers: h.bearer(key),
    });
    expect(other.statusCode).toBe(200);
  });

  it('answers 429 after 30 connect stream requests in one minute from one address', async () => {
    const remoteAddress = '203.0.113.9';
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= CONNECT_REQUEST_LIMIT_PER_MINUTE; attempt += 1) {
      const response = await h.inject({
        method: 'GET',
        url: `/v1/connect/ct_${'a'.repeat(43)}/events`,
        remoteAddress,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, CONNECT_REQUEST_LIMIT_PER_MINUTE).every((code) => code === 401)).toBe(
      true,
    );
    expect(statuses.at(-1)).toBe(429);
  });
});
