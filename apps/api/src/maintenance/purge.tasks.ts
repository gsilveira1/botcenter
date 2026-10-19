import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { MaintenanceTaskName } from '../queues/queue-names';
import { BatchPurger } from './batch-purger';
import type { PurgeTable } from './batch-purger';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import type { MaintenanceTask } from './maintenance-task.registry';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Raw provider payloads: 7 days (architecture, "Dados e LGPD"). */
export const RAW_EVENTS_RETENTION_MS = 7 * DAY_MS;
/** Dispatched outbox events: the deliveries hold a copy of the body, so 1 day is enough for debugging. */
export const OUTBOX_RETENTION_MS = DAY_MS;
/** Webhook deliveries: 30 days, or less when the message retention of the tenant is shorter. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

export function before(now: Date, ms: number): Date {
  return new Date(now.getTime() - ms);
}

export interface TenantRetention {
  id: string;
  retentionDays: number;
}

/** Loads the retention of each tenant. One query for all the tenants of the platform. */
export async function tenantRetentions(prisma: PrismaService): Promise<TenantRetention[]> {
  return prisma.tenant.findMany({ select: { id: true, retentionDays: true } });
}

/**
 * The purge tasks of the `maintenance` queue (LGPD: short retention of personal data).
 *
 * Decision for `messages`: the purge deletes the rows, it does not clear the content. A row without
 * content still has the phone number of the contact (`contact`), which is personal data too. Nothing
 * references a message row, so the delete is safe.
 */
@Injectable()
export class PurgeTasks implements OnModuleInit {
  constructor(
    private readonly registry: MaintenanceTaskRegistry,
    private readonly purger: BatchPurger,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    for (const task of this.tasks()) {
      this.registry.register(task);
    }
  }

  tasks(): MaintenanceTask[] {
    return [
      this.global(
        'purge-raw-events',
        HOUR_MS,
        'raw_events',
        (now) => Prisma.sql`"receivedAt" < ${before(now, RAW_EVENTS_RETENTION_MS)}`,
      ),
      this.global(
        'purge-idempotency-keys',
        15 * MINUTE_MS,
        'idempotency_keys',
        (now) => Prisma.sql`"expiresAt" < ${now}`,
      ),
      this.global(
        'purge-connect-tokens',
        15 * MINUTE_MS,
        'connect_tokens',
        (now) => Prisma.sql`"expiresAt" < ${now}`,
      ),
      this.global(
        'purge-outbox-events',
        HOUR_MS,
        'outbox_events',
        (now) => Prisma.sql`"dispatchedAt" < ${before(now, OUTBOX_RETENTION_MS)}`,
      ),
      this.perTenant('purge-messages', 'messages', (tenant) => tenant.retentionDays),
      this.perTenant('purge-webhook-deliveries', 'webhook_deliveries', (tenant) =>
        Math.min(WEBHOOK_DELIVERY_RETENTION_DAYS, tenant.retentionDays),
      ),
      // The bot calls hold the conversation context (personal data): the same rule as the deliveries.
      this.perTenant('purge-bot-webhook-calls', 'bot_webhook_calls', (tenant) =>
        Math.min(WEBHOOK_DELIVERY_RETENTION_DAYS, tenant.retentionDays),
      ),
    ];
  }

  private global(
    name: MaintenanceTaskName,
    everyMs: number,
    table: PurgeTable,
    condition: (now: Date) => Prisma.Sql,
  ): MaintenanceTask {
    return {
      name,
      everyMs,
      run: async (now) => ({ deleted: await this.purger.deleteWhere(name, table, condition(now)) }),
    };
  }

  /** Deletes the rows older than the retention of each tenant (`createdAt`, index `(tenantId, createdAt)`). */
  private perTenant(
    name: MaintenanceTaskName,
    table: PurgeTable,
    retentionDays: (tenant: TenantRetention) => number,
  ): MaintenanceTask {
    return {
      name,
      everyMs: HOUR_MS,
      run: async (now) => {
        let deleted = 0;
        for (const tenant of await tenantRetentions(this.prisma)) {
          const cutoff = before(now, retentionDays(tenant) * DAY_MS);
          deleted += await this.purger.deleteWhere(
            name,
            table,
            Prisma.sql`"tenantId" = ${tenant.id}::uuid AND "createdAt" < ${cutoff}`,
          );
        }
        return { deleted };
      },
    };
  }
}
