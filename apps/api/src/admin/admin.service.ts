import { Inject, Injectable } from '@nestjs/common';
import { Scope } from '@botcenter/contracts';
import { generateApiKey, hashSecret } from '../auth/api-key';
import { ApiKeyService } from '../auth/api-key.service';
import { AppError, notFound, validationError } from '../common/errors/app-error';
import { addressMatcher } from '../common/http/network';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import type { ApiKey, Tenant } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AuditService } from '../services/audit.service';
import { TenantsService } from '../services/tenants.service';

/** Active keys with the same tenant and the same scope set: two during a rotation, never more. */
export const MAX_ACTIVE_KEYS_PER_SCOPE_SET = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export interface TenantQuotas {
  maxInstances?: number;
  maxMessagesPerDay?: number;
  retentionDays?: number;
  rateLimitPerMinute?: number;
  instanceRateLimitPerMinute?: number;
}

export interface CreateTenantInput extends TenantQuotas {
  name: string;
  slug: string;
}

export interface CreateKeyInput {
  /** Tenant id or slug. */
  tenant: string;
  name: string;
  scopes: string[];
  instanceIds?: string[];
  allowedIps?: string[];
  rateLimitPerMinute?: number | null;
  expiresAt?: Date | null;
}

/** An API key without its hash (the output of the CLI). */
export type ApiKeyView = Omit<ApiKey, 'secretHash'>;

export interface CreatedKey {
  /** The full key. The CLI prints it once. */
  key: string;
  apiKey: ApiKeyView;
}

function view(key: ApiKey): ApiKeyView {
  const { secretHash: _secretHash, ...rest } = key;
  return rest;
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function checkQuotas(quotas: TenantQuotas): void {
  for (const [field, value] of Object.entries(quotas)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw validationError('Invalid quota', [
        { path: field, message: 'Must be a positive integer' },
      ]);
    }
  }
}

