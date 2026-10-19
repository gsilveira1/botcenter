import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors/app-error';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { AlertService } from '../services/alert.service';
import { QuotaService } from './quota.service';

/** Response headers of the API key rate limit. */
export type RateLimitHeaders = Record<
  'RateLimit-Limit' | 'RateLimit-Remaining' | 'RateLimit-Reset',
  string
>;

export interface KeyRateLimitResult {
  headers: RateLimitHeaders | null;
}

/**
 * Rate limit for each API key: a fixed window of one minute in Redis. The limit is the
 * `rateLimitPerMinute` of the key, or the default of the tenant. A refused request gets 429
 * `RATE_LIMITED` with `Retry-After`. When Redis is down, the request continues without a limit (fail
 * open): the error is logged and an alert goes to the operators.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = getLogger('rate-limit');

  constructor(
    private readonly quotas: QuotaService,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertService,
  ) {}

  async consumeKey(keyId: string, limit: number, now = new Date()): Promise<KeyRateLimitResult> {
    let result;
    try {
      result = await this.quotas.consume({
        name: 'api-key',
        subject: keyId,
        window: 'minute',
        limit,
        now,
      });
    } catch (error) {
      this.logger.error(
        { err: error },
        'rate limit check failed; the request continues without a limit',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'API key rate limit is off (Redis error)',
        dedupeKey: 'rate-limit:redis',
      });
      return { headers: null };
    }
    const headers: RateLimitHeaders = {
      'RateLimit-Limit': String(result.limit),
      'RateLimit-Remaining': String(result.remaining),
      'RateLimit-Reset': String(result.retryAfterSeconds),
    };
    if (!result.allowed) {
      this.metrics.rateLimitDeniedTotal.inc({ scope: 'key' });
      throw new AppError('RATE_LIMITED', `Rate limit of ${limit} requests per minute exceeded`, {
        headers: { ...headers, 'Retry-After': String(result.retryAfterSeconds) },
      });
    }
    return { headers };
  }
}
