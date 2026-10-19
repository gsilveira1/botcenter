import type { AuthContext } from '../auth/auth-context';
import { auditActor } from '../auth/auth-context';
import type { Prisma } from '../generated/prisma/client';
import type { AuditEntry } from '../services/audit.service';

/** The audit row of an action of an API key on an instance. Metadata: ids, codes, and times only. */
export function instanceAuditEntry(
  auth: AuthContext,
  instanceId: string,
  action: string,
  metadata: Prisma.InputJsonObject,
): AuditEntry {
  return {
    tenantId: auth.tenantId,
    actor: auditActor(auth),
    action,
    targetType: 'instance',
    targetId: instanceId,
    metadata,
  };
}