/**
 * Tenant and API key administration for the CLI scripts (plan, section 8: no admin HTTP route in
 * `v0.1.0`). Each action writes an audit row with the actor `cli:<operator>`.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly keys: ApiKeyService,
    private readonly tenants: TenantsService,
  ) {}

  async createTenant(input: CreateTenantInput, actor: string): Promise<Tenant> {
    if (!input.name.trim()) {
      throw validationError('Invalid tenant', [{ path: 'name', message: 'Required' }]);
    }
    if (!SLUG.test(input.slug)) {
      throw validationError('Invalid tenant', [
        { path: 'slug', message: 'Must be a slug: a-z, 0-9, and "-"' },
      ]);
    }
    const { name, slug, ...quotas } = input;
    checkQuotas(quotas);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tenant.findUnique({ where: { slug } });
      if (existing) {
        throw new AppError('CONFLICT', `A tenant with the slug "${slug}" exists`);
      }
      const tenant = await tx.tenant.create({ data: { name: name.trim(), slug, ...quotas } });
      await this.audit.record(
        {
          tenantId: tenant.id,
          actor,
          action: 'tenant.create',
          targetType: 'tenant',
          targetId: tenant.id,
          metadata: { slug, ...quotas },
        },
        tx,
      );
      return tenant;
    });
  }

  async updateQuotas(tenantRef: string, quotas: TenantQuotas, actor: string): Promise<Tenant> {
    checkQuotas(quotas);
    if (Object.values(quotas).every((value) => value === undefined)) {
      throw validationError('Nothing to change', [
        { path: 'quotas', message: 'Give at least one quota' },
      ]);
    }
    const tenant = await this.prisma.$transaction(async (tx) => {
      const current = await this.findTenant(tx, tenantRef);
      const updated = await tx.tenant.update({ where: { id: current.id }, data: quotas });
      await this.audit.record(
        {
          tenantId: current.id,
          actor,
          action: 'tenant.update_quotas',
          targetType: 'tenant',
          targetId: current.id,
          metadata: { ...quotas },
        },
        tx,
      );
      return updated;
    });
    await this.tenants.invalidate(tenant.id);
    return tenant;
  }

  async createKey(input: CreateKeyInput, actor: string, now = new Date()): Promise<CreatedKey> {
    const scopes = this.checkScopes(input.scopes);
    const allowedIps = input.allowedIps ?? [];
    try {
      addressMatcher(allowedIps);
    } catch (error) {
      throw validationError('Invalid address list', [
        { path: 'allowedIps', message: (error as Error).message },
      ]);
    }
    if (input.expiresAt && input.expiresAt <= now) {
      throw validationError('Invalid expiry', [
        { path: 'expiresAt', message: 'Must be in the future' },
      ]);
    }
    if (input.rateLimitPerMinute !== undefined && input.rateLimitPerMinute !== null) {
      checkQuotas({ rateLimitPerMinute: input.rateLimitPerMinute });
    }
    if (!input.name.trim()) {
      throw validationError('Invalid key', [{ path: 'name', message: 'Required' }]);
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await this.findTenant(tx, input.tenant);
      const instanceIds = await this.checkInstances(tx, tenant.id, input.instanceIds ?? []);
      await this.lockTenant(tx, tenant.id);
      await this.checkActiveKeyLimit(tx, tenant.id, scopes, now);
      const created = await this.insertKey(tx, {
        tenantId: tenant.id,
        name: input.name.trim(),
        scopes,
        instanceIds,
        allowedIps,
        rateLimitPerMinute: input.rateLimitPerMinute ?? null,
        expiresAt: input.expiresAt ?? null,
      });
      await this.audit.record(
        {
          tenantId: tenant.id,
          actor,
          action: 'api_key.create',
          targetType: 'api_key',
          targetId: created.apiKey.id,
          metadata: { prefix: created.apiKey.prefix, scopes, instance_count: instanceIds.length },
        },
        tx,
      );
      return created;
    });
    await this.keys.invalidate(result.apiKey.prefix);
    return result;
  }

  async listKeys(tenantRef: string, actor: string): Promise<ApiKeyView[]> {
    const tenant = await this.findTenant(this.prisma, tenantRef);
    const rows = await this.prisma.apiKey.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    await this.audit.record({
      tenantId: tenant.id,
      actor,
      action: 'api_key.list',
      targetType: 'tenant',
      targetId: tenant.id,
      metadata: { count: rows.length },
    });
    return rows.map(view);
  }

  async revokeKey(keyRef: string, actor: string, now = new Date()): Promise<ApiKeyView> {
    const revoked = await this.prisma.$transaction(async (tx) => {
      const key = await this.findKey(tx, keyRef);
      if (key.revokedAt) {
        throw new AppError('CONFLICT', 'The API key is already revoked');
      }
      const updated = await tx.apiKey.update({ where: { id: key.id }, data: { revokedAt: now } });
      await this.audit.record(
        {
          tenantId: key.tenantId,
          actor,
          action: 'api_key.revoke',
          targetType: 'api_key',
          targetId: key.id,
          metadata: { prefix: key.prefix },
        },
        tx,
      );
      return updated;
    });
    // The revocation is immediate: the guard reads the database at the next request.
    await this.keys.invalidate(revoked.prefix);
    return view(revoked);
  }

  /**
   * Creates a new key with the same tenant, scopes, instances, addresses, and rate limit. The old key stays
   * active until `admin:key:revoke`, so the client can change the key without downtime.
   */
  async rotateKey(
    keyRef: string,
    actor: string,
    name?: string,
    now = new Date(),
  ): Promise<CreatedKey & { replaces: string }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const old = await this.findKey(tx, keyRef);
      if (old.revokedAt) {
        throw new AppError('CONFLICT', 'The API key is revoked; create a new key');
      }
      await this.lockTenant(tx, old.tenantId);
      await this.checkActiveKeyLimit(tx, old.tenantId, old.scopes, now);
      const created = await this.insertKey(tx, {
        tenantId: old.tenantId,
        name: name?.trim() || `${old.name} (rotated)`,
        scopes: old.scopes,
        instanceIds: old.instanceIds,
        allowedIps: old.allowedIps,
        rateLimitPerMinute: old.rateLimitPerMinute,
        expiresAt: old.expiresAt && old.expiresAt > now ? old.expiresAt : null,
      });
      await this.audit.record(
        {
          tenantId: old.tenantId,
          actor,
          action: 'api_key.rotate',
          targetType: 'api_key',
          targetId: created.apiKey.id,
          metadata: { prefix: created.apiKey.prefix, replaces: old.prefix },
        },
        tx,
      );
      return { ...created, replaces: old.prefix };
    });
    await this.keys.invalidate(result.apiKey.prefix);
    return result;
  }

  private async insertKey(
    tx: TransactionClient,
    data: Omit<ApiKey, 'id' | 'prefix' | 'secretHash' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>,
  ): Promise<CreatedKey> {
    const generated = generateApiKey();
    const row = await tx.apiKey.create({
      data: {
        ...data,
        prefix: generated.prefix,
        secretHash: hashSecret(this.env.API_KEY_PEPPER, generated.secret),
      },
    });
    return { key: generated.key, apiKey: view(row) };
  }

  private checkScopes(scopes: string[]): Scope[] {
    const unique = [...new Set(scopes)];
    if (unique.length === 0) {
      throw validationError('Invalid scopes', [
        { path: 'scopes', message: 'Give at least one scope' },
      ]);
    }
    const invalid = unique.filter((scope) => !Scope.safeParse(scope).success);
    if (invalid.length > 0) {
      throw validationError('Invalid scopes', [
        { path: 'scopes', message: `Unknown scope: ${invalid.join(', ')}` },
      ]);
    }
    return unique.sort() as Scope[];
  }

  private async checkInstances(
    tx: TransactionClient,
    tenantId: string,
    instanceIds: string[],
  ): Promise<string[]> {
    const unique = [...new Set(instanceIds)];
    const malformed = unique.filter((id) => !UUID.test(id));
    if (malformed.length > 0) {
      throw validationError('Invalid instances', [
        { path: 'instanceIds', message: 'Each id must be a UUID' },
      ]);
    }
    if (unique.length === 0) {
      return [];
    }
    const found = await tx.instance.count({
      where: { tenantId, id: { in: unique }, deletedAt: null },
    });
    if (found !== unique.length) {
      throw validationError('Invalid instances', [
        { path: 'instanceIds', message: 'Each instance must exist in the tenant' },
      ]);
    }
    return unique;
  }

  private async checkActiveKeyLimit(
    tx: TransactionClient,
    tenantId: string,
    scopes: string[],
    now: Date,
  ): Promise<void> {
    const active = await tx.apiKey.findMany({
      where: { tenantId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { scopes: true },
    });
    const same = active.filter((key) => sameScopes(key.scopes, scopes)).length;
    if (same >= MAX_ACTIVE_KEYS_PER_SCOPE_SET) {
      throw new AppError(
        'CONFLICT',
        `The tenant has ${same} active keys with these scopes. Revoke one before you create or rotate a key.`,
      );
    }
  }

  /** Serializes the key changes of one tenant (the limit check and the insert). */
  private async lockTenant(tx: TransactionClient, tenantId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
  }

  private async findTenant(client: TransactionClient, ref: string): Promise<Tenant> {
    const tenant = UUID.test(ref)
      ? await client.tenant.findUnique({ where: { id: ref } })
      : await client.tenant.findUnique({ where: { slug: ref } });
    if (!tenant) {
      throw notFound('Tenant');
    }
    return tenant;
  }

  private async findKey(client: TransactionClient, ref: string): Promise<ApiKey> {
    const key = UUID.test(ref)
      ? await client.apiKey.findUnique({ where: { id: ref } })
      : await client.apiKey.findUnique({ where: { prefix: ref } });
    if (!key) {
      throw notFound('API key');
    }
    return key;
  }
}
