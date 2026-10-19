import type { InstanceResponse } from '@botcenter/contracts';
import type { Prisma } from '../generated/prisma/client';

/** The columns of an instance that the routes read. */
export const INSTANCE_SELECT = {
  id: true,
  tenantId: true,
  externalRef: true,
  providerName: true,
  status: true,
  phoneMasked: true,
  rateLimitPerMinute: true,
  providerCreatedAt: true,
  createdAt: true,
  updatedAt: true,
  bot: { select: { slug: true } },
} as const satisfies Prisma.InstanceSelect;

export type InstanceRow = Prisma.InstanceGetPayload<{ select: typeof INSTANCE_SELECT }>;

export function toInstanceResponse(row: InstanceRow): InstanceResponse {
  return {
    id: row.id,
    external_ref: row.externalRef,
    status: row.status,
    phone_masked: row.phoneMasked,
    bot_id: row.bot?.slug ?? null,
    rate_limit_per_minute: row.rateLimitPerMinute,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
