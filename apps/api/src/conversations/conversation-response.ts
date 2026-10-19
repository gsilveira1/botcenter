import { CONVERSATION_TRANSITIONS_MAX } from '@botcenter/contracts';
import type { ConversationResponse } from '@botcenter/contracts';
import type { Prisma } from '../generated/prisma/client';
import { toConversationRecord } from './conversation-record';

/** The Prisma query of a conversation response: the bot slug and the last 50 transitions. */
export const CONVERSATION_RESPONSE_INCLUDE = {
  bot: { select: { slug: true } },
  instance: { select: { externalRef: true } },
  transitions: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: CONVERSATION_TRANSITIONS_MAX,
    select: { fromState: true, toState: true, trigger: true, createdAt: true },
  },
} satisfies Prisma.ConversationInclude;

export type ConversationWithResponseData = Prisma.ConversationGetPayload<{
  include: typeof CONVERSATION_RESPONSE_INCLUDE;
}>;

export function toConversationResponse(row: ConversationWithResponseData): ConversationResponse {
  const record = toConversationRecord(row);
  return {
    id: row.id,
    instance_id: row.instanceId,
    contact: row.contact,
    bot_id: row.bot.slug,
    bot_version: row.botVersion,
    state: row.state,
    variables: record.variables,
    handoff: row.handoff,
    transitions: row.transitions.map((transition) => ({
      from_state: transition.fromState,
      to_state: transition.toState,
      trigger: transition.trigger,
      at: transition.createdAt.toISOString(),
    })),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
