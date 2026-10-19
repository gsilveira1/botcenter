import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';
import { redisKeys } from '../redis/redis-keys';
import { closeRedis, createRedisConnection } from '../redis/redis';
import { ChannelMessage } from './connect-events';

export type ChannelListener = (message: ChannelMessage) => void;

/**
 * The Redis subscriber of the API process: one connection for all the open connect streams. The bus
 * subscribes to the channel of an instance while at least one stream of the instance is open, and
 * sends each message to the listeners of that instance. ioredis subscribes again after a reconnect.
 */
@Injectable()
export class ConnectEventsBus implements OnApplicationShutdown {
  private readonly logger = getLogger('connect-events-bus');
  private readonly listeners = new Map<string, Set<ChannelListener>>();
  private subscriber: Redis | undefined;

  constructor(@Inject(ENV) private readonly env: AppEnv) {}

  /** Adds a listener for the instance. Returns the function that removes it. */
  async subscribe(instanceId: string, listener: ChannelListener): Promise<() => Promise<void>> {
    const channel = redisKeys.connectChannel(instanceId);
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    if (set.size === 1) {
      try {
        await this.connection().subscribe(channel);
      } catch (error) {
        this.remove(channel, listener);
        throw error;
      }
    }
    return async () => {
      if (this.remove(channel, listener)) {
        await this.unsubscribe(channel);
      }
    };
  }

  /** The number of channels with listeners (for the tests). */
  get channelCount(): number {
    return this.listeners.size;
  }

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    if (this.subscriber) {
      await closeRedis(this.subscriber);
      this.subscriber = undefined;
    }
  }

  private connection(): Redis {
    if (!this.subscriber) {
      const subscriber = createRedisConnection(this.env.REDIS_URL, 'client', 'api-connect-events');
      subscriber.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
      this.subscriber = subscriber;
    }
    return this.subscriber;
  }

  /** Removes a listener. Returns true when the channel has no more listeners. */
  private remove(channel: string, listener: ChannelListener): boolean {
    const set = this.listeners.get(channel);
    if (!set) {
      return false;
    }
    set.delete(listener);
    if (set.size > 0) {
      return false;
    }
    this.listeners.delete(channel);
    return true;
  }

  private async unsubscribe(channel: string): Promise<void> {
    try {
      await this.subscriber?.unsubscribe(channel);
    } catch (error) {
      // The subscription stays until the next reconnect; the bus drops the messages of the channel.
      this.logger.warn({ err: error }, 'redis unsubscribe failed');
    }
  }

  private dispatch(channel: string, raw: string): void {
    const set = this.listeners.get(channel);
    if (!set) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
    const message = ChannelMessage.safeParse(parsed);
    if (!message.success) {
      this.logger.warn({ channel }, 'connect channel message is not valid; dropped');
      return;
    }
    for (const listener of [...set]) {
      listener(message.data);
    }
  }
}
