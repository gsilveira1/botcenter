import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { BotDataError, BotDefinitionsService } from './bot-definitions.service';

const definition = { initial_state: 'a', states: { a: { transitions: [] } } };

function build(stored: unknown) {
  const findVersion = vi.fn(async () =>
    stored === null ? null : { definition: stored, bot: { slug: 'bot' } },
  );
  const findBot = vi.fn(async () => ({ currentVersion: 3 }));
  const prisma = {
    forTenant: () => ({ botVersion: { findUnique: findVersion }, bot: { findUnique: findBot } }),
  } as unknown as PrismaService;
  return { service: new BotDefinitionsService(prisma), findVersion, findBot };
}

describe('BotDefinitionsService', () => {
  it('parses a version once and keeps it in memory (versions never change)', async () => {
    const { service, findVersion } = build(definition);
    const first = await service.version('t1', 'b1', 1);
    expect(first).toMatchObject({
      botSlug: 'bot',
      version: 1,
      definition: { states: { a: { final: false } } },
    });
    await service.version('t1', 'b1', 1);
    expect(findVersion).toHaveBeenCalledTimes(1);
  });

  it('reads the current version of the bot each time', async () => {
    const { service, findBot, findVersion } = build(definition);
    await expect(service.current('t1', 'b1')).resolves.toMatchObject({ version: 3 });
    expect(findBot).toHaveBeenCalledTimes(1);
    expect(findVersion).toHaveBeenCalledWith({
      where: { botId_version: { botId: 'b1', version: 3 } },
      select: expect.any(Object),
    });
  });

  it('throws BotDataError for a missing version or a stored definition that does not parse', async () => {
    await expect(build(null).service.version('t1', 'b1', 1)).rejects.toBeInstanceOf(BotDataError);
    await expect(build({ states: {} }).service.version('t1', 'b1', 1)).rejects.toBeInstanceOf(
      BotDataError,
    );
  });
});
