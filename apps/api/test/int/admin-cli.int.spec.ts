import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminCliModule } from '../../src/admin/admin.module';
import { AdminService } from '../../src/admin/admin.service';
import { redisKeys } from '../../src/redis/redis-keys';
import { runAdminCli } from '../../src/scripts/admin-cli';
import { TestHarness } from '../support/harness';
import { ProbeController } from '../support/probe.controller';

let h: TestHarness;
let admin: AdminService;

beforeAll(async () => {
  h = await TestHarness.start({ controllers: [ProbeController], modules: [AdminCliModule] });
  admin = h.get(AdminService);
});

afterAll(async () => {
  await h?.close();
});

async function cli(...argv: string[]): Promise<{ code: number; out: unknown; err: string }> {
  let out = '';
  let err = '';
  const code = await runAdminCli([...argv, '--actor', 'tester'], admin, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out: out ? JSON.parse(out) : undefined, err };
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await h.prisma.auditLog.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });
  expect(rows.every((row) => row.actor === 'cli:tester')).toBe(true);
  return rows.map((row) => row.action);
}

describe('admin CLI', () => {
  it('creates a tenant, updates the quotas, and creates a key that the API accepts', async () => {
    const created = await cli(
      'tenant:create',
      '--name',
      'PersonalLife',
      '--slug',
      'personallife',
      '--max-instances',
      '3',
    );
    expect(created.code).toBe(0);
    const tenant = created.out as { id: string; maxInstances: number };
    expect(tenant.maxInstances).toBe(3);

    const duplicate = await cli('tenant:create', '--name', 'Other', '--slug', 'personallife');
    expect(duplicate.code).toBe(1);
    expect(duplicate.err).toContain('CONFLICT');

    const updated = await cli(
      'tenant:update-quotas',
      '--tenant',
      'personallife',
      '--max-messages-per-day',
      '5000',
    );
    expect((updated.out as { maxMessagesPerDay: number }).maxMessagesPerDay).toBe(5000);

    const key = await cli(
      'key:create',
      '--tenant',
      'personallife',
      '--name',
      'backend',
      '--scopes',
      'messages:send,events:read',
    );
    expect(key.code).toBe(0);
    const output = key.out as { key: string; api_key: Record<string, unknown> };
    expect(output.key).toMatch(/^bc_live_[a-z0-9]{12}_[A-Za-z0-9]{43}$/);
    expect(output.api_key).not.toHaveProperty('secretHash');
    expect(output.api_key['scopes']).toEqual(['events:read', 'messages:send']);

    const response = await h.inject({
      method: 'GET',
      url: '/v1/probe/scoped',
      headers: h.bearer(output.key),
    });
    expect(response.statusCode).toBe(200);

    const listed = await cli('key:list', '--tenant', tenant.id);
    expect(listed.out).toHaveLength(1);
    expect(JSON.stringify(listed.out)).not.toContain(output.key.split('_').at(-1));

    expect(await auditActions(tenant.id)).toEqual([
      'tenant.create',
      'tenant.update_quotas',
      'api_key.create',
      'api_key.list',
    ]);
  });

  it('revokes a key at once (the cache entry is deleted)', async () => {
    const tenant = await h.createTenant();
    const created = (
      await cli('key:create', '--tenant', tenant.id, '--name', 'k', '--scopes', 'messages:send')
    ).out as {
      key: string;
      api_key: { prefix: string };
    };
    expect(
      (await h.inject({ method: 'GET', url: '/v1/probe/scoped', headers: h.bearer(created.key) }))
        .statusCode,
    ).toBe(200);
    expect(await h.redis.exists(redisKeys.apiKey(created.api_key.prefix))).toBe(1);

    const revoked = await cli('key:revoke', '--key', created.api_key.prefix);
    expect(revoked.code).toBe(0);
    expect(await h.redis.exists(redisKeys.apiKey(created.api_key.prefix))).toBe(0);
    expect(
      (await h.inject({ method: 'GET', url: '/v1/probe/scoped', headers: h.bearer(created.key) }))
        .statusCode,
    ).toBe(401);
    expect((await cli('key:revoke', '--key', created.api_key.prefix)).code).toBe(1);
  });

  it('rotates a key: the old key stays active, and a third active key with the same scopes is refused', async () => {
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    const old = (
      await cli(
        'key:create',
        '--tenant',
        tenant.id,
        '--name',
        'k',
        '--scopes',
        'messages:send',
        '--instances',
        instance.id,
      )
    ).out as { key: string; api_key: { prefix: string } };

    const rotated = await cli('key:rotate', '--key', old.api_key.prefix);
    expect(rotated.code).toBe(0);
    const next = rotated.out as {
      key: string;
      replaces: string;
      api_key: { instanceIds: string[] };
    };
    expect(next.replaces).toBe(old.api_key.prefix);
    expect(next.api_key.instanceIds).toEqual([instance.id]);
    for (const key of [old.key, next.key]) {
      expect(
        (await h.inject({ method: 'GET', url: '/v1/probe/scoped', headers: h.bearer(key) }))
          .statusCode,
      ).toBe(200);
    }

    const third = await cli('key:rotate', '--key', old.api_key.prefix);
    expect(third.code).toBe(1);
    expect(third.err).toContain('CONFLICT');
    expect(
      (await cli('key:create', '--tenant', tenant.id, '--name', 'k3', '--scopes', 'messages:send'))
        .code,
    ).toBe(1);
    // A different scope set has its own limit.
    expect(
      (await cli('key:create', '--tenant', tenant.id, '--name', 'bots', '--scopes', 'bots:write'))
        .code,
    ).toBe(0);

    expect((await cli('key:revoke', '--key', old.api_key.prefix)).code).toBe(0);
    expect((await cli('key:rotate', '--key', next.replaces)).code).toBe(1);
  });

  it('validates the input: unknown scope, instance of another tenant, bad address, unknown command', async () => {
    const tenant = await h.createTenant();
    const other = await h.createTenant();
    const foreign = await h.createInstance(other.id);
    expect(
      (await cli('key:create', '--tenant', tenant.id, '--name', 'k', '--scopes', 'all:things')).err,
    ).toContain('Unknown scope');
    expect(
      (
        await cli(
          'key:create',
          '--tenant',
          tenant.id,
          '--name',
          'k',
          '--scopes',
          'messages:send',
          '--instances',
          foreign.id,
        )
      ).err,
    ).toContain('instanceIds');
    expect(
      (
        await cli(
          'key:create',
          '--tenant',
          tenant.id,
          '--name',
          'k',
          '--scopes',
          'messages:send',
          '--allowed-ips',
          '300.1.1.1',
        )
      ).err,
    ).toContain('allowedIps');
    expect((await cli('key:destroy')).code).toBe(2);
    expect((await cli('tenant:create', '--name', 'x')).code).toBe(2);
  });
});
