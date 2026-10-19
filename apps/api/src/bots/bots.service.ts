import { Injectable } from '@nestjs/common';
import type { BotDefinition, BotResponse } from '@botcenter/contracts';
import { definitionHash, parseDefinitionForEngine } from '@botcenter/engine';
import { allowsAllInstances, assertInstanceAllowed, auditActor } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { AppError, notFound } from '../common/errors/app-error';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AuditService } from '../services/audit.service';
import { bindInstances } from './bot-bindings';
import type { BindingChange } from './bot-bindings';
import type { PutBotBody } from './bot-request';

const BOT_SELECT = {
  id: true,
  slug: true,
  name: true,
  currentVersion: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BotSelect;

type BotRow = Prisma.BotGetPayload<{ select: typeof BOT_SELECT }>;

interface PublishResult {
  bot: BotRow;
  created: boolean;
  versionCreated: boolean;
}

/**
 * `PUT /v1/bots/{id}` and `GET /v1/bots/{id}`. The `{id}` is the slug of the bot in the tenant.
 * A new `bot_versions` row is written only when the hash of the parsed definition changed. Open
 * conversations stay on their version; new conversations use the current version.
 */
@Injectable()
export class BotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async put(auth: AuthContext, slug: string, body: PutBotBody): Promise<BotResponse> {
    const definition = this.parseDefinition(body.definition);
    for (const instanceId of body.instance_ids) {
      assertInstanceAllowed(auth, instanceId);
    }
    const result = await this.prisma.forTenant(auth.tenantId).$transaction(async (scoped) => {
      const tx = scoped as unknown as TransactionClient;
      // Serializes the writes of one bot: the version numbers and the bindings stay consistent.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`bot:${auth.tenantId}:${slug}`}, 0))`;
      const published = await this.publish(tx, auth.tenantId, slug, body.name, definition);
      const change = await bindInstances(tx, auth, published.bot.id, body.instance_ids);
      await this.recordAudit(tx, auth, published, change);
      return published;
    });
    return this.toResponse(auth, result.bot);
  }

  async get(auth: AuthContext, slug: string): Promise<BotResponse> {
    const bot = await this.prisma.forTenant(auth.tenantId).bot.findUnique({
      where: { tenantId_slug: { tenantId: auth.tenantId, slug } },
      select: BOT_SELECT,
    });
    if (!bot) {
      throw notFound('Bot');
    }
    return this.toResponse(auth, bot);
  }

  /** The contract schema and the engine rules. Each issue becomes one field error with a dot path. */
  private parseDefinition(input: unknown): BotDefinition {
    const parsed = parseDefinitionForEngine(input);
    if (parsed.success) {
      return parsed.definition;
    }
    throw new AppError('BOT_DEFINITION_INVALID', 'The bot definition is not valid', {
      errors: parsed.issues.map((issue) => ({
        path: ['definition', ...issue.path].join('.'),
        message: issue.message,
      })),
    });
  }

  private async publish(
    tx: TransactionClient,
    tenantId: string,
    slug: string,
    name: string,
    definition: BotDefinition,
  ): Promise<PublishResult> {
    const existing = await tx.bot.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
      select: { ...BOT_SELECT, versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    const json = definition as unknown as Prisma.InputJsonObject;
    if (!existing) {
      const bot = await tx.bot.create({
        data: {
          tenantId,
          slug,
          name,
          currentVersion: 1,
          versions: { create: { tenantId, version: 1, definition: json } },
        },
        select: BOT_SELECT,
      });
      return { bot, created: true, versionCreated: true };
    }
    const latest = existing.versions[0];
    const changed =
      latest === undefined ||
      definitionHash(latest.definition as BotDefinition) !== definitionHash(definition);
    const version = changed ? existing.currentVersion + 1 : existing.currentVersion;
    if (changed) {
      await tx.botVersion.create({
        data: { tenantId, botId: existing.id, version, definition: json },
      });
    }
    const bot = await tx.bot.update({
      where: { id: existing.id },
      data: { name, currentVersion: version },
      select: BOT_SELECT,
    });
    return { bot, created: false, versionCreated: changed };
  }

  private async recordAudit(
    tx: TransactionClient,
    auth: AuthContext,
    result: PublishResult,
    change: BindingChange,
  ): Promise<void> {
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        actor: auditActor(auth),
        action: 'bot.put',
        targetType: 'bot',
        targetId: result.bot.id,
        metadata: {
          slug: result.bot.slug,
          version: result.bot.currentVersion,
          created: result.created,
          version_created: result.versionCreated,
          instance_ids: change.bound,
          unbound_instance_ids: change.unbound,
          moved_from_bot_ids: change.movedFromBotIds,
        },
      },
      tx,
    );
  }

  /** The response lists only the instances that the key can use. */
  private async toResponse(auth: AuthContext, bot: BotRow): Promise<BotResponse> {
    const instances = await this.prisma.forTenant(auth.tenantId).instance.findMany({
      where: {
        botId: bot.id,
        deletedAt: null,
        ...(allowsAllInstances(auth) ? {} : { id: { in: auth.instanceIds } }),
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return {
      id: bot.slug,
      name: bot.name,
      version: bot.currentVersion,
      instance_ids: instances.map((instance) => instance.id),
      created_at: bot.createdAt.toISOString(),
      updated_at: bot.updatedAt.toISOString(),
    };
  }
}
