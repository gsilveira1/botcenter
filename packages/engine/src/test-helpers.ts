import { BotDefinition, type BotDefinitionInput } from '@botcenter/contracts';
import type { ConversationSnapshot, EngineResult, InboundInput } from './types.js';

export const CONVERSATION_ID = '01920000-0000-7000-8000-000000000001';
export const NOW = new Date('2026-10-19T12:00:00.000Z');

/** Parses a definition with the contract schema (the API stores the parsed output). */
export function define(input: BotDefinitionInput): BotDefinition {
  return BotDefinition.parse(input);
}

export function text(value: string): InboundInput {
  return { type: 'text', text: value };
}

export function button(id: string, title = id): InboundInput {
  return { type: 'button_reply', buttonId: id, text: title };
}

export function listRow(id: string, title = id): InboundInput {
  return { type: 'list_reply', rowId: id, text: title };
}

export function snapshot(
  state: string,
  variables: ConversationSnapshot['variables'] = {},
  version = 1,
): ConversationSnapshot {
  return { conversationId: CONVERSATION_ID, state, variables, version };
}

/** The snapshot that the API stores after it writes a result. */
export function after(
  result: EngineResult,
  conversationId = CONVERSATION_ID,
): ConversationSnapshot {
  return {
    conversationId,
    state: result.toState,
    variables: result.variables,
    version: result.version,
  };
}

/** The texts of the `send_message` actions, in order. */
export function sentTexts(result: EngineResult): string[] {
  return result.actions.flatMap((action) =>
    action.type === 'send_message' && 'text' in action.message ? [action.message.text] : [],
  );
}
