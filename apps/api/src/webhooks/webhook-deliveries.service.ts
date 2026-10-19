import { Injectable } from '@nestjs/common';
import type {
  ListWebhookDeliveriesQuery,
  WebhookDeliveryPage,
  WebhookDeliveryResponse,
} from '@botcenter/contracts';
import { auditActor } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { AppError, notFound } from '../common/errors/app-error';
import { keysetArgs, toPage } from '../common/pagination/cursor';
import type { WebhookDelivery } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AuditService } from '../services/audit.service';
import { toDeliveryResponse } from './webhooks.dto';
import { WebhookDeliveryJobs } from './webhook-delivery.jobs';

/** The deliveries of a tenant (`/v1/webhooks/deliveries`) and the manual redelivery. */
@Injectable()
export class WebhookDeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: WebhookDeliveryJobs,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, query: ListWebhookDeliveriesQuery): Promise<WebhookDeliveryPage> {
    const page = keysetArgs(query);
    const rows = await this.prisma.forTenant(auth.tenantId).webhookDelivery.findMany({
      where: { ...(query.status ? { status: query.status } : {}), ...page.where },
      orderBy: page.orderBy,
      take: page.take,
    });
    return toPage(rows, query.limit, toDeliveryResponse);
  }

  /**
   * Sends a `dead` or `failed` delivery again: a new attempt cycle (the attempt count starts at 0) with
   * the same event id, so the receiver can drop a duplicate. The webhook must still exist.
   */
  async redeliver(
    auth: AuthContext,
    id: string,
    now = new Date(),
  ): Promise<WebhookDeliveryResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      const [reset] = await tx.webhookDelivery.updateManyAndReturn({
        where: {
          id,
          tenantId: auth.tenantId,
          status: { in: ['dead', 'failed'] },
          subscription: { deletedAt: null, active: true },
        },
        data: {
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          lastError: null,
          lastStatusCode: null,
        },
      });
      if (!reset) {
        throw await this.refusal(tx, auth.tenantId, id);
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actor: auditActor(auth),
          action: 'webhook_delivery.redeliver',
          targetType: 'webhook_delivery',
          targetId: id,
          metadata: { event_id: reset.eventId, webhook_id: reset.subscriptionId },
        },
        tx,
      );
      return reset;
    });
    // When Redis fails, the delivery stays `pending` and the sweep adds the job.
    await this.jobs.enqueue([row], now.getTime());
    return toDeliveryResponse(row);
  }

  /** The reason why the reset did not match: 404 (no row of this tenant) or 409 (wrong state). */
  private async refusal(tx: TransactionClient, tenantId: string, id: string): Promise<AppError> {
    const existing: (WebhookDelivery & { subscription: { deletedAt: Date | null } }) | null =
      await tx.webhookDelivery.findFirst({
        where: { id, tenantId },
        include: { subscription: { select: { deletedAt: true } } },
      });
    if (!existing) {
      return notFound('Webhook delivery');
    }
    if (existing.subscription.deletedAt) {
      return new AppError('CONFLICT', 'The webhook of this delivery is deleted');
    }
    return new AppError(
      'CONFLICT',
      `Only a dead or failed delivery can be sent again (status: ${existing.status})`,
    );
  }
}
