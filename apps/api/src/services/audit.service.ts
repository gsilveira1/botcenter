import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';

export interface AuditEntry {
  /** `null` for a platform action without a tenant. */
  tenantId: string | null;
  /** Who did the action: `api_key:<prefix>`, `cli:<operator>`, or `system:<component>`. */
  actor: string;
  /** For example `instance.create`, `instance.connect`, `api_key.revoke`. */
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Ids, counts, and flags only. Never message content, secrets, or full phone numbers. */
  metadata?: Prisma.InputJsonObject;
}

/**
 * Writes the audit trail (`audit_logs`). The table is insert only: a database trigger refuses
 * `UPDATE`, `DELETE`, and `TRUNCATE`. Pass `tx` to write the row in the transaction of the action.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: TransactionClient): Promise<string> {
    const client = tx ?? this.prisma;
    const row = await client.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actor: entry.actor,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? {},
      },
      select: { id: true },
    });
    return row.id;
  }
}
