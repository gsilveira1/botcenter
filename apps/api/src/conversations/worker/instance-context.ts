import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** The instance of an inbound event or a timer, with the data that the worker needs. */
export interface InstanceContext {
  tenantId: string;
  instanceId: string;
  providerName: string;
  /** The owner of the instance in the client product (every event has it). */
  externalRef: string;
  /** The bot that serves the instance, or `null`. */
  botId: string | null;
}

const SELECT = {
  id: true,
  tenantId: true,
  providerName: true,
  externalRef: true,
  botId: true,
} as const;

type InstanceRow = {
  id: string;
  tenantId: string;
  providerName: string;
  externalRef: string;
  botId: string | null;
};

function toContext(row: InstanceRow): InstanceContext {
  return {
    tenantId: row.tenantId,
    instanceId: row.id,
    providerName: row.providerName,
    externalRef: row.externalRef,
    botId: row.botId,
  };
}

/** Finds the active (not deleted) instance of an event. A deleted or unknown instance gives `null`. */
@Injectable()
export class InstanceResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** The lookup that finds the tenant: it uses the base client on the unique `providerName`. */
  async byProviderName(providerName: string): Promise<InstanceContext | null> {
    const row = await this.prisma.instance.findFirst({
      where: { providerName, deletedAt: null },
      select: SELECT,
    });
    return row ? toContext(row) : null;
  }

  async byId(tenantId: string, instanceId: string): Promise<InstanceContext | null> {
    const row = await this.prisma.forTenant(tenantId).instance.findFirst({
      where: { id: instanceId, deletedAt: null },
      select: SELECT,
    });
    return row ? toContext(row) : null;
  }
}
