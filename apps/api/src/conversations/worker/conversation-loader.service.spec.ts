import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ConversationCacheService } from '../conversation-cache.service';
import { ConversationLoader } from './conversation-loader.service';

const instance = {
  tenantId: 't1',
  instanceId: 'i1',
  providerName: 'p',
  externalRef: 'o',
  botId: 'b',
};
const now = new Date();
const row = {
  id: '0199a000-0000-7000-8000-000000000004',
  tenantId: '0199a000-0000-7000-8000-000000000001',
  instanceId: '0199a000-0000-7000-8000-000000000002',
  contact: '5511987654321',
  botId: '0199a000-0000-7000-8000-000000000003',
  botVersion: 1,
  state: 'inicio',
  variables: { nome: 'Ana', broken: { nested: true } },
  version: 2,
  handoff: false,
  lastMenu: null,
  lastInboundAt: null,
  createdAt: now,
  updatedAt: now,
};

function build(cached: unknown) {
  const cache = { get: vi.fn(async () => cached), set: vi.fn(async () => undefined) };
  const findUnique = vi.fn(async () => row);
  const prisma = {
    forTenant: () => ({ conversation: { findUnique } }),
  } as unknown as PrismaService;
  return {
    loader: new ConversationLoader(prisma, cache as unknown as ConversationCacheService),
    cache,
    findUnique,
  };
}

describe('ConversationLoader', () => {
  it('uses the hot cache first', async () => {
    const { loader, findUnique } = build({ id: 'cached' });
    await expect(loader.load(instance, '5511987654321')).resolves.toEqual({ id: 'cached' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reads PostgreSQL on a miss (also when Redis fails) and fills the cache', async () => {
    const { loader, cache } = build(null);
    const record = await loader.load(instance, '5511987654321');
    expect(record).toMatchObject({ id: row.id, state: 'inicio', variables: { nome: 'Ana' } });
    expect(record?.variables).not.toHaveProperty('broken');
    expect(cache.set).toHaveBeenCalledWith(record);
  });

  it('skips the cache when fresh', async () => {
    const { loader, cache, findUnique } = build({ id: 'cached' });
    await loader.load(instance, '5511987654321', { fresh: true });
    expect(cache.get).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalled();
  });
});
