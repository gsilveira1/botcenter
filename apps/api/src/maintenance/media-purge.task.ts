import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { MediaStorage } from '../media/media.storage';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AlertService } from '../services/alert.service';
import { BatchPurger } from './batch-purger';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import type { MaintenanceTask, MaintenanceTaskResult } from './maintenance-task.registry';
import { DAY_MS, HOUR_MS, before, tenantRetentions } from './purge.tasks';

/** S3 `DeleteObjects` accepts at most 1000 keys. */
export const MEDIA_PURGE_BATCH_SIZE = 500;
const MEDIA_PURGE_MAX_BATCHES = 100;

/**
 * `purge-media-objects`: deletes the media of each tenant after its retention (`expiresAt` passed, or
 * `createdAt` older than the current `retentionDays`, whichever comes first), first in the object storage
 * (`MediaStorage` of the messages slice), then the rows. A key that the storage does not delete
 * keeps its row, so the next run tries again; the run then sends an alert. Two runs at the same time
 * can send the same keys to the storage, which is safe (a delete is idempotent).
 */
@Injectable()
export class MediaPurgeTask implements MaintenanceTask, OnModuleInit {
  readonly name = 'purge-media-objects' as const;
  readonly everyMs = HOUR_MS;
  private readonly logger = getLogger('maintenance');

  constructor(
    private readonly registry: MaintenanceTaskRegistry,
    private readonly prisma: PrismaService,
    private readonly purger: BatchPurger,
    private readonly alerts: AlertService,
    private readonly storage: MediaStorage,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(now: Date): Promise<MaintenanceTaskResult> {
    let deleted = 0;
    let failed = 0;
    for (const tenant of await tenantRetentions(this.prisma)) {
      const cutoff = before(now, tenant.retentionDays * DAY_MS);
      for (let batch = 0; batch < MEDIA_PURGE_MAX_BATCHES; batch += 1) {
        const result = await this.purgeBatch(tenant.id, now, cutoff);
        deleted += result.deleted;
        failed += result.failed;
        if (result.done) {
          break;
        }
      }
    }
    if (failed > 0) {
      await this.alerts.notify({
        severity: 'warning',
        title: 'Media objects not deleted from the object storage',
        details: { failed, deleted },
        dedupeKey: 'maintenance:media-purge',
      });
    }
    this.purger.count(this.name, deleted);
    return { deleted, failed };
  }

  private async purgeBatch(
    tenantId: string,
    now: Date,
    cutoff: Date,
  ): Promise<{ deleted: number; failed: number; done: boolean }> {
    const db = this.prisma.forTenant(tenantId);
    const rows = await db.mediaObject.findMany({
      where: { OR: [{ expiresAt: { lt: now } }, { createdAt: { lt: cutoff } }] },
      select: { id: true, key: true },
      orderBy: { createdAt: 'asc' },
      take: MEDIA_PURGE_BATCH_SIZE,
    });
    if (rows.length === 0) {
      return { deleted: 0, failed: 0, done: true };
    }
    const { failedKeys } = await this.storage.deleteObjects(rows.map((row) => row.key));
    const failedSet = new Set(failedKeys);
    const removed = await db.mediaObject.deleteMany({
      where: { id: { in: rows.filter((row) => !failedSet.has(row.key)).map((row) => row.id) } },
    });
    if (failedKeys.length > 0) {
      this.logger.error(
        { tenant_id: tenantId, failed: failedKeys.length },
        'object storage refused some deletes; the rows stay for the next run',
      );
    }
    // Stop after a failure, so the same failed keys do not repeat in this run.
    const done = rows.length < MEDIA_PURGE_BATCH_SIZE || failedKeys.length > 0;
    return { deleted: removed.count, failed: failedKeys.length, done };
  }
}
