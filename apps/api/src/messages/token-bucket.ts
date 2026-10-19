import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';
import type { BucketLimits } from './warm-up';

/**
 * Token bucket in one atomic Lua script. The hash holds `tokens` (a fraction), `ts` (milliseconds), and
 * `line` (the wake time of the last job in the line). The time is the Redis server time (`TIME`), so the
 * clocks of the worker hosts do not matter. A test can give the time in ARGV[4].
 *
 * Without a token, the wait is the time to the next token. With `spread` (bulk sends), each denied job
 * gets its own place in a line, one token interval after the job before it (ARCH-10): the jobs of a
 * backlog wake one at a time, not all at the next token.
 *
 * ARGV: 1 = tokens for each minute, 2 = bucket size, 3 = spread (`1` or `0`), 4 = time in ms (optional).
 * Returns {allowed (0 or 1), wait in ms}.
 */
export const TOKEN_BUCKET_SCRIPT = `
local rate = tonumber(ARGV[1]) / 60000
local burst = tonumber(ARGV[2])
local spread = ARGV[3] == '1'
local now = tonumber(ARGV[4])
if not now then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts', 'line')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
local line = tonumber(state[3]) or 0
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
  if spread then
    local slot = math.max(now + wait, line + math.ceil(1 / rate))
    line = slot
    wait = slot - now
    redis.call('HSET', KEYS[1], 'line', tostring(line))
  end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(math.max(ts, now)))
redis.call('PEXPIRE', KEYS[1], math.max(math.ceil(burst / rate), line - now) + 60000)
return {allowed, wait}
`;

/** Gives one token back (at most the bucket size). ARGV: 1 = bucket size. */
export const TOKEN_REFUND_SCRIPT = `
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
if tokens == nil then
  return 0
end
redis.call('HSET', KEYS[1], 'tokens', tostring(math.min(tonumber(ARGV[1]), tokens + 1)))
return 1
`;

export interface TokenResult {
  allowed: boolean;
  /** Milliseconds until the job can try again, when `allowed` is false. */
  waitMs: number;
}

export interface TakeOptions {
  /** A place in the line of the denied jobs (bulk sends). A reply waits only for the next token. */
  spread?: boolean;
  /** The time in ms (tests). Default: the Redis server time. */
  nowMs?: number;
}

/** The send rate limit of each instance (plan: "Rate limit por instância"). */
@Injectable()
export class InstanceTokenBucket {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async take(
    instanceId: string,
    limits: BucketLimits,
    options: TakeOptions = {},
  ): Promise<TokenResult> {
    const args = [String(limits.ratePerMinute), String(limits.burst), options.spread ? '1' : '0'];
    if (options.nowMs !== undefined) {
      args.push(String(options.nowMs));
    }
    const [allowed, waitMs] = (await this.redis.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      redisKeys.outboundBucket(instanceId),
      ...args,
    )) as [number, number];
    return { allowed: allowed === 1, waitMs };
  }

  /** Gives back a token that the job did not use (the message was not sent now). */
  async refund(instanceId: string, limits: BucketLimits): Promise<void> {
    await this.redis.eval(
      TOKEN_REFUND_SCRIPT,
      1,
      redisKeys.outboundBucket(instanceId),
      String(limits.burst),
    );
  }
}
