import { Injectable } from '@nestjs/common';
import type { Counter } from 'prom-client';
import { Prisma } from '../generated/prisma/client';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import type { MaintenanceTaskName } from '../queues/queue-names';

/** Rows deleted by one statement. A small batch keeps each lock short. */
export const PURGE_BATCH_SIZE = 1_000;
/** Batches in one run. The next run continues, so one run never holds the worker for long. */
export const PURGE_MAX_BATCHES = 200;

/** The tables that the purge tasks clean. The names are constants, never input. */
export type PurgeTable =
  | 'raw_events'
  | 'idempotency_keys'
  | 'connect_tokens'
  | 'outbox_events'
  | 'messages'
  | 'webhook_deliveries'
  | 'media_objects';

/**
 * Deletes old rows in small batches: `DELETE ... WHERE id IN (SELECT id ... LIMIT n FOR UPDATE SKIP
 * LOCKED)`. Each statement is its own short transaction, and two runs at the same time take different
 * rows (no wait, no double count). Counts the rows in `botcenter_maintenance_purged_rows_total{task}`.
 */
@Injectable()
export class BatchPurger {
  private readonly purged: Counter<'task'>;

  constructor(
    private readonly prisma: PrismaService,
    metrics: MetricsService,
  ) {
    this.purged = metrics.counter({
      name: 'botcenter_maintenance_purged_rows_total',
      help: 'Rows deleted by the maintenance purge tasks',
      labelNames: ['task'],
    });
  }

  async deleteWhere(
    task: MaintenanceTaskName,
    table: PurgeTable,
    condition: Prisma.Sql,
  ): Promise<number> {
    const target = Prisma.raw(`"${table}"`);
    let total = 0;
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM ${target}
        WHERE "id" IN (
          SELECT "id" FROM ${target} WHERE ${condition} LIMIT ${PURGE_BATCH_SIZE} FOR UPDATE SKIP LOCKED
        )`;
      total += deleted;
      if (deleted < PURGE_BATCH_SIZE) {
        break;
      }
    }
    this.purged.inc({ task }, total);
    return total;
  }

  /** Counts rows that another path deleted (for example, the media purge after the S3 delete). */
  count(task: MaintenanceTaskName, rows: number): void {
    this.purged.inc({ task }, rows);
  }
}
