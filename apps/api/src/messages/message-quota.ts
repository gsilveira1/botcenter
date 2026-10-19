import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors/app-error';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { QuotaService } from '../rate-limit/quota.service';
import { AlertService } from '../services/alert.service';
import { TenantsService } from '../services/tenants.service';

export const MESSAGES_PER_DAY_QUOTA = 'messages-per-day';

/** Gives back the consumed message when the action fails after the quota check. Never throws. */
export type QuotaRefund = () => Promise<void>;

/**
 * The daily message quota of a tenant (`tenants.maxMessagesPerDay`). The window is the UTC day, so a
 * refused request gets `Retry-After` until the next UTC midnight. When Redis fails, the message goes
 * through without a count (fail open): the error is logged and an alert goes to the operators.
 */
@Injectable()
export class MessageQuota {
  private readonly logger = getLogger('message-quota');

  constructor(
    private readonly quotas: QuotaService,
    private readonly tenants: TenantsService,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertService,
  ) {}

  /** Consumes one message. Throws 429 `QUOTA_EXCEEDED` with `Retry-After` when the quota is used. */
  async consume(tenantId: string, now = new Date()): Promise<QuotaRefund> {
    const tenant = await this.tenants.get(tenantId);
    let result;
    try {
      result = await this.quotas.consume({
        name: MESSAGES_PER_DAY_QUOTA,
        subject: tenantId,
        window: 'day',
        limit: tenant.maxMessagesPerDay,
        now,
      });
    } catch (error) {
      this.logger.error({ err: error }, 'daily message quota check failed; the message continues');
      void this.alerts.notify({
        severity: 'warning',
        title: 'Daily message quota is off (Redis error)',
        dedupeKey: 'message-quota:redis',
      });
      return async () => {};
    }
    if (!result.allowed) {
      this.metrics.rateLimitDeniedTotal.inc({ scope: 'tenant_day' });
      throw new AppError(
        'QUOTA_EXCEEDED',
        `The daily quota of ${result.limit} messages is used. It resets at 00:00 UTC.`,
        { headers: { 'Retry-After': String(result.retryAfterSeconds) } },
      );
    }
    return () => this.refund(tenantId, now);
  }

  private async refund(tenantId: string, now: Date): Promise<void> {
    try {
      await this.quotas.refund({
        name: MESSAGES_PER_DAY_QUOTA,
        subject: tenantId,
        window: 'day',
        now,
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'daily message quota refund failed');
    }
  }
}
