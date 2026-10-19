import { z } from 'zod';
import { StateId, VariableName, VariableValue } from './bot-definition.js';
import { BotId, IsoDateTime, PhoneNumber, Uuid } from './common.js';

/** The response keeps the last 50 transitions, the most recent first. */
export const CONVERSATION_TRANSITIONS_MAX = 50;

/**
 * Cause of a transition:
 * - `start`: the first message of a contact opened the conversation (`from_state` is `null`);
 * - `message`: a message of the contact matched a transition;
 * - `timeout`: the state timeout expired;
 * - `handoff`: `POST /v1/conversations/{id}/handoff` changed the handoff flag (the state stays).
 */
export const TRANSITION_TRIGGERS = ['start', 'message', 'timeout', 'handoff'] as const;
export const TransitionTrigger = z.enum(TRANSITION_TRIGGERS);
export type TransitionTrigger = z.infer<typeof TransitionTrigger>;

export const ConversationTransition = z.object({
  from_state: StateId.nullable(),
  to_state: StateId,
  trigger: TransitionTrigger,
  at: IsoDateTime,
});
export type ConversationTransition = z.infer<typeof ConversationTransition>;

/** `GET /v1/conversations/{id}`. */
export const ConversationResponse = z.object({
  id: Uuid,
  instance_id: Uuid,
  contact: PhoneNumber,
  bot_id: BotId,
  bot_version: z.number().int().min(1),
  state: StateId,
  variables: z.record(VariableName, VariableValue),
  handoff: z.boolean(),
  transitions: z.array(ConversationTransition).max(CONVERSATION_TRANSITIONS_MAX),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type ConversationResponse = z.infer<typeof ConversationResponse>;

export const HANDOFF_TARGETS = ['human', 'bot'] as const;

/** `POST /v1/conversations/{id}/handoff`: `human` stops the bot, `bot` gives the conversation back to the bot. */
export const HandoffRequest = z.object({
  to: z.enum(HANDOFF_TARGETS),
});
export type HandoffRequest = z.infer<typeof HandoffRequest>;
