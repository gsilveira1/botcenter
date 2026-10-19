import { describe, expect, it } from 'vitest';
import { ConversationResponse, HandoffRequest } from './conversations.js';

const ID = '01928f3e-8a3b-7c4d-9e5f-0123456789ab';
const NOW = '2026-10-19T12:00:00.000Z';

const valid = {
  id: ID,
  instance_id: ID,
  contact: '5511987654321',
  bot_id: 'onboarding',
  bot_version: 2,
  state: 'ask_name',
  variables: { name: 'Ana', visits: 3, opted_in: true },
  handoff: false,
  transitions: [
    { from_state: 'start', to_state: 'ask_name', trigger: 'message', at: NOW },
    { from_state: null, to_state: 'start', trigger: 'start', at: NOW },
  ],
  created_at: NOW,
  updated_at: NOW,
};

describe('ConversationResponse', () => {
  it('accepts a conversation', () => {
    expect(ConversationResponse.safeParse(valid).success).toBe(true);
  });

  it('accepts a handoff transition (the state stays)', () => {
    const handoff = { from_state: 'ask_name', to_state: 'ask_name', trigger: 'handoff', at: NOW };
    expect(ConversationResponse.safeParse({ ...valid, transitions: [handoff] }).success).toBe(true);
  });

  it('refuses more than 50 transitions', () => {
    const transitions = Array.from({ length: 51 }, () => valid.transitions[0]);
    expect(ConversationResponse.safeParse({ ...valid, transitions }).success).toBe(false);
  });

  it.each([
    [{ ...valid, contact: '+5511987654321' }],
    [{ ...valid, variables: { name: { nested: true } } }],
    [{ ...valid, transitions: [{ from_state: 'a', to_state: 'b', trigger: 'api', at: NOW }] }],
  ])('refuses %j', (input) => {
    expect(ConversationResponse.safeParse(input).success).toBe(false);
  });
});

describe('HandoffRequest', () => {
  it('accepts human and bot', () => {
    expect(HandoffRequest.safeParse({ to: 'human' }).success).toBe(true);
    expect(HandoffRequest.safeParse({ to: 'bot' }).success).toBe(true);
  });

  it('refuses another target', () => {
    expect(HandoffRequest.safeParse({ to: 'agent' }).success).toBe(false);
  });
});
