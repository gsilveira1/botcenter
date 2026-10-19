import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversationCacheService } from '../conversation-cache.service';
import { toConversationRecord } from '../conversation-record';
import type { ConversationRecord } from '../conversation-record';
import type { InstanceContext } from './instance-context';

/**
 * Loads the conversation of one contact: the hot cache first, then PostgreSQL (the source of truth).
 * When Redis fails, the cache returns `null` and the loader reads PostgreSQL (log and metric in the
 * cache service). Use `fresh` to skip the cache, for example after a write conflict or for a timer.
 */
@Injectable()
export class ConversationLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ConversationCacheService,
  ) {}

  async load(
    instance: InstanceContext,
    contact: string,
    options: { fresh?: boolean } = {},
  ): Promise<ConversationRecord | null> {
    if (!options.fresh) {
      const cached = await this.cache.get(instance.instanceId, contact);
      if (cached) {
        return cached;
      }
    }
    const row = await this.prisma.forTenant(instance.tenantId).conversation.findUnique({
      where: { instanceId_contact: { instanceId: instance.instanceId, contact } },
    });
    if (!row) {
      return null;
    }
    const record = toConversationRecord(row);
    await this.cache.set(record);
    return record;
  }
}
