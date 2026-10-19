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

  async set(record: ConversationRecord): Promise<void> {
    const key = redisKeys.conversation(record.instanceId, contactKey(record.contact));
    try {
      await this.redis.set(key, JSON.stringify(record), 'EX', CONVERSATION_CACHE_TTL_SECONDS);
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
      // A stale entry is safe: its `version` is old, so the next write conflicts and reloads.
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
