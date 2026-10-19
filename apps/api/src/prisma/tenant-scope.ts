import { Prisma } from '../generated/prisma/client';

/**
 * Tenant isolation in the application layer (plan, section 8). `PrismaService.forTenant(tenantId)`
 * returns a client that adds `tenantId` to every query of a tenant model:
 * - reads, updates, and deletes get `where.tenantId`;
 * - creates get `data.tenantId`.
 * A model is a tenant model when its scalar fields contain `tenantId` (read from the generated client),
 * so a new tenant table is covered without a code change. `AuditLog` is not a tenant model: its
 * `tenantId` is nullable and `AuditService` writes it.
 */
const EXCLUDED_MODELS = new Set(['AuditLog']);

export const TENANT_MODELS: ReadonlySet<string> = new Set(
  Object.values(Prisma.ModelName).filter((model) => {
    if (EXCLUDED_MODELS.has(model)) {
      return false;
    }
    const fields = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[
      `${model}ScalarFieldEnum`
    ];
    return fields !== undefined && 'tenantId' in fields;
  }),
);

type Args = Record<string, unknown> | undefined;

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

function withData(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => ({ ...(row as Record<string, unknown>), tenantId }));
  }
  return data && typeof data === 'object'
    ? { ...(data as Record<string, unknown>), tenantId }
    : data;
}

function withWhere(args: Args, tenantId: string): Record<string, unknown> {
  const base = args ?? {};
  const where = (base['where'] as Record<string, unknown> | undefined) ?? {};
  return { ...base, where: { ...where, tenantId } };
}

/** Pure rewrite of the arguments of one operation. Exported for the unit tests. */
export function scopeArgs(model: string, operation: string, args: Args, tenantId: string): Args {
  if (!TENANT_MODELS.has(model)) {
    return args;
  }
  if (CREATE_OPERATIONS.has(operation)) {
    return { ...(args ?? {}), data: withData(args?.['data'], tenantId) };
  }
  if (operation === 'upsert') {
    const scoped = withWhere(args, tenantId);
    scoped['create'] = withData(args?.['create'], tenantId);
    return scoped;
  }
  if (WHERE_OPERATIONS.has(operation)) {
    return withWhere(args, tenantId);
  }
  return args;
}

export function tenantScopeExtension(tenantId: string) {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(scopeArgs(model, operation, args as Args, tenantId) as typeof args);
        },
      },
    },
  });
}
