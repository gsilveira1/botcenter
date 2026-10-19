import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { OUTBOUND_SWEEP_JOB } from '../messages/outbound-job';
import { PrismaService } from '../prisma/prisma.service';
import { oldestWaitingDelaySeconds } from '../queues/queue-metrics.collector';
import { QueuesService } from '../queues/queues.service';
import { outboxLagSeconds } from '../webhooks/outbox-lag';
import { WEBHOOK_DELETED_ERROR } from '../webhooks/webhook-delivery.policy';
import { IncidentService } from './incident.service';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import type { MaintenanceTask, MaintenanceTaskResult } from './maintenance-task.registry';
import { MINUTE_MS, before } from './purge.tasks';

/** Architecture, "Observabilidade": the `outbound` queue waits more than 30 s. */
export const OUTBOUND_DELAY_LIMIT_SECONDS = 30;
/** Architecture, "Observabilidade": more than 5 % of the sends fail in 10 min. */
export const SEND_FAILURE_RATE_LIMIT = 0.05;
export const SEND_FAILURE_WINDOW_MS = 10 * MINUTE_MS;
/** Fewer finished sends than this in the window give no rate (one failure of three is not an incident). */
export const SEND_FAILURE_MIN_SAMPLE = 20;
/** The outbox dispatcher is late (the worker or PostgreSQL has a problem). */
export const OUTBOX_LAG_LIMIT_SECONDS = 60;
/**
 * Webhook failures of a tenant in the window: an incident when a delivery became dead, or when at least
 * `WEBHOOK_MIN_SAMPLE` deliveries had an attempt and half of them or more are failing.
 */
export const WEBHOOK_FAILURE_WINDOW_MS = 15 * MINUTE_MS;
export const WEBHOOK_MIN_SAMPLE = 10;
export const WEBHOOK_FAILURE_SHARE_LIMIT = 0.5;

export interface SendCounts {
  failed: number;
  finished: number;
}

export interface WebhookTenantCounts {
  tenantId: string;
  dead: number;
  failing: number;
  attempted: number;
}

export function sendFailureRateExceeded({ failed, finished }: SendCounts): boolean {
  return finished >= SEND_FAILURE_MIN_SAMPLE && failed / finished > SEND_FAILURE_RATE_LIMIT;
}

export function webhookTenantFailing(counts: WebhookTenantCounts): boolean {
  return (
    counts.dead > 0 ||
    (counts.attempted >= WEBHOOK_MIN_SAMPLE &&
      counts.failing / counts.attempted >= WEBHOOK_FAILURE_SHARE_LIMIT)
  );
}

const WEBHOOK_INCIDENT_PREFIX = 'webhook-failures:';

/**
 * The send counts of the window. ARCH-14: the index `(direction, createdAt)` of `messages` serves the
 * filter, so the query does not read the full table (90 days of rows) every minute.
 */
export function sendCountsQuery(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*) FILTER (WHERE "status" = 'failed')::int AS "failed",
           count(*) FILTER (WHERE "status" <> 'queued')::int AS "finished"
    FROM "messages"
    WHERE "direction" = 'outbound' AND "createdAt" >= ${since}`;
}

/** The webhook counts of each tenant in the window. ARCH-14: the index `(updatedAt)` serves the filter. */
export function webhookCountsQuery(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT "tenantId"::text AS "tenantId",
           count(*) FILTER (WHERE "status" = 'dead')::int AS "dead",
           count(*) FILTER (WHERE "status" IN ('failed', 'dead'))::int AS "failing",
           count(*) FILTER (WHERE "attempts" > 0)::int AS "attempted"
    FROM "webhook_deliveries"
    WHERE "updatedAt" >= ${since}
      AND "lastError" IS DISTINCT FROM ${WEBHOOK_DELETED_ERROR}
    GROUP BY "tenantId"`;
}

type Outcome = 'opened' | 'resolved' | 'unchanged';

/**
 * `check-alerts`, every minute: the operational alerts that need queue or table data. Each condition is
 * one incident: one alert when it starts and one recovery message when it ends (`IncidentService`).
 * The instance-disconnected alert belongs to the instances slice.
 */
