import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { notFound } from '../common/errors/app-error';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';

/** A tenant with its quotas and limits. */
export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  maxInstances: number;
  maxMessagesPerDay: number;
  retentionDays: number;
  rateLimitPerMinute: number;
  instanceRateLimitPerMinute: number;
}

const CACHE_TTL_SECONDS = 60;

const SELECT = {
  id: true,
  name: true,
  slug: true,
  maxInstances: true,
  maxMessagesPerDay: true,
  retentionDays: true,
  rateLimitPerMinute: true,
  instanceRateLimitPerMinute: true,
} as const;

/**
 * Loads a tenant with its quotas. The value stays 60 s in Redis. `admin:tenant:update-quotas` deletes the
 * cache entry. When Redis is down, the service reads PostgreSQL (slower, same result).
 */
@Injectable()
export class TenantsService {
  private readonly logger = getLogger('tenants');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async find(tenantId: string): Promise<TenantInfo | null> {
    const cached = await this.readCache(tenantId);
    if (cached) {
      return cached;
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: SELECT });
    if (tenant) {
      await this.writeCache(tenant);
    }
    return tenant;
  }

  /** Throws 404 `NOT_FOUND` when the tenant does not exist. */
  async get(tenantId: string): Promise<TenantInfo> {
    const tenant = await this.find(tenantId);
    if (!tenant) {
      throw notFound('Tenant');
    }
    return tenant;
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.redis.del(redisKeys.tenant(tenantId));
  }

  private async readCache(tenantId: string): Promise<TenantInfo | null> {
    try {
      const raw = await this.redis.get(redisKeys.tenant(tenantId));
      return raw ? (JSON.parse(raw) as TenantInfo) : null;
    } catch (error) {
      this.logger.warn(
        { err: error, tenant_id: tenantId },
        'tenant cache read failed; reading the database',
      );
      return null;
    }
  }

  private async writeCache(tenant: TenantInfo): Promise<void> {
    try {
      await this.redis.set(
        redisKeys.tenant(tenant.id),
        JSON.stringify(tenant),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn({ err: error, tenant_id: tenant.id }, 'tenant cache write failed');
    }
  }
}
