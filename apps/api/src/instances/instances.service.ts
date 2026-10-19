import { Injectable } from '@nestjs/common';
import type {
  CreateInstanceRequest,
  InstancePage,
  InstanceResponse,
  ListInstancesQuery,
} from '@botcenter/contracts';
import { ProviderError } from '@botcenter/whatsapp-provider';
import { randomUUID } from 'node:crypto';
import { allowsAllInstances, assertInstanceAllowed } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { AppError, notFound } from '../common/errors/app-error';
import { keysetArgs, toPage } from '../common/pagination/cursor';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AlertService } from '../services/alert.service';
import { AuditService } from '../services/audit.service';
import { TenantsService } from '../services/tenants.service';
import type { TenantInfo } from '../services/tenants.service';
import { ConnectTokenService } from './connect-token.service';
import { instanceAuditEntry } from './instance-audit';
import { InstanceStatusService } from './instance-status.service';
import { INSTANCE_SELECT, toInstanceResponse } from './instance.mapper';
import type { InstanceRow } from './instance.mapper';
import { ProviderInstancesService } from './provider-instances.service';

export interface CreateOutcome {
  /** False when the tenant already had an active instance for the `external_ref` (answer 200). */
  created: boolean;
  instance: InstanceResponse;
}

/**
 * Create, read, list, and delete of instances (architecture plan, section "Cadastro de números por API").
 * Every query filters by the tenant of the API key and by the instance list of the key.
 */
@Injectable()
export class InstancesService {
  private readonly logger = getLogger('instances');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly alerts: AlertService,
    private readonly providerInstances: ProviderInstancesService,
    private readonly statuses: InstanceStatusService,
    private readonly tokens: ConnectTokenService,
  ) {}

  /**
   * One active instance for each `(tenant, external_ref)`: a second call returns the same instance.
   * A tenant advisory lock serializes the quota check and the insert. The provider instance is made
   * after the commit; when the provider fails, the instance stays `created` and the connect call makes
   * the provider instance (see `ProviderInstancesService`).
   */
  async create(auth: AuthContext, body: CreateInstanceRequest): Promise<CreateOutcome> {
    if (!allowsAllInstances(auth)) {
      throw new AppError(
        'INSTANCE_NOT_ALLOWED',
        'An API key with an instance list cannot create instances',
      );
    }
    const tenant = await this.tenants.get(auth.tenantId);
    const outcome = await this.prisma.$transaction((tx) =>
      this.findOrInsert(tx, auth, body, tenant),
    );
    if (outcome.created) {
      await this.createInProvider(outcome.row);
    }
    return { created: outcome.created, instance: toInstanceResponse(outcome.row) };
  }

  /** In the transaction of the create: the active instance of the owner, or a new one in the quota. */
  private async findOrInsert(
    tx: TransactionClient,
    auth: AuthContext,
    body: CreateInstanceRequest,
    tenant: TenantInfo,
  ): Promise<{ created: boolean; row: InstanceRow }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('instances'), hashtext(${auth.tenantId}))`;
    const existing = await tx.instance.findFirst({
      where: { tenantId: auth.tenantId, externalRef: body.external_ref, deletedAt: null },
      select: INSTANCE_SELECT,
    });
    if (existing) {
      return { created: false, row: existing };
    }
    const active = await tx.instance.count({ where: { tenantId: auth.tenantId, deletedAt: null } });
    if (active >= tenant.maxInstances) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        `The tenant has the maximum number of instances (${tenant.maxInstances})`,
      );
    }
    const row = await tx.instance.create({
      data: {
        tenantId: auth.tenantId,
        externalRef: body.external_ref,
        providerName: `inst_${randomUUID()}`,
        consentAt: new Date(body.consent_at),
        rateLimitPerMinute: body.rate_limit_per_minute ?? tenant.instanceRateLimitPerMinute,
      },
      select: INSTANCE_SELECT,
    });
    await this.auditCreate(tx, auth, row, body.consent_at);
    return { created: true, row };
  }

  async get(auth: AuthContext, id: string): Promise<InstanceResponse> {
    assertInstanceAllowed(auth, id);
    return toInstanceResponse(await this.findActive(auth.tenantId, id));
  }

  async list(auth: AuthContext, query: ListInstancesQuery): Promise<InstancePage> {
    const page = keysetArgs(query);
    const rows = await this.prisma.forTenant(auth.tenantId).instance.findMany({
      where: {
        ...page.where,
        deletedAt: null,
        ...(query.external_ref ? { externalRef: query.external_ref } : {}),
        ...(allowsAllInstances(auth) ? {} : { id: { in: auth.instanceIds } }),
      },
      orderBy: page.orderBy,
      take: page.take,
      select: INSTANCE_SELECT,
    });
    return toPage(rows, query.limit, toInstanceResponse);
  }

  /**
   * Ends the session and deletes the instance in the provider first. When the provider fails, the
   * route answers 503 and the row does not change, so the client can retry (the provider calls are
   * idempotent). Then one transaction makes the soft delete, the status `logged_out` with its event,
   * the revoke of the connect tokens, and the audit row.
   */
  async remove(auth: AuthContext, id: string): Promise<InstanceResponse> {
    assertInstanceAllowed(auth, id);
    const row = await this.findActive(auth.tenantId, id);
    await this.providerInstances.forRoute('delete', id, () => this.providerInstances.remove(row));
    const now = new Date();
    const result = await this.statuses.transition(
      { id, tenantId: auth.tenantId },
      {
        next: 'logged_out',
        now,
        data: { deletedAt: now, providerCreatedAt: null },
        inTransaction: async (tx) => {
          const revoked = await this.tokens.revokeAll(tx, auth.tenantId, id, now);
          await this.audit.record(
            instanceAuditEntry(auth, id, 'instance.delete', {
              previous_status: row.status,
              revoked_tokens: revoked,
            }),
            tx,
          );
        },
      },
    );
    if (result.kind === 'missing') {
      throw notFound('Instance');
    }
    const deleted = await this.prisma.forTenant(auth.tenantId).instance.findFirstOrThrow({
      where: { id },
      select: INSTANCE_SELECT,
    });
    return toInstanceResponse(deleted);
  }

  /** The active (not deleted) instance of the tenant, or 404. */
  async findActive(tenantId: string, id: string): Promise<InstanceRow> {
    const row = await this.prisma.forTenant(tenantId).instance.findFirst({
      where: { id, deletedAt: null },
      select: INSTANCE_SELECT,
    });
    if (!row) {
      throw notFound('Instance');
    }
    return row;
  }

  /** The plan audits the consent of the end user and the create. */
  private async auditCreate(
    tx: TransactionClient,
    auth: AuthContext,
    row: InstanceRow,
    consentAt: string,
  ): Promise<void> {
    await this.audit.record(
      instanceAuditEntry(auth, row.id, 'instance.consent', { consent_at: consentAt }),
      tx,
    );
    await this.audit.record(
      instanceAuditEntry(auth, row.id, 'instance.create', {
        provider_name: row.providerName,
        rate_limit_per_minute: row.rateLimitPerMinute,
      }),
      tx,
    );
  }

  /** A provider failure does not fail the create: the connect call makes the provider instance. */
  private async createInProvider(row: InstanceRow): Promise<void> {
    try {
      await this.providerInstances.create(row);
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        throw error;
      }
      this.logger.warn(
        { err: error, instance_id: row.id, code: error.code },
        'provider instance not created; the connect call creates it',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Provider instance not created at create time',
        details: { instance_id: row.id, code: error.code, http_status: error.httpStatus ?? null },
        dedupeKey: 'instances:provider-create',
      });
    }
  }
}
