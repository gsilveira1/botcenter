import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { tenantScopeExtension } from './tenant-scope';

/** Client of an interactive transaction (`prisma.$transaction(async (tx) => ...)`). */
export type TransactionClient = Prisma.TransactionClient;

/**
 * The Prisma client of the process (Prisma 7 with `@prisma/adapter-pg`). The connection pool opens on the
 * first query. Use `forTenant(tenantId)` for every query on a tenant table: it adds the `tenantId` filter.
 * Use the base client only for tables without a tenant (`raw_events`, `tenants`, `audit_logs`) and for the
 * lookups that find the tenant (the API key guard, the provider webhook).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  constructor(@Inject(ENV) env: AppEnv) {
    super({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_SIZE }),
    });
  }

  /** A client that adds `tenantId` to every query of a tenant model (see `tenant-scope.ts`). */
  forTenant(tenantId: string) {
    return this.$extends(tenantScopeExtension(tenantId));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}

export type TenantScopedClient = ReturnType<PrismaService['forTenant']>;
