import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { closeRedis, createRedisConnection } from './redis';

/** DI token of the shared request-path Redis client (`ioredis`). */
export const REDIS = Symbol('REDIS');

/** Closes the shared client after the workers and the queues stopped (shutdown hook order). */
@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.redis);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: AppEnv) => createRedisConnection(env.REDIS_URL, 'client', env.ROLE),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
