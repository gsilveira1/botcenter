import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';

export interface Lock {
  readonly name: string;
  readonly token: string;
}

export interface WithLockOptions {
  /** Lock time. The lock ends after this time even if the holder stops. */
  ttlMs: number;
  /** Maximum time to wait for the lock. Default: 0 (one attempt). */
  waitMs?: number;
  /** Time between two attempts. Default: 50 ms. */
  retryDelayMs?: number;
}

/** The lock is held by another process. The caller can retry the job later. */
export class LockNotAcquiredError extends Error {
  constructor(readonly lockName: string) {
    super(`Lock not acquired: ${lockName}`);
    this.name = 'LockNotAcquiredError';
  }
}

/** Deletes the key only when it still holds the token of the caller. */
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
/** Extends the key only when it still holds the token of the caller. */
const EXTEND = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

/**
 * A Redis lock for one Redis node (`SET NX PX` with a random token, safe release with Lua).
 * Use it for short critical sections, for example the lock for each conversation. The lock is not a
 * fencing token: keep the optimistic `version` check in the database as the final guard.
 */
@Injectable()
export class DistributedLockService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async acquire(name: string, ttlMs: number): Promise<Lock | null> {
    const token = randomUUID();
    const result = await this.redis.set(redisKeys.lock(name), token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { name, token } : null;
  }

  /** Returns false when the lock expired or another holder has it. */
  async release(lock: Lock): Promise<boolean> {
    const result = await this.redis.eval(RELEASE, 1, redisKeys.lock(lock.name), lock.token);
    return result === 1;
  }

  async extend(lock: Lock, ttlMs: number): Promise<boolean> {
    const result = await this.redis.eval(
      EXTEND,
      1,
      redisKeys.lock(lock.name),
      lock.token,
      String(ttlMs),
    );
    return result === 1;
  }

  /** Runs `fn` with the lock. Throws `LockNotAcquiredError` when the wait time ends first. */
  async withLock<T>(
    name: string,
    options: WithLockOptions,
    fn: (lock: Lock) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + (options.waitMs ?? 0);
    let lock = await this.acquire(name, options.ttlMs);
    while (!lock && Date.now() < deadline) {
      await sleep(options.retryDelayMs ?? 50);
      lock = await this.acquire(name, options.ttlMs);
    }
    if (!lock) {
      throw new LockNotAcquiredError(name);
    }
    try {
      return await fn(lock);
    } finally {
      await this.release(lock);
    }
  }
}
