import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Gauge } from 'prom-client';
import { INCIDENT_ALERT_AFTER_MS } from '../instances/connection-monitor.service';
import { INCIDENT_STATUSES } from '../instances/instance-status';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';

/** An incident of this age or older is `stale`: the owner probably parked the number. */
export const INCIDENT_STALE_AFTER_MS = 24 * 3_600_000;

/**
 * Sets `botcenter_instance_incidents{age}` at each scrape (ARCH-15). An incident is an instance that was
 * `connected` and is now `connecting` or `disconnected` (`disconnectedSince` is set) for more than
 * 2 minutes: the rule of the connection monitor. Evolution reports a lost connection as `connecting`, so
 * the status gauge alone misses it. `age` is `recent` (below 24 hours) or `stale`, so the Prometheus
 * rule can page for a new incident and stay quiet for a parked number.
 * Register it only in the API process (`MetricsApiModule`), so the sum over the processes stays correct.
 */
@Injectable()
export class InstanceIncidentsCollector implements OnModuleInit {
  private readonly incidents: Gauge<'age'>;

  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
  ) {
    this.incidents = metrics.gauge({
      name: 'botcenter_instance_incidents',
      help: 'Instances disconnected (connecting or disconnected after a connection) for more than 2 minutes, by age',
      labelNames: ['age'],
    });
  }

  onModuleInit(): void {
    this.metrics.addCollector(() => this.collect());
  }

  async collect(now = new Date()): Promise<void> {
    const where = (olderThanMs: number) => ({
      deletedAt: null,
      status: { in: [...INCIDENT_STATUSES] },
      disconnectedSince: { lte: new Date(now.getTime() - olderThanMs) },
    });
    const [all, stale] = await Promise.all([
      this.prisma.instance.count({ where: where(INCIDENT_ALERT_AFTER_MS) }),
      this.prisma.instance.count({ where: where(INCIDENT_STALE_AFTER_MS) }),
    ]);
    this.incidents.set({ age: 'recent' }, all - stale);
    this.incidents.set({ age: 'stale' }, stale);
  }
}
