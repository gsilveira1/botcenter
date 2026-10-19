import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AlertService } from '../services/alert.service';
import { fanOut } from './fan-out';
import type { OutboxRow } from './fan-out';
import { WebhookDeliveryJobs } from './webhook-delivery.jobs';
import type { DeliveryJobRef } from './webhook-delivery.jobs';

/** Events read in one transaction. */
export const OUTBOX_BATCH_SIZE = 100;
/** Pause after an error (PostgreSQL down), so the loop does not spin. */
const ERROR_PAUSE_MS = 5_000;

/**
 * The outbox dispatcher of the worker process. A loop reads the events that are not dispatched, in
 * creation order, with `FOR UPDATE SKIP LOCKED`, writes one `webhook_deliveries` row for each matching
 * active subscription of the tenant, and marks the events dispatched in the same transaction. After the
 * commit, it adds the `webhooks` jobs.
 *
 * Decision: a loop with `SKIP LOCKED`, not a `maintenance` job. Two dispatchers (two worker processes)
 * never take the same event, a slow purge job cannot delay the events, and the latency is about one
 * interval (`OUTBOX_DISPATCH_INTERVAL_MS`, default 1 s). The order is the creation order inside one
 * dispatcher; delivery retries can change the order, so receivers must not depend on it.
 */
@Injectable()
export class OutboxDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = getLogger('outbox');
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: WebhookDeliveryJobs,
    private readonly alerts: AlertService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    this.logger.info(
      { interval_ms: this.env.OUTBOX_DISPATCH_INTERVAL_MS },
      'outbox dispatcher started',
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info('outbox dispatcher stopped');
  }

  /**
   * Dispatches one batch. Returns the number of events that the batch dispatched. The jobs of a batch
   * are added after the commit; a failed add leaves the deliveries for the sweep.
   */
  async dispatchBatch(now = new Date()): Promise<number> {
    const { events, deliveries } = await this.prisma.$transaction((tx) =>
      this.fanOutBatch(tx, now),
    );
    await this.jobs.enqueue(deliveries, now.getTime());
    if (events > 0) {
      this.logger.debug({ events, deliveries: deliveries.length }, 'outbox batch dispatched');
    }
    return events;
  }

  /** Reads one batch, writes the deliveries, and marks the events dispatched, in one transaction. */
  private async fanOutBatch(
    tx: TransactionClient,
    now: Date,
  ): Promise<{ events: number; deliveries: DeliveryJobRef[] }> {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT "id", "tenantId", "type", "payload", "createdAt"
      FROM "outbox_events"
      WHERE "dispatchedAt" IS NULL
      ORDER BY "createdAt", "id"
      LIMIT ${OUTBOX_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) {
      return { events: 0, deliveries: [] };
    }
    const subscriptions = await tx.webhookSubscription.findMany({
      where: {
        tenantId: { in: [...new Set(rows.map((row) => row.tenantId))] },
        active: true,
        deletedAt: null,
      },
      select: { id: true, tenantId: true, events: true },
    });
    const data = fanOut(rows, subscriptions, now);
    const deliveries = data.length
      ? await tx.webhookDelivery.createManyAndReturn({
          data,
          skipDuplicates: true,
          select: { id: true, tenantId: true, nextAttemptAt: true },
        })
      : [];
    await tx.outboxEvent.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { dispatchedAt: now },
    });
    return { events: rows.length, deliveries };
  }

  private async run(): Promise<void> {
    while (this.running) {
      const dispatched = await this.dispatchSafely();
      if (dispatched < OUTBOX_BATCH_SIZE) {
        await this.pause(dispatched < 0 ? ERROR_PAUSE_MS : this.env.OUTBOX_DISPATCH_INTERVAL_MS);
      }
    }
  }

  /**
   * The loop must not stop: every error is logged with its detail, alerted, and the loop waits and tries
   * again. The events stay in the outbox, so no event is lost. Returns -1 after an error.
   */
  private async dispatchSafely(): Promise<number> {
    try {
      return await this.dispatchBatch();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
      this.logger.error({ err: error, prisma_code: known }, 'outbox dispatch failed; retry later');
      await this.alerts.notify({
        severity: 'critical',
        title: 'Outbox dispatch failed',
        details: { error: (error as Error).name, prisma_code: known },
        dedupeKey: 'outbox:dispatch',
      });
      return -1;
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
