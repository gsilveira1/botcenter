import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';

export type QuotaWindow = 'minute' | 'day';

export interface QuotaRequest {
  /** Name of the counter, for example `api-key` or `messages-per-day`. */
  name: string;
  /** Owner of the counter, for example the key id or the tenant id. */
  subject: string;
  window: QuotaWindow;
  limit: number;
  /** Default: 1. */
  amount?: number;
  now?: Date;
}

export interface QuotaResult {
  allowed: boolean;
  /** The count after this call (a refused call does not count). */
  used: number;
  limit: number;
  remaining: number;
  /** Start of the next window. */
  resetAt: Date;
  /** Whole seconds until the next window (at least 1). */
  retryAfterSeconds: number;
}

const WINDOW_MS: Record<QuotaWindow, number> = { minute: 60_000, day: 86_400_000 };

/**
 * Adds `amount` and refuses when the result is above the limit. A refused call removes its amount
 * again, so the counter never stays above the limit. Returns `{allowed, used}`.
 */
const CONSUME = `
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local current = redis.call('INCRBY', KEYS[1], amount)
if current == amount then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
if current > limit then
  current = redis.call('DECRBY', KEYS[1], amount)
  return {0, current}
end
return {1, current}
`;

function windowOf(window: QuotaWindow, now: Date): { id: string; resetAt: Date } {
  const size = WINDOW_MS[window];
  const index = Math.floor(now.getTime() / size);
  const resetAt = new Date((index + 1) * size);
  const id = window === 'day' ? now.toISOString().slice(0, 10) : String(index);
  return { id, resetAt };
}

/**
 * Fixed-window counters in Redis (UTC windows). The API key rate limit uses the `minute` window.
 * The messages slice uses the `day` window for the daily message quota of a tenant:
 *
 *   const quota = await quotas.consume({ name: 'messages-per-day', subject: tenant.id, window: 'day', limit: tenant.maxMessagesPerDay });
 *   if (!quota.allowed) throw new AppError('QUOTA_EXCEEDED', '...', { headers: { 'Retry-After': String(quota.retryAfterSeconds) } });
 *
 * A Redis error goes to the caller: the caller decides to fail open or closed.
 */
@Injectable()
export class QuotaService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async consume(request: QuotaRequest): Promise<QuotaResult> {
    const now = request.now ?? new Date();
    const amount = request.amount ?? 1;
    const { id, resetAt } = windowOf(request.window, now);
    const key = redisKeys.quota(request.name, request.subject, id);
    // Keep the key a little after the end of the window, then Redis deletes it.
    const ttlMs = resetAt.getTime() - now.getTime() + 60_000;
    const [allowed, used] = (await this.redis.eval(
      CONSUME,
      1,
      key,
      String(amount),
      String(request.limit),
      String(ttlMs),
    )) as [number, number];
    return this.result(allowed === 1, used, request.limit, resetAt, now);
  }

  /** Gives back an amount, for example when the action failed after the quota check. */
  async refund(request: Omit<QuotaRequest, 'limit'>): Promise<void> {
    const now = request.now ?? new Date();
    const { id } = windowOf(request.window, now);
    const key = redisKeys.quota(request.name, request.subject, id);
    const value = await this.redis.decrby(key, request.amount ?? 1);
    if (value < 0) {
      await this.redis.set(key, '0', 'KEEPTTL');
    }
  }

  async peek(request: Omit<QuotaRequest, 'amount'>): Promise<QuotaResult> {
    const now = request.now ?? new Date();
    const { id, resetAt } = windowOf(request.window, now);
    const raw = await this.redis.get(redisKeys.quota(request.name, request.subject, id));
    const used = raw ? Number(raw) : 0;
    return this.result(used < request.limit, used, request.limit, resetAt, now);
  }

  private result(
    allowed: boolean,
    used: number,
    limit: number,
    resetAt: Date,
    now: Date,
  ): QuotaResult {
    return {
      allowed,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
    };
  }
}
