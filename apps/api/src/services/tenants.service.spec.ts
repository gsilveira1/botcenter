import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from './tenants.service';

const tenant = {
  id: 't',
  name: 'T',
  slug: 't',
  maxInstances: 1,
  maxMessagesPerDay: 1,
  retentionDays: 1,
  rateLimitPerMinute: 1,
  instanceRateLimitPerMinute: 1,
};

describe('TenantsService', () => {
  it('reads PostgreSQL when Redis fails, and still answers', async () => {
    const redis = {
      get: vi.fn(async () => Promise.reject(new Error('down'))),
      set: vi.fn(async () => Promise.reject(new Error('down'))),
    };
    const prisma = { tenant: { findUnique: vi.fn(async () => tenant) } };
    const service = new TenantsService(
      prisma as unknown as PrismaService,
      redis as unknown as Redis,
    );
    await expect(service.get('t')).resolves.toEqual(tenant);
  });

  it('returns the cached value without a query', async () => {
    const redis = { get: vi.fn(async () => JSON.stringify(tenant)) };
    const prisma = { tenant: { findUnique: vi.fn() } };
    const service = new TenantsService(
      prisma as unknown as PrismaService,
      redis as unknown as Redis,
    );
    await expect(service.find('t')).resolves.toEqual(tenant);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});
