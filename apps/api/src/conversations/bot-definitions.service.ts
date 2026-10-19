import { Injectable } from '@nestjs/common';
import { BotDefinition } from '@botcenter/contracts';
import { PrismaService } from '../prisma/prisma.service';

/** One published bot version, ready for the engine. A version never changes after the insert. */
export interface LoadedBotVersion {
  botId: string;
  /** The public id of the bot (`PUT /v1/bots/{slug}`). */
  botSlug: string;
  version: number;
  definition: BotDefinition;
}

/** The stored data does not agree with the rules (a missing version or a definition that does not parse). */
export class BotDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotDataError';
  }
}

const CACHE_MAX_ENTRIES = 500;

/**
 * Loads bot definitions for the engine. The versions are immutable, so the service keeps the parsed
 * definitions in memory (a small LRU map). The current version of a bot is read from PostgreSQL each time.
 */
@Injectable()
export class BotDefinitionsService {
  private readonly cache = new Map<string, LoadedBotVersion>();

  constructor(private readonly prisma: PrismaService) {}

  /** The pinned version of a conversation. */
  async version(tenantId: string, botId: string, version: number): Promise<LoadedBotVersion> {
    const key = `${botId}:${version}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const row = await this.prisma.forTenant(tenantId).botVersion.findUnique({
      where: { botId_version: { botId, version } },
      select: { definition: true, bot: { select: { slug: true } } },
    });
    if (!row) {
      throw new BotDataError(`Bot version ${version} of bot ${botId} does not exist`);
    }
    const parsed = BotDefinition.safeParse(row.definition);
    if (!parsed.success) {
      throw new BotDataError(
        `The stored definition of bot ${botId} version ${version} is not valid`,
      );
    }
    const loaded = { botId, botSlug: row.bot.slug, version, definition: parsed.data };
    this.remember(key, loaded);
    return loaded;
  }

  /** The current version of a bot: new conversations start with it. */
  async current(tenantId: string, botId: string): Promise<LoadedBotVersion> {
    const bot = await this.prisma.forTenant(tenantId).bot.findUnique({
      where: { id: botId },
      select: { currentVersion: true },
    });
    if (!bot) {
      throw new BotDataError(`Bot ${botId} does not exist`);
    }
    return this.version(tenantId, botId, bot.currentVersion);
  }

  private remember(key: string, loaded: LoadedBotVersion): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, loaded);
  }
}
