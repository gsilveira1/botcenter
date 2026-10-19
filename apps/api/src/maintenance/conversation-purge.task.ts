import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { contactKey } from '../conversations/conversation-keys';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';
import { BatchPurger, PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from './batch-purger';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import type { MaintenanceTask, MaintenanceTaskResult } from './maintenance-task.registry';
import { DAY_MS, HOUR_MS, before, tenantRetentions } from './purge.tasks';

interface DeletedConversation {
  instanceId: string;
  contact: string;
}

/**
 * `purge-conversations`, every hour (SEC-05, ARCH-12, LGPD): deletes the conversations of each tenant
 * with no activity for its `retentionDays`: `updatedAt` and `lastInboundAt` are older than the cutoff, and
 * no message of the conversation is newer. A conversation in handoff is deleted too: no message for the
 * retention time means that the human talk ended. The transitions and the `bot_webhook_calls` go with the
 * row (`onDelete: Cascade`); the old messages keep their own purge (`conversationId` becomes `null`).
 * The task also deletes the hot cache entry of each row. The batches use `FOR UPDATE SKIP LOCKED`, so two
 * runs at the same time take different rows, and a second run finds nothing (idempotent).
 */
@Injectable()
export class ConversationPurgeTask implements MaintenanceTask, OnModuleInit {
  readonly name = 'purge-conversations' as const;
  readonly everyMs = HOUR_MS;
  private readonly logger = getLogger('maintenance');

  constructor(
    private readonly registry: MaintenanceTaskRegistry,
    private readonly prisma: PrismaService,
    private readonly purger: BatchPurger,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(now: Date): Promise<MaintenanceTaskResult> {
    let deleted = 0;
    for (const tenant of await tenantRetentions(this.prisma)) {
      const cutoff = before(now, tenant.retentionDays * DAY_MS);
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
        const rows = await this.deleteBatch(tenant.id, cutoff);
        deleted += rows.length;
        await this.dropCache(rows);
        if (rows.length < PURGE_BATCH_SIZE) {
          break;
        }
      }
    }
    this.purger.count(this.name, deleted);
    return { deleted };
  }

  private deleteBatch(tenantId: string, cutoff: Date): Promise<DeletedConversation[]> {
    return this.prisma.$queryRaw<DeletedConversation[]>`
      DELETE FROM "conversations"
      WHERE "id" IN (
        SELECT c."id" FROM "conversations" c
        WHERE c."tenantId" = ${tenantId}::uuid
          AND c."updatedAt" < ${cutoff}
          AND (c."lastInboundAt" IS NULL OR c."lastInboundAt" < ${cutoff})
          AND NOT EXISTS (
            SELECT 1 FROM "messages" m
            WHERE m."conversationId" = c."id" AND m."createdAt" >= ${cutoff}
          )
        LIMIT ${PURGE_BATCH_SIZE}
        FOR UPDATE OF c SKIP LOCKED
      )
      RETURNING "instanceId"::text AS "instanceId", "contact"`;
  }

  /** A Redis error leaves a stale entry, which ends with its TTL (1 h): log it, do not fail the run. */
  private async dropCache(rows: readonly DeletedConversation[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    try {
      await this.redis.del(
        ...rows.map((row) => redisKeys.conversation(row.instanceId, contactKey(row.contact))),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, conversations: rows.length },
        'hot cache entries of purged conversations not deleted; they end with their TTL',
      );
    }
  }
}
