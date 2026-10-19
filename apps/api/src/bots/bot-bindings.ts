import { allowsAllInstances } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/errors/app-error';
import type { TransactionClient } from '../prisma/prisma.service';

export interface BindingChange {
  /** The instances in the request (they now serve the bot). */
  bound: string[];
  /** The instances that served the bot and are not in the request (they now have no bot). */
  unbound: string[];
  /** Other bots that lost an instance to this bot. */
  movedFromBotIds: string[];
}

/**
 * Makes `instanceIds` the instances of the bot (`instances.botId`). Rules:
 * - Each instance must be an active instance of the tenant (else 404) and in the instance list of the key
 *   (checked before, 403).
 * - An instance has at most one bot. An instance of another bot moves to this bot. Its open conversations
 *   stay on their bot and version until they end; new conversations use this bot.
 * - With an instance list on the key, `instanceIds` is the full list inside that list only: the key does
 *   not unbind instances that it cannot use.
 */
export async function bindInstances(
  tx: TransactionClient,
  auth: AuthContext,
  botId: string,
  instanceIds: string[],
): Promise<BindingChange> {
  const tenantId = auth.tenantId;
  const rows = await tx.instance.findMany({
    where: { tenantId, id: { in: instanceIds }, deletedAt: null },
    select: { id: true, botId: true },
  });
  if (rows.length !== instanceIds.length) {
    throw notFound('Instance');
  }
  const scope = allowsAllInstances(auth) ? {} : { id: { in: auth.instanceIds } };
  const stale = await tx.instance.findMany({
    where: { tenantId, botId, AND: [{ id: { notIn: instanceIds } }, scope] },
    select: { id: true },
  });
  const unbound = stale.map((row) => row.id);
  if (unbound.length > 0) {
    await tx.instance.updateMany({
      where: { tenantId, id: { in: unbound } },
      data: { botId: null },
    });
  }
  if (instanceIds.length > 0) {
    await tx.instance.updateMany({ where: { tenantId, id: { in: instanceIds } }, data: { botId } });
  }
  const moved = rows.flatMap((row) =>
    row.botId !== null && row.botId !== botId ? [row.botId] : [],
  );
  return { bound: instanceIds, unbound, movedFromBotIds: [...new Set(moved)] };
}
