import { Inject, Injectable } from '@nestjs/common';
import { CONNECT_TOKEN_TTL_SECONDS } from '@botcenter/contracts';
import type { ConnectEvent } from '@botcenter/contracts';
import type { Redis } from 'ioredis';
import { getLogger } from '../logging/logger';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';
import { CachedCodes } from './connect-events';
import type { ChannelMessage } from './connect-events';

/**
 * The Redis side of the connect flow, in both processes:
 * - the latest code events of an instance (TTL: the life of a connect token), for the first event of a
 *   new stream;
 * - the pub/sub channel of the instance, for the open streams of all the API processes.
 * The methods throw the Redis errors. The caller decides if the operation can continue without Redis.
 */
@Injectable()
export class ConnectChannelService {
  private readonly logger = getLogger('connect-channel');

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async saveCodes(instanceId: string, events: readonly ConnectEvent[]): Promise<void> {
    await this.redis.set(
      redisKeys.connectCodes(instanceId),
      JSON.stringify(events),
      'EX',
      CONNECT_TOKEN_TTL_SECONDS,
    );
  }

  async readCodes(instanceId: string): Promise<ConnectEvent[]> {
    const raw = await this.redis.get(redisKeys.connectCodes(instanceId));
    if (!raw) {
      return [];
    }
    const parsed = CachedCodes.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.logger.warn({ instance_id: instanceId }, 'cached connect codes are not valid; ignored');
      return [];
    }
    return parsed.data;
  }

  async clearCodes(instanceId: string): Promise<void> {
    await this.redis.del(redisKeys.connectCodes(instanceId));
  }

  async publish(instanceId: string, message: ChannelMessage): Promise<void> {
    await this.redis.publish(redisKeys.connectChannel(instanceId), JSON.stringify(message));
  }

  /** Saves the codes and publishes each one. */
  async publishCodes(instanceId: string, events: readonly ConnectEvent[]): Promise<void> {
    await this.saveCodes(instanceId, events);
    for (const event of events) {
      await this.publish(instanceId, { kind: 'event', event });
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}
