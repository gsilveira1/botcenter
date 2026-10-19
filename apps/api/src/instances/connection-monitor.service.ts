import { Inject, Injectable } from '@nestjs/common';
import { ProviderError } from '@botcenter/whatsapp-provider';
import type { WhatsAppProvider } from '@botcenter/whatsapp-provider';
import { Prisma } from '../generated/prisma/client';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { WHATSAPP_PROVIDER } from '../provider/provider.tokens';
import { AlertService } from '../services/alert.service';
import { INCIDENT_STATUSES, statusFromProvider } from './instance-status';
import { InstanceStatusService } from './instance-status.service';

/** The alert time of the plan: an instance disconnected for more than 2 minutes. */
export const INCIDENT_ALERT_AFTER_MS = 2 * 60_000;
/** The reconciliation reads the provider state of an instance in an incident status for this time. */
export const RECONCILE_AFTER_MS = 10 * 60_000;
/** Maximum provider reads of one reconciliation run. */
export const RECONCILE_BATCH = 50;
/** Maximum instances that one alert lists. */
const ALERT_LIST_MAX = 10;

interface IncidentRow {
  id: string;
  tenantId: string;
  status: string;
}

export interface IncidentCheckResult {
  alerted: number;
  recovered: number;
}

export interface ReconcileResult {
  checked: number;
  changed: number;
  /** True when the run stopped because the provider is not available. */
  stopped: boolean;
}

type ReconcileOutcome = 'changed' | 'unchanged' | 'skipped' | 'provider_unavailable';

function describe(rows: readonly IncidentRow[]): string {
  const listed = rows
    .slice(0, ALERT_LIST_MAX)
    .map((row) => `${row.id} (${row.status}, tenant ${row.tenantId})`);
  const more = rows.length > ALERT_LIST_MAX ? [`and ${rows.length - ALERT_LIST_MAX} more`] : [];
  return [...listed, ...more].join('\n');
}

/**
 * The connection monitor (the most important alert of the plan).
 * - `checkIncidents`: an incident starts when a `connected` instance goes to `connecting` or
 *   `disconnected`. After 2 minutes, one atomic update claims the incident (`disconnectAlertedAt`), so
 *   each incident gets one alert, also with many workers. When the incident ends (the status service
 *   clears `disconnectedSince`), the next run sends one recovery message.
 * - `reconcile`: reads the provider state of the instances that stay in an incident status, and
 *   corrects the status when a webhook was lost.
 */
@Injectable()
export class ConnectionMonitorService {
  private readonly logger = getLogger('connection-monitor');

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
    private readonly statuses: InstanceStatusService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  async checkIncidents(now = new Date()): Promise<IncidentCheckResult> {
    const alertBefore = new Date(now.getTime() - INCIDENT_ALERT_AFTER_MS);
    // One UPDATE ... RETURNING claims the incidents atomically. Raw SQL: these internal columns do not
    // change `updatedAt` of the public answer.
    const opened = await this.prisma.$queryRaw<IncidentRow[]>`
      UPDATE "instances" SET "disconnectAlertedAt" = ${now}
      WHERE "deletedAt" IS NULL
        AND "status"::text IN (${Prisma.join(INCIDENT_STATUSES)})
        AND "disconnectedSince" <= ${alertBefore}
        AND "disconnectAlertedAt" IS NULL
      RETURNING "id", "tenantId", "status"::text AS "status"`;
    const recovered = await this.prisma.$queryRaw<IncidentRow[]>`
      UPDATE "instances" SET "disconnectAlertedAt" = NULL
      WHERE "disconnectAlertedAt" IS NOT NULL
        AND ("disconnectedSince" IS NULL OR "deletedAt" IS NOT NULL)
      RETURNING "id", "tenantId", "status"::text AS "status"`;
    if (opened.length > 0) {
      this.logger.error({ count: opened.length }, 'instances disconnected for more than 2 minutes');
      await this.alerts.notify({
        severity: 'critical',
        title: `${opened.length} instance(s) disconnected for more than 2 minutes`,
        details: { instances: describe(opened) },
      });
    }
    if (recovered.length > 0) {
      this.logger.info({ count: recovered.length }, 'disconnected instances recovered');
      await this.alerts.notify({
        severity: 'info',
        title: `${recovered.length} instance(s) no longer disconnected`,
        details: { instances: describe(recovered) },
      });
    }
    return { alerted: opened.length, recovered: recovered.length };
  }

  async reconcile(now = new Date()): Promise<ReconcileResult> {
    const rows = await this.prisma.instance.findMany({
      where: {
        deletedAt: null,
        status: { in: [...INCIDENT_STATUSES] },
        statusChangedAt: { lte: new Date(now.getTime() - RECONCILE_AFTER_MS) },
        providerCreatedAt: { not: null },
      },
      // The rows with the oldest provider state go first, so each run reads different instances.
      orderBy: [{ providerEventAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: RECONCILE_BATCH,
      select: { id: true, tenantId: true, providerName: true },
    });
    const result: ReconcileResult = { checked: 0, changed: 0, stopped: false };
    for (const row of rows) {
      const outcome = await this.reconcileOne(row, now);
      if (outcome === 'provider_unavailable') {
        result.stopped = true;
        break;
      }
      result.checked += 1;
      result.changed += outcome === 'changed' ? 1 : 0;
    }
    return result;
  }

  private async reconcileOne(
    row: { id: string; tenantId: string; providerName: string },
    now: Date,
  ): Promise<ReconcileOutcome> {
    const lookup = { id: row.id, tenantId: row.tenantId };
    try {
      const state = await this.provider.getConnectionState(row.providerName);
      const result = await this.statuses.transition(lookup, {
        next: statusFromProvider(state),
        now,
        providerEventAt: now,
      });
      return result.kind === 'applied' && result.changed ? 'changed' : 'unchanged';
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        throw error;
      }
      if (error.code === 'not_found') {
        // The provider lost the instance: the session is gone. The next connect creates it again.
        this.logger.warn({ instance_id: row.id }, 'the provider does not know the instance');
        await this.statuses.transition(lookup, {
          next: 'logged_out',
          now,
          providerEventAt: now,
          data: { providerCreatedAt: null },
        });
        return 'changed';
      }
      this.logger.warn(
        { err: error, instance_id: row.id, code: error.code },
        'provider state not read',
      );
      return error.retryable ? 'provider_unavailable' : 'skipped';
    }
  }
}
