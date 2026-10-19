import { describe, expect, it, vi } from 'vitest';
import type { AdminService } from '../admin/admin.service';
import { AppError } from '../common/errors/app-error';
import { runAdminCli } from './admin-cli';

function admin() {
  return {
    createTenant: vi.fn(async (input: unknown) => ({ id: 't', ...(input as object) })),
    updateQuotas: vi.fn(async () => ({ id: 't' })),
    createKey: vi.fn(async () => ({ key: 'bc_live_x', apiKey: { id: 'k' } })),
    listKeys: vi.fn(async () => []),
    revokeKey: vi.fn(async () => ({ id: 'k' })),
    rotateKey: vi.fn(async () => ({ key: 'bc_live_y', apiKey: { id: 'k2' }, replaces: 'old' })),
    replayRawEvent: vi.fn(async (id: string) => ({ raw_event_id: id, enqueued: 1, jobs: ['j'] })),
    resyncInstanceWebhooks: vi.fn(async () => ({ total: 2, succeeded: 1, failed: ['i2'] })),
  };
}

async function run(argv: string[], service = admin(), env: NodeJS.ProcessEnv = { USER: 'ana' }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdminCli(argv, service as unknown as AdminService, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    env,
  });
  return { code, out: out.join(''), err: err.join(''), service };
}

describe('runAdminCli', () => {
  it('parses the options, the lists, the numbers, and the actor', async () => {
    const { code, service } = await run([
      'key:create',
      '--tenant',
      'pl',
      '--name',
      'backend',
      '--scopes',
      'messages:send, events:read',
      '--instances',
      'a,b',
      '--rate-limit-per-minute',
      '30',
      '--expires-at',
      '2027-01-01T00:00:00Z',
    ]);
    expect(code).toBe(0);
    expect(service.createKey).toHaveBeenCalledWith(
      {
        tenant: 'pl',
        name: 'backend',
        scopes: ['messages:send', 'events:read'],
        instanceIds: ['a', 'b'],
        allowedIps: undefined,
        rateLimitPerMinute: 30,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      },
      'cli:ana',
    );
  });

  it('prints the new key once with a notice', async () => {
    const { out } = await run(['key:rotate', '--key', 'old', '--actor', 'bob']);
    expect(JSON.parse(out)).toMatchObject({
      key: 'bc_live_y',
      replaces: 'old',
      notice: expect.stringContaining('not shown again'),
    });
  });

  it('runs the other commands', async () => {
    const service = admin();
    await run(['tenant:create', '--name', 'PL', '--slug', 'pl', '--max-instances', '3'], service);
    await run(['tenant:update-quotas', '--tenant', 'pl', '--retention-days', '30'], service);
    await run(['key:list', '--tenant', 'pl'], service);
    await run(['key:revoke', '--key', 'abc'], service);
    expect(service.createTenant).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'PL', slug: 'pl', maxInstances: 3 }),
      'cli:ana',
    );
    expect(service.updateQuotas).toHaveBeenCalledWith(
      'pl',
      expect.objectContaining({ retentionDays: 30 }),
      'cli:ana',
    );
    expect(service.listKeys).toHaveBeenCalledWith('pl', 'cli:ana');
    expect(service.revokeKey).toHaveBeenCalledWith('abc', 'cli:ana');
  });

  it('exits with 2 on a usage error and 1 on an AppError', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['nope'])).code).toBe(2);
    expect((await run(['key:list'])).err).toContain('--tenant');
    expect(
      (await run(['tenant:create', '--name', 'x', '--slug', 'y', '--max-instances', 'ten'])).code,
    ).toBe(2);
    expect((await run(['key:list', '--unknown'])).code).toBe(2);
    const failing = admin();
    failing.revokeKey.mockRejectedValueOnce(new AppError('NOT_FOUND', 'API key not found'));
    const result = await run(['key:revoke', '--key', 'x'], failing);
    expect(result).toMatchObject({ code: 1, err: 'NOT_FOUND: API key not found' });
  });

  it('runs the replay and the webhook resync, with exit code 1 for a partial failure', async () => {
    const replay = await run(['raw-events:replay', '--id', 'r1']);
    expect(replay.code).toBe(0);
    expect(replay.service.replayRawEvent).toHaveBeenCalledWith('r1', 'cli:ana');
    const resync = await run(['instances:resync-webhook']);
    expect(resync.code).toBe(1);
    expect(JSON.parse(resync.out)).toMatchObject({ failed: ['i2'] });
    expect((await run(['raw-events:replay'])).code).toBe(2);
  });
});
