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
/**
 * Life of the revocation marker. It is longer than the cache life, so a request that read the row before
 * the revocation and writes the cache late cannot put back an entry without `revokedAt` (SEC-08).
 */
export const REVOCATION_MARKER_TTL_SECONDS = 120;
const TOUCH_INTERVAL_SECONDS = 60;
/**
 * The cache value of a prefix that does not exist, from older versions. The service does not write it
 * any more (SEC-10): a scan with random prefixes must not fill Redis, which BullMQ shares with no
 * eviction. The unique index on `prefix` and the failure limit for each address protect PostgreSQL.
 */
const MISSING = 'missing';

/** Writes the cache entry only when the revocation marker (KEYS[2]) does not exist. */
const FILL_UNLESS_REVOKED = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

/** Sets the revocation marker (KEYS[2]) first, then deletes the cache entry (KEYS[1]), in one step. */
const MARK_REVOKED = `
redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Reads API keys by prefix with a Redis cache (60 s). A revocation deletes the cache entry at once and
 * sets a revocation marker for 120 s (`markRevoked`), so a concurrent fill cannot put back the old record.
 * When Redis is down, the service reads PostgreSQL.
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
    if (!row) {
      return null;
    }
    const record: ApiKeyRecord = {
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
    };
    try {
      // A revocation between the read and this write sets the marker: the stale record is not cached.
      await this.redis.eval(
        FILL_UNLESS_REVOKED,
        2,
        cacheKey,
        redisKeys.apiKeyRevoked(prefix),
        JSON.stringify(record),
        String(KEY_CACHE_TTL_SECONDS),
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'api key cache write failed');
    }
    return record;
  }

  /** Deletes the cache entry. Call it after each change of a key (rotate, create). */
  async invalidate(prefix: string): Promise<void> {
    await this.redis.del(redisKeys.apiKey(prefix));
  }

  /**
   * Call it after the commit of a revocation: it sets the revocation marker and deletes the cache entry
   * in one Lua call. A concurrent cache fill that read the row before the commit then does not write.
   */
  async markRevoked(prefix: string): Promise<void> {
    await this.redis.eval(
      MARK_REVOKED,
      2,
      redisKeys.apiKey(prefix),
      redisKeys.apiKeyRevoked(prefix),
      String(REVOCATION_MARKER_TTL_SECONDS),
    );
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
