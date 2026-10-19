import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Gauge } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The age in seconds of the oldest event that is not dispatched (0 when the outbox is empty).
 * The query uses the partial index `outbox_events_pending_idx`.
 */
export async function outboxLagSeconds(prisma: PrismaService, now = Date.now()): Promise<number> {
  const oldest = await prisma.outboxEvent.aggregate({
    where: { dispatchedAt: null },
    _min: { createdAt: true },
  });
  const createdAt = oldest._min.createdAt;
  return createdAt ? Math.max(0, (now - createdAt.getTime()) / 1000) : 0;
}

/**
 * Sets `botcenter_outbox_lag_seconds` at each scrape. Only the API process registers it (shared state,
 * plan section 8), so the value is not counted two times.
 */
@Injectable()
export class OutboxLagCollector implements OnModuleInit {
  private readonly lag: Gauge;

  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
  ) {
    this.lag = metrics.gauge({
      name: 'botcenter_outbox_lag_seconds',
      help: 'Age of the oldest outbox event that is not dispatched',
    });
  }

  onModuleInit(): void {
    this.metrics.addCollector(() => this.collect());
  }

  async collect(now = Date.now()): Promise<void> {
    this.lag.set(await outboxLagSeconds(this.prisma, now));
  }
}
