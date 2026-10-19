import { VariableName, VariableValue } from '@botcenter/contracts';
import type { ConversationSnapshot } from '@botcenter/engine';
import { z } from 'zod';
import type { Conversation } from '../generated/prisma/client';
import { LastMenu, parseLastMenu } from './menu-reply';

/**
 * The state of one conversation as the runtime uses it. The hot cache in Redis keeps this shape (JSON).
 * PostgreSQL is the source of truth: every write checks `version`, so a stale cache entry causes a
 * conflict and a reload from PostgreSQL, never a lost update.
 */
export const ConversationRecord = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  instanceId: z.uuid(),
  contact: z.string(),
  botId: z.uuid(),
  botVersion: z.number().int().min(1),
  state: z.string(),
  variables: z.record(VariableName, VariableValue),
  version: z.number().int().min(0),
  handoff: z.boolean(),
  lastMenu: LastMenu.nullable(),
  /** State timeouts in a row without an inbound message (SEC-04). Old cache entries do not have it. */
  timeoutsInRow: z.number().int().min(0).default(0),
});
export type ConversationRecord = z.infer<typeof ConversationRecord>;

/** The stored variables. An entry that is not a valid value is removed; the engine reconciles the rest. */
function storedVariables(value: unknown): ConversationRecord['variables'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([name, item]) =>
        VariableName.safeParse(name).success && VariableValue.safeParse(item).success,
    ),
  ) as ConversationRecord['variables'];
}

/** The record of a database row. */
export function toConversationRecord(row: Conversation): ConversationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    instanceId: row.instanceId,
    contact: row.contact,
    botId: row.botId,
    botVersion: row.botVersion,
    state: row.state,
    variables: storedVariables(row.variables),
    version: row.version,
    handoff: row.handoff,
    lastMenu: parseLastMenu(row.lastMenu),
    timeoutsInRow: row.timeoutsInRow,
  };
}

export function toSnapshot(record: ConversationRecord): ConversationSnapshot {
  return {
    conversationId: record.id,
    state: record.state,
    variables: record.variables,
    version: record.version,
  };
}
