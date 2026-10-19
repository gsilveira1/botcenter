const DAY_MS = 86_400_000;

export interface WarmUpConfig {
  /** Days from the first connection to the full rate. `0` turns the warm-up off. */
  days: number;
  /** The rate on the first day, in percent of the full rate. */
  startPercent: number;
}

/**
 * The part of the full send rate that an instance gets (ban mitigation "aquecimento gradual de números
 * novos"). Day 0 is the day of the first connection. The rate grows linearly from `startPercent` on day 0
 * to 100 % on day `days - 1`. With the defaults (7 days, 20 %): 20 %, 33 %, 47 %, 60 %, 73 %, 87 %, 100 %.
 * An instance without `firstConnectedAt` gets the rate of day 0.
 */
export function warmUpFactor(
  firstConnectedAt: Date | null,
  now: Date,
  config: WarmUpConfig,
): number {
  if (config.days <= 1 || config.startPercent >= 100) {
    return 1;
  }
  const start = config.startPercent / 100;
  const elapsedMs = firstConnectedAt ? now.getTime() - firstConnectedAt.getTime() : 0;
  const day = Math.max(0, Math.floor(elapsedMs / DAY_MS));
  if (day >= config.days - 1) {
    return 1;
  }
  return start + ((1 - start) * day) / (config.days - 1);
}

export interface BucketLimits {
  /** Tokens for each minute (can be a fraction). */
  ratePerMinute: number;
  /** The bucket size: the sends that can go out at once after an idle time. */
  burst: number;
}

/** The token bucket limits of an instance on a given day. The rate is at least one send for each minute. */
export function bucketLimits(ratePerMinute: number, burst: number, factor: number): BucketLimits {
  const rate = Math.max(1, ratePerMinute * factor);
  return { ratePerMinute: rate, burst: Math.max(1, Math.min(burst, Math.floor(rate))) };
}
