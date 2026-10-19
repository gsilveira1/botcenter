import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/auth-context';
import { AppError } from '../common/errors/app-error';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../services/audit.service';
import type { WebhookSecrets } from '../webhooks/webhook-secrets';
import { BotsService } from './bots.service';

const auth: AuthContext = {
  tenantId: 't1',
  keyId: 'k',
  keyPrefix: 'p',
  scopes: ['bots:write'],
  instanceIds: ['i1'],
};

function build() {
  const forTenant = vi.fn();
  const service = new BotsService(
    { forTenant } as unknown as PrismaService,
    { record: vi.fn() } as unknown as AuditService,
    { seal: vi.fn() } as unknown as WebhookSecrets,
  );
  return { service, forTenant };
}

describe('BotsService.put', () => {
  it('answers 422 BOT_DEFINITION_INVALID with dot paths under "definition", before any query', async () => {
    const { service, forTenant } = build();
    const error = await service
      .put(auth, 'bot', {
        name: 'Bot',
        definition: { initial_state: 'x', states: { a: { transitions: [], extra: 1 } } },
        instance_ids: [],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('BOT_DEFINITION_INVALID');
    expect((error as AppError).errors?.map((issue) => issue.path).sort()).toEqual([
      'definition.initial_state',
      'definition.states.a',
    ]);
    expect(forTenant).not.toHaveBeenCalled();
  });

  it('answers 403 for an instance outside the key list, before any query', async () => {
    const { service, forTenant } = build();
    await expect(
      service.put(auth, 'bot', {
        name: 'Bot',
        definition: { initial_state: 'a', states: { a: { transitions: [] } } },
        instance_ids: ['i2'],
      }),
    ).rejects.toMatchObject({ code: 'INSTANCE_NOT_ALLOWED' });
    expect(forTenant).not.toHaveBeenCalled();
  });
});
