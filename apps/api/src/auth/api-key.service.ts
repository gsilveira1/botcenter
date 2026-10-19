import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';

/** The fields of an API key that the guard needs. This is the value of the Redis cache. */
export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  prefix: string;
  secretHash: string;
  scopes: string[];
  instanceIds: string[];
  allowedIps: string[];
  rateLimitPerMinute: number | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

export const KEY_CACHE_TTL_SECONDS = 60;
const TOUCH_INTERVAL_SECONDS = 60;
/** The cache value of a prefix that does not exist (a scan with random keys does not reach the database). */
const MISSING = 'missing';

/**
 * Reads API keys by prefix with a Redis cache (60 s). A revocation deletes the cache entry at once
 * (`invalidate`). When Redis is down, the service reads PostgreSQL.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = getLogger('api-keys');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const cacheKey = redisKeys.apiKey(prefix);
    let cached: string | null = null;
    try {
      cached = await this.redis.get(cacheKey);
    } catch (error) {
      this.logger.warn({ err: error }, 'api key cache read failed; reading the database');
    }
    if (cached === MISSING) {
      return null;
    }
    if (cached) {
      return JSON.parse(cached) as ApiKeyRecord;
    }
    const row = await this.prisma.apiKey.findUnique({ where: { prefix } });
    const record: ApiKeyRecord | null = row
      ? {
          id: row.id,
          tenantId: row.tenantId,
          prefix: row.prefix,
          secretHash: row.secretHash,
          scopes: row.scopes,
          instanceIds: row.instanceIds,
          allowedIps: row.allowedIps,
          rateLimitPerMinute: row.rateLimitPerMinute,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        }
      : null;
    try {
      await this.redis.set(
        cacheKey,
        record ? JSON.stringify(record) : MISSING,
        'EX',
        KEY_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'api key cache write failed');
    }
    return record;
  }

  /** Deletes the cache entry. Call it after each change of a key (revoke, rotate, create). */
  async invalidate(prefix: string): Promise<void> {
    await this.redis.del(redisKeys.apiKey(prefix));
  }

  /**
   * Updates `lastUsedAt` at most once a minute for each key. The request does not wait for it, and an
   * error is logged only: the timestamp is information, not a control.
   */
  touch(keyId: string, now = new Date()): void {
    void (async () => {
      try {
        const first = await this.redis.set(
          redisKeys.apiKeyTouched(keyId),
          '1',
          'EX',
          TOUCH_INTERVAL_SECONDS,
          'NX',
        );
        if (first === 'OK') {
          await this.prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: now } });
        }
      } catch (error) {
        this.logger.warn({ err: error, key_id: keyId }, 'api key lastUsedAt update failed');
      }
    })();
  }
}
