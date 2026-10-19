import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { getLogger } from '../logging/logger';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';
import { contactKey } from './conversation-keys';
import { ConversationMetrics } from './conversation-metrics';
import { ConversationRecord } from './conversation-record';

/** Time to live of a hot cache entry. An idle conversation falls back to PostgreSQL. */
export const CONVERSATION_CACHE_TTL_SECONDS = 3_600;

/**
 * Compare-and-set on `version` (ARCH-09): the entry changes only when the cached version is not newer.
 * So a worker that read PostgreSQL before a handoff cannot put the older record back after the handoff
 * wrote the newer one. KEYS[1] = key, ARGV = record JSON, version, TTL in seconds. Returns 1 or 0.
 */
const SET_IF_NOT_OLDER = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, cached = pcall(cjson.decode, current)
  if ok and type(cached) == 'table' and tonumber(cached['version']) ~= nil
    and tonumber(cached['version']) > tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
return 1
`;

/**
 * The hot state of the conversations in Redis (architecture: "the hot state is in Redis with a TTL;
 * PostgreSQL is the source of truth"). Every method tolerates a Redis failure: it logs the error, counts
 * it, and the caller continues with PostgreSQL (slower, still correct).
 */
@Injectable()
export class ConversationCacheService {
  private readonly logger = getLogger('conversation-cache');

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly metrics: ConversationMetrics,
  ) {}

  /** The cached record, or `null` on a miss, a bad entry, or a Redis failure. */
  async get(instanceId: string, contact: string): Promise<ConversationRecord | null> {
    const key = redisKeys.conversation(instanceId, contactKey(contact));
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      this.failed(error, 'read');
      return null;
    }
    const parsed = raw === null ? null : this.parse(raw);
    this.metrics.cache.inc({ result: parsed === null ? 'miss' : 'hit' });
    return parsed;
  }

  /** Writes the record, unless the cache has a newer version of the conversation. */
  async set(record: ConversationRecord): Promise<void> {
    const key = redisKeys.conversation(record.instanceId, contactKey(record.contact));
    try {
      const written = await this.redis.eval(
        SET_IF_NOT_OLDER,
        1,
        key,
        JSON.stringify(record),
        record.version,
        CONVERSATION_CACHE_TTL_SECONDS,
      );
      if (written === 0) {
        this.metrics.cache.inc({ result: 'stale_write' });
      }
    } catch (error) {
      // A missing entry is safe: the next read uses PostgreSQL. Delete a stale entry if possible.
      this.failed(error, 'write');
      await this.delete(record.instanceId, record.contact);
    }
  }

  async delete(instanceId: string, contact: string): Promise<void> {
    try {
      await this.redis.del(redisKeys.conversation(instanceId, contactKey(contact)));
    } catch (error) {
      // A stale entry is safe: its `version` is old, so the next write conflicts and reloads, and a
      // cached handoff is read again from PostgreSQL before the bot skips a message (ARCH-09).
      this.failed(error, 'delete');
    }
  }

  private parse(raw: string): ConversationRecord | null {
    try {
      const parsed = ConversationRecord.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  private failed(error: unknown, operation: string): void {
    this.metrics.cache.inc({ result: 'error' });
    this.logger.warn(
      { err: error, operation },
      'conversation cache operation failed; PostgreSQL is used',
    );
  }
}
