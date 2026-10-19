import { Injectable } from '@nestjs/common';
import type {
  CreateWebhookRequest,
  CursorQuery,
  WebhookCreatedResponse,
  WebhookPage,
} from '@botcenter/contracts';
import { auditActor } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { AppError, notFound } from '../common/errors/app-error';
import { keysetArgs, toPage } from '../common/pagination/cursor';
import { SsrfGuard } from '../external-http/ssrf-guard';
import { ExternalHttpError } from '../ports/external-http.port';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AuditService } from '../services/audit.service';
import { toWebhookResponse } from './webhooks.dto';
import { WEBHOOK_DELETED_ERROR, generateWebhookSecret } from './webhook-delivery.policy';
import { SECRET_ROTATION_GRACE_MS, WebhookSecrets } from './webhook-secrets';

/** Active webhooks of one tenant. A limit keeps the fan-out of one event small. */
export const MAX_WEBHOOKS_PER_TENANT = 10;
/** The insert needs the row id for the encryption, so the first insert has this placeholder. */
const SEAL_PLACEHOLDER = 'pending';

/**
 * The webhook subscriptions of a tenant (`/v1/webhooks`). Every query filters by the tenant of the API
 * key: a webhook of another tenant is not found.
 */
@Injectable()
export class WebhookSubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: SsrfGuard,
    private readonly secrets: WebhookSecrets,
    private readonly audit: AuditService,
  ) {}

  async create(auth: AuthContext, body: CreateWebhookRequest): Promise<WebhookCreatedResponse> {
    await this.assertUrlAllowed(body.url);
    const secret = generateWebhookSecret();
    const row = await this.prisma.$transaction(async (tx) => {
      await this.assertBelowLimit(tx, auth.tenantId);
      const created = await tx.webhookSubscription.create({
        data: {
          tenantId: auth.tenantId,
          url: body.url,
          events: body.events,
          secretEncrypted: SEAL_PLACEHOLDER,
        },
        select: { id: true },
      });
      const sealed = await tx.webhookSubscription.update({
        where: { id: created.id, tenantId: auth.tenantId },
        data: { secretEncrypted: this.secrets.seal(created.id, secret) },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actor: auditActor(auth),
          action: 'webhook.create',
          targetType: 'webhook_subscription',
          targetId: created.id,
          metadata: { events: body.events, host: new URL(body.url).host },
        },
        tx,
      );
      return sealed;
    });
    return { ...toWebhookResponse(row), secret };
  }

  async list(auth: AuthContext, query: CursorQuery): Promise<WebhookPage> {
    const page = keysetArgs(query);
    const rows = await this.prisma.forTenant(auth.tenantId).webhookSubscription.findMany({
      where: { deletedAt: null, ...page.where },
      orderBy: page.orderBy,
      take: page.take,
    });
    return toPage(rows, query.limit, toWebhookResponse);
  }

  /** Soft delete. The pending and failed deliveries of the webhook stop at once (`dead`). */
  async remove(auth: AuthContext, id: string, now = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.findActive(tx, auth.tenantId, id);
      await tx.webhookSubscription.update({
        where: { id, tenantId: auth.tenantId },
        data: { active: false, deletedAt: now },
      });
      const stopped = await tx.webhookDelivery.updateMany({
        where: {
          tenantId: auth.tenantId,
          subscriptionId: id,
          status: { in: ['pending', 'failed'] },
        },
        data: { status: 'dead', nextAttemptAt: null, lastError: WEBHOOK_DELETED_ERROR },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actor: auditActor(auth),
          action: 'webhook.delete',
          targetType: 'webhook_subscription',
          targetId: id,
          metadata: { stopped_deliveries: stopped.count },
        },
        tx,
      );
    });
  }

  /**
   * Makes a new secret. The old secret signs the deliveries too for 24 h (two `v1=` values), so the
   * client can change its receiver without a gap. A second rotation in that time drops the oldest secret.
   */
  async rotateSecret(
    auth: AuthContext,
    id: string,
    now = new Date(),
  ): Promise<WebhookCreatedResponse> {
    const secret = generateWebhookSecret();
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.findActive(tx, auth.tenantId, id);
      const rotated = await tx.webhookSubscription.update({
        where: { id, tenantId: auth.tenantId },
        data: {
          secretEncrypted: this.secrets.seal(id, secret),
          previousSecretEncrypted: current.secretEncrypted,
          previousSecretExpiresAt: new Date(now.getTime() + SECRET_ROTATION_GRACE_MS),
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actor: auditActor(auth),
          action: 'webhook.rotate_secret',
          targetType: 'webhook_subscription',
          targetId: id,
        },
        tx,
      );
      return rotated;
    });
    return { ...toWebhookResponse(row), secret };
  }

  /** The SSRF guard at registration time: 422 `WEBHOOK_URL_FORBIDDEN`. */
  private async assertUrlAllowed(url: string): Promise<void> {
    try {
      await this.guard.check(url);
    } catch (error) {
      if (!(error instanceof ExternalHttpError)) {
        throw error;
      }
      const detail =
        error.code === 'network'
          ? 'The host name of the URL does not resolve'
          : `The URL is not allowed: ${error.message}`;
      throw new AppError('WEBHOOK_URL_FORBIDDEN', detail);
    }
  }

  /** A tenant lock serializes two concurrent creates, so the limit holds. */
  private async assertBelowLimit(tx: TransactionClient, tenantId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`webhooks:${tenantId}`}))`;
    const count = await tx.webhookSubscription.count({ where: { tenantId, deletedAt: null } });
    if (count >= MAX_WEBHOOKS_PER_TENANT) {
      throw new AppError(
        'CONFLICT',
        `A tenant can have at most ${MAX_WEBHOOKS_PER_TENANT} webhooks. Delete one first.`,
      );
    }
  }

  private async findActive(tx: TransactionClient, tenantId: string, id: string) {
    const row = await tx.webhookSubscription.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) {
      throw notFound('Webhook');
    }
    return row;
  }
}
