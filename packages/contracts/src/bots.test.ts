import { describe, expect, it } from 'vitest';
import { BotIdParam, BotResponse, PutBotRequest } from './bots.js';

const ID = '01928f3e-8a3b-7c4d-9e5f-0123456789ab';
const ID2 = '01928f3e-8a3b-7c4d-9e5f-0123456789ac';
const NOW = '2026-10-19T12:00:00.000Z';
const definition = { initial_state: 'a', states: { a: { transitions: [] } } };

describe('PutBotRequest', () => {
  it('accepts a bot for two instances', () => {
    expect(
      PutBotRequest.safeParse({ name: 'Onboarding', definition, instance_ids: [ID, ID2] }).success,
    ).toBe(true);
  });

  it('accepts a bot without instances', () => {
    expect(PutBotRequest.safeParse({ name: 'Draft', definition, instance_ids: [] }).success).toBe(
      true,
    );
  });

  it('reports the path of a definition error under "definition"', () => {
    const result = PutBotRequest.safeParse({
      name: 'X',
      definition: { ...definition, initial_state: 'b' },
      instance_ids: [],
    });
    expect(result.error?.issues[0]?.path).toEqual(['definition', 'initial_state']);
  });

  it.each([
    [{ name: ' ', definition, instance_ids: [] }],
    [{ name: 'X', definition, instance_ids: ['abc'] }],
    [{ name: 'X', definition, instance_ids: [ID, ID] }],
    [{ name: 'X', instance_ids: [] }],
  ])('refuses %j', (input) => {
    expect(PutBotRequest.safeParse(input).success).toBe(false);
  });
});

describe('BotIdParam', () => {
  it('accepts a slug and refuses an upper case id', () => {
    expect(BotIdParam.safeParse({ id: 'onboarding-v2' }).success).toBe(true);
    expect(BotIdParam.safeParse({ id: 'Onboarding' }).success).toBe(false);
  });
});

describe('BotResponse', () => {
  const valid = {
    id: 'onboarding',
    name: 'Onboarding',
    version: 3,
    instance_ids: [ID],
    created_at: NOW,
    updated_at: NOW,
  };

  it('accepts a bot', () => {
    expect(BotResponse.safeParse(valid).success).toBe(true);
  });

  it('refuses version 0', () => {
    expect(BotResponse.safeParse({ ...valid, version: 0 }).success).toBe(false);
  });
});
