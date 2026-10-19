import { describe, expect, it, vi } from 'vitest';
import type { PrismaService, TransactionClient } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('inserts with the transaction client when the caller gives one', async () => {
    const base = { auditLog: { create: vi.fn() } };
    const tx = { auditLog: { create: vi.fn(async () => ({ id: 'a-1' })) } };
    const service = new AuditService(base as unknown as PrismaService);
    const id = await service.record(
      { tenantId: 't', actor: 'cli:x', action: 'tenant.create', targetType: 'tenant' },
      tx as unknown as TransactionClient,
    );
    expect(id).toBe('a-1');
    expect(base.auditLog.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 't',
        actor: 'cli:x',
        action: 'tenant.create',
        targetType: 'tenant',
        targetId: null,
        metadata: {},
      },
      select: { id: true },
    });
  });
});
