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

/** Failed authentications of one client address in one minute (SEC-10). */
export const AUTH_FAILURE_LIMIT_PER_MINUTE = 30;
/** Requests of one client address to the connect token routes in one minute (SEC-10). */
export const CONNECT_REQUEST_LIMIT_PER_MINUTE = 30;

export interface KeyRateLimitResult {
  headers: RateLimitHeaders | null;
}

/**
 * Rate limit for each API key: a fixed window of one minute in Redis. It also has the limits for each
 * client address (SEC-10): failed authentications, and the connect token routes. The limit is the
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

  /**
   * SEC-10: refuses a client address with too many failed authentications in this minute (429), before
   * the key lookup, so a scan with random keys does not reach PostgreSQL. Fail open on a Redis error.
   */
  async assertAuthFailuresBelowLimit(clientIp: string, now = new Date()): Promise<void> {
    const result = await this.failOpen('auth-failures', () =>
      this.quotas.peek({
        name: 'auth-failures',
        subject: clientIp,
        window: 'minute',
        limit: AUTH_FAILURE_LIMIT_PER_MINUTE,
        now,
      }),
    );
    if (result && !result.allowed) {
      this.refuse('ip_auth_failures', result.retryAfterSeconds, 'Too many failed authentications');
    }
  }

  /** Counts one failed authentication of the client address. A Redis error is logged only. */
  async recordAuthFailure(clientIp: string, now = new Date()): Promise<void> {
    await this.failOpen('auth-failures', () =>
      this.quotas.consume({
        name: 'auth-failures',
        subject: clientIp,
        window: 'minute',
        // Count every failure; the check above compares the count with the limit.
        limit: Number.MAX_SAFE_INTEGER,
        now,
      }),
    );
  }

  /** SEC-10: a limit for each client address on the connect token routes (the SSE stream). */
  async consumeConnect(clientIp: string, now = new Date()): Promise<void> {
    const result = await this.failOpen('connect', () =>
      this.quotas.consume({
        name: 'connect-ip',
        subject: clientIp,
        window: 'minute',
        limit: CONNECT_REQUEST_LIMIT_PER_MINUTE,
        now,
      }),
    );
    if (result && !result.allowed) {
      this.refuse('ip_connect', result.retryAfterSeconds, 'Too many connect requests');
    }
  }

  /** Runs a Redis counter call. A Redis error gives `null` (no limit), a log line, and an alert. */
  private async failOpen<T>(counter: string, call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch (error) {
      this.logger.error(
        { err: error, counter },
        'client address limit check failed; the request continues without a limit',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Client address rate limit is off (Redis error)',
        dedupeKey: 'rate-limit:ip:redis',
      });
      return null;
    }
  }

  private refuse(scope: string, retryAfterSeconds: number, detail: string): never {
    this.metrics.rateLimitDeniedTotal.inc({ scope });
    throw new AppError('RATE_LIMITED', `${detail} from this address. Try again later.`, {
      headers: { 'Retry-After': String(retryAfterSeconds) },
    });
  }
}
