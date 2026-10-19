import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';
import type { BucketLimits } from './warm-up';

/**
 * Token bucket in one atomic Lua script. The hash holds `tokens` (a fraction) and `ts` (milliseconds).
 * The time is the Redis server time (`TIME`), so the clocks of the worker hosts do not matter. A test can
 * give the time in ARGV[3].
 *
 * ARGV: 1 = tokens for each minute, 2 = bucket size, 3 = time in ms (optional).
 * Returns {allowed (0 or 1), wait in ms until one token is available}.
 */
export const TOKEN_BUCKET_SCRIPT = `
local rate = tonumber(ARGV[1]) / 60000
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if not now then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
local elapsed = math.max(0, now - ts)
tokens = math.min(burst, tokens + elapsed * rate)
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(math.max(ts, now)))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate) + 60000)
return {allowed, wait}
`;

export interface TokenResult {
  allowed: boolean;
  /** Milliseconds until the next token, when `allowed` is false. */
  waitMs: number;
}

/** The send rate limit of each instance (plan: "Rate limit por instância"). */
@Injectable()
export class InstanceTokenBucket {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async take(instanceId: string, limits: BucketLimits, nowMs?: number): Promise<TokenResult> {
    const args = [String(limits.ratePerMinute), String(limits.burst)];
    if (nowMs !== undefined) {
      args.push(String(nowMs));
    }
    const [allowed, waitMs] = (await this.redis.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      redisKeys.outboundBucket(instanceId),
      ...args,
    )) as [number, number];
    return { allowed: allowed === 1, waitMs };
  }
}
