import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import type { TenantInfo, TenantsService } from '../services/tenants.service';
import { generateApiKey, hashSecret } from './api-key';
import { ApiKeyAuthenticator } from './api-key.authenticator';
import type { ApiKeyRecord, ApiKeyService } from './api-key.service';

const env = testEnv();
const generated = generateApiKey();
const tenant = { id: 't-1', rateLimitPerMinute: 600 } as TenantInfo;

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'k-1',
    tenantId: 't-1',
    prefix: generated.prefix,
    secretHash: hashSecret(env.API_KEY_PEPPER, generated.secret),
    scopes: ['messages:send', 'unknown:scope'],
    instanceIds: [],
    allowedIps: [],
    rateLimitPerMinute: null,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function build(found: ApiKeyRecord | null, tenantInfo: TenantInfo | null = tenant) {
  const keys = { findByPrefix: vi.fn(async () => found), touch: vi.fn() };
  const tenants = { find: vi.fn(async () => tenantInfo) };
  const authenticator = new ApiKeyAuthenticator(
    env,
    keys as unknown as ApiKeyService,
    tenants as unknown as TenantsService,
  );
  return { authenticator, keys };
}

const header = `Bearer ${generated.key}`;

describe('ApiKeyAuthenticator', () => {
  it('returns the context, drops unknown scopes, uses the tenant default limit, and touches the key', async () => {
    const { authenticator, keys } = build(record());
    const result = await authenticator.authenticate(header, '203.0.113.1');
    expect(result).toEqual({
      context: {
        tenantId: 't-1',
        keyId: 'k-1',
        keyPrefix: generated.prefix,
        scopes: ['messages:send'],
        instanceIds: [],
      },
      rateLimitPerMinute: 600,
    });
    expect(keys.touch).toHaveBeenCalledWith('k-1', expect.any(Date));
  });

  it('uses the limit of the key when it has one', async () => {
    const { authenticator } = build(record({ rateLimitPerMinute: 5 }));
    expect((await authenticator.authenticate(header, undefined)).rateLimitPerMinute).toBe(5);
  });

  it.each([
    ['no header', undefined, record()],
    ['unknown key', header, null],
    ['wrong secret', `Bearer bc_live_${generated.prefix}_${'Z'.repeat(43)}`, record()],
    ['revoked key', header, record({ revokedAt: new Date().toISOString() })],
    ['expired key', header, record({ expiresAt: new Date(Date.now() - 1).toISOString() })],
  ])('refuses %s with 401 UNAUTHENTICATED', async (_name, value, found) => {
    const { authenticator, keys } = build(found);
    await expect(authenticator.authenticate(value, undefined)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(keys.touch).not.toHaveBeenCalled();
  });

  it('refuses a key of a tenant that does not exist', async () => {
    const { authenticator } = build(record(), null);
    await expect(authenticator.authenticate(header, undefined)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('applies the allowed IP list (403 FORBIDDEN) and fails closed on a bad entry', async () => {
    const { authenticator } = build(record({ allowedIps: ['10.0.0.0/8'] }));
    await expect(authenticator.authenticate(header, '10.2.3.4')).resolves.toBeDefined();
    await expect(authenticator.authenticate(header, '203.0.113.1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const { authenticator: broken } = build(record({ id: 'k-2', allowedIps: ['not-an-ip'] }));
    await expect(broken.authenticate(header, '10.2.3.4')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