@Injectable()
export class OperationalAlertsTask implements MaintenanceTask, OnModuleInit {
  readonly name = 'check-alerts' as const;
  readonly everyMs = MINUTE_MS;

  constructor(
    private readonly registry: MaintenanceTaskRegistry,
    private readonly incidents: IncidentService,
    private readonly queues: QueuesService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(now: Date): Promise<MaintenanceTaskResult> {
    const outcomes = [
      await this.checkOutboundDelay(now),
      await this.checkSendFailureRate(now),
      await this.checkOutboxLag(now),
      ...(await this.checkWebhookFailures(now)),
    ];
    return {
      opened: outcomes.filter((outcome) => outcome === 'opened').length,
      resolved: outcomes.filter((outcome) => outcome === 'resolved').length,
    };
  }

  async checkOutboundDelay(now: Date): Promise<Outcome> {
    // The sweep job of the messages slice is housekeeping, not a send: it does not count.
    const delay = await oldestWaitingDelaySeconds(this.queues.get('outbound'), now.getTime(), [
      OUTBOUND_SWEEP_JOB,
    ]);
    const details = {
      delay_seconds: Math.round(delay),
      limit_seconds: OUTBOUND_DELAY_LIMIT_SECONDS,
    };
    return this.incidents.update(
      'outbound-delay',
      delay > OUTBOUND_DELAY_LIMIT_SECONDS,
      { severity: 'critical', title: 'Outbound queue delay above 30 s', details },
      { severity: 'info', title: 'Resolved: outbound queue delay is normal', details },
      now,
    );
  }

  async checkSendFailureRate(now: Date): Promise<Outcome> {
    const [counts = { failed: 0, finished: 0 }] = await this.prisma.$queryRaw<SendCounts[]>(
      sendCountsQuery(before(now, SEND_FAILURE_WINDOW_MS)),
    );
    const rate = counts.finished > 0 ? counts.failed / counts.finished : 0;
    const details = { ...counts, rate_percent: Math.round(rate * 1000) / 10, window_minutes: 10 };
    return this.incidents.update(
      'send-failure-rate',
      sendFailureRateExceeded(counts),
      { severity: 'critical', title: 'Send failure rate above 5 % in 10 min', details },
      { severity: 'info', title: 'Resolved: send failure rate is normal', details },
      now,
    );
  }

  async checkOutboxLag(now: Date): Promise<Outcome> {
    const lag = await outboxLagSeconds(this.prisma, now.getTime());
    const details = { lag_seconds: Math.round(lag), limit_seconds: OUTBOX_LAG_LIMIT_SECONDS };
    return this.incidents.update(
      'outbox-lag',
      lag > OUTBOX_LAG_LIMIT_SECONDS,
      { severity: 'critical', title: 'Outbox events are not dispatched', details },
      { severity: 'info', title: 'Resolved: the outbox dispatcher is current', details },
      now,
    );
  }

  /** One incident for each tenant. A tenant without failures in the window closes its open incident. */
  async checkWebhookFailures(now: Date): Promise<Outcome[]> {
    const rows = await this.prisma.$queryRaw<WebhookTenantCounts[]>(
      webhookCountsQuery(before(now, WEBHOOK_FAILURE_WINDOW_MS)),
    );
    const failing = new Map(
      rows.filter(webhookTenantFailing).map((row) => [WEBHOOK_INCIDENT_PREFIX + row.tenantId, row]),
    );
    const open = await this.incidents.openKeys(WEBHOOK_INCIDENT_PREFIX);
    const keys = [...new Set([...failing.keys(), ...open])];
    return Promise.all(
      keys.map((key) => {
        const counts = failing.get(key);
        const details = {
          tenant_id: key.slice(WEBHOOK_INCIDENT_PREFIX.length),
          dead: counts?.dead,
          failing: counts?.failing,
          attempted: counts?.attempted,
        };
        return this.incidents.update(
          key,
          counts !== undefined,
          { severity: 'warning', title: 'Webhook deliveries of a tenant are failing', details },
          { severity: 'info', title: 'Resolved: webhook deliveries of a tenant succeed', details },
          now,
        );
      }),
    );
  }
}
