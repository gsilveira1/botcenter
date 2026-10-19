import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The values of an instance that its send rate needs. */
export interface InstanceRate {
  rateLimitPerMinute: number;
  firstConnectedAt: Date | null;
}

/** A changed rate applies after this time at the latest. */
export const INSTANCE_RATE_TTL_MS = 30_000;
/** Maximum cached instances. Above it, the cache starts empty again. */
const MAX_ENTRIES = 10_000;

/**
 * An in-memory cache of the send rate of each instance (ARCH-10). A rate-limited job takes its token
 * before it reads the message row, so a backlog does not make one database read for each wake of each
 * job: one read for each instance and worker process every 30 s.
 */
@Injectable()
export class InstanceLimitsCache {
  private readonly entries = new Map<string, { rate: InstanceRate; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** The rate of the instance, or `null` when the instance does not exist for the tenant. */
  async get(tenantId: string, instanceId: string, now = Date.now()): Promise<InstanceRate | null> {
    const cached = this.entries.get(instanceId);
    if (cached && cached.expiresAt > now) {
      return cached.rate;
    }
    const rate = await this.prisma.forTenant(tenantId).instance.findFirst({
      where: { id: instanceId },
      select: { rateLimitPerMinute: true, firstConnectedAt: true },
    });
    if (!rate) {
      this.entries.delete(instanceId);
      return null;
    }
    if (this.entries.size >= MAX_ENTRIES) {
      this.entries.clear();
    }
    this.entries.set(instanceId, { rate, expiresAt: now + INSTANCE_RATE_TTL_MS });
    return rate;
  }
}
