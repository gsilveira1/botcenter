import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { getLogger } from '../logging/logger';

/**
 * The one factory of Redis connections.
 * - `client`: request path (key cache, rate limits, locks, dedupe). A command fails after 2 s, so the
 *   caller can continue with reduced function when Redis is down.
 * - `queue`: BullMQ producers (`Queue`). A command fails fast when Redis is down.
 * - `worker`: BullMQ consumers (`Worker`). BullMQ needs `maxRetriesPerRequest: null` (blocking commands).
 * All connections are lazy: no connection opens before the first command.
 */
export type RedisPurpose = 'client' | 'queue' | 'worker';

const ERROR_LOG_INTERVAL_MS = 10_000;

const OPTIONS: Record<RedisPurpose, RedisOptions> = {
  client: { maxRetriesPerRequest: 2, commandTimeout: 2_000 },
  queue: { maxRetriesPerRequest: 2 },
  worker: { maxRetriesPerRequest: null },
};

export function createRedisConnection(url: string, purpose: RedisPurpose, name?: string): Redis {
  const logger = getLogger('redis');
  const connection = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    connectionName: name ? `botcenter:${name}` : `botcenter:${purpose}`,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    ...OPTIONS[purpose],
  });
  // ioredis emits `error` on each failed reconnect. Log one line in each interval, not one per attempt.
  let lastErrorLogAt = 0;
  connection.on('error', (error: Error) => {
    const now = Date.now();
    if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      lastErrorLogAt = now;
      logger.error({ err: error, purpose, connection: name }, 'redis connection error');
    }
  });
  return connection;
}

/** Closes a connection. A connection that never opened is disconnected without a command. */
export async function closeRedis(connection: Redis): Promise<void> {
  if (['wait', 'end', 'close'].includes(connection.status)) {
    connection.disconnect();
    return;
  }
  try {
    await connection.quit();
  } catch (error) {
    getLogger('redis').warn({ err: error }, 'redis quit failed; disconnecting');
    connection.disconnect();
  }
}
