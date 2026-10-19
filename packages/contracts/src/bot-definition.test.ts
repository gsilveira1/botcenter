import { describe, expect, it } from 'vitest';
import {
  Action,
  BOT_STATES_MAX,
  BOT_TRANSITIONS_PER_STATE_MAX,
  BotDefinition,
  type BotDefinitionInput,
  Condition,
  extractTemplateVariables,
} from './bot-definition.js';

function validDefinition(): BotDefinitionInput {
  return {
    initial_state: 'start',
    variables: { name: '', opted_in: false, visits: 0 },
    states: {
      start: {
        on_enter: [
          {
            type: 'send_message',
            message: {
              type: 'buttons',
              text: 'Olá {{name}}! Quer receber os treinos?',
              buttons: [
                { id: 'yes', title: 'Sim' },
                { id: 'no', title: 'Não' },
              ],
            },
          },
        ],
        transitions: [
          {
            condition: { type: 'button', id: 'yes' },
            target: 'ask_name',
            actions: [{ type: 'set_variable', name: 'opted_in', value: true }],
          },
          { condition: { type: 'text', equals: ['sim', 's'] }, target: 'ask_name' },
          { condition: { type: 'regex', pattern: '^n(ã|a)o$', flags: 'iu' }, target: 'done' },
          { condition: { type: 'any' }, target: 'start' },
        ],
        timeout: { after_seconds: 1800, target: 'done' },
      },
      ask_name: {
        on_enter: [{ type: 'send_message', message: { type: 'text', text: 'Qual é o seu nome?' } }],
        transitions: [
          {
            condition: {
              type: 'external',
              url: 'https://api.example.com/check',
              timeout_ms: 2000,
              expect: { path: '/data/approved', equals: true },
            },
            target: 'done',
            actions: [
              { type: 'set_variable', name: 'name', from: 'message_text' },
              { type: 'call_webhook', url: 'https://api.example.com/hook' },
            ],
          },
          {
            condition: { type: 'variable', name: 'opted_in', equals: false },
            target: 'human',
          },
        ],
      },
      human: { on_enter: [{ type: 'handoff' }], transitions: [] },
      done: { transitions: [], final: true },
    },
  };
}

describe('BotDefinition: valid input', () => {
  it('accepts a definition with every condition and action type', () => {
    const result = BotDefinition.safeParse(validDefinition());
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('sets the defaults', () => {
    const parsed = BotDefinition.parse({
      initial_state: 'only',
      states: {
        only: { transitions: [{ condition: { type: 'text', equals: ['oi'] }, target: 'only' }] },
      },
    });
    expect(parsed.variables).toEqual({});
    expect(parsed.states['only']).toEqual({
      on_enter: [],
      transitions: [
        {
          condition: { type: 'text', equals: ['oi'], case_sensitive: false },
          target: 'only',
          actions: [],
        },
      ],
      final: false,
    });
  });

  it('accepts 100 states and 50 transitions in one state', () => {
    const states: BotDefinitionInput['states'] = {};
    for (let n = 0; n < BOT_STATES_MAX; n += 1) {
      states[`s${n}`] = { transitions: [] };
    }
    states['s0'] = {
      transitions: Array.from({ length: BOT_TRANSITIONS_PER_STATE_MAX }, (_, n) => ({
        condition: { type: 'button' as const, id: `b${n}` },
        target: 's1',
      })),
    };
    expect(BotDefinition.safeParse({ initial_state: 's0', states }).success).toBe(true);
  });
});

describe('BotDefinition: references', () => {
  function issuePaths(input: unknown): (string | number | symbol)[][] {
    const result = BotDefinition.safeParse(input);
    expect(result.success).toBe(false);
    return result.error?.issues.map((issue) => issue.path) ?? [];
  }

  it('refuses an initial state that does not exist', () => {
    expect(issuePaths({ ...validDefinition(), initial_state: 'missing' })).toEqual([
      ['initial_state'],
    ]);
  });

  it('refuses a transition target that does not exist, with the exact path', () => {
    const definition = validDefinition();
    definition.states['ask_name']!.transitions[1]!.target = 'nowhere';
    expect(issuePaths(definition)).toEqual([['states', 'ask_name', 'transitions', 1, 'target']]);
  });

  it('refuses a timeout target that does not exist', () => {
    const definition = validDefinition();
    definition.states['start']!.timeout = { after_seconds: 60, target: 'nowhere' };
    expect(issuePaths(definition)).toEqual([['states', 'start', 'timeout', 'target']]);
  });

  it('refuses a variable that is not declared, in a condition and in an action', () => {
    const definition = validDefinition();
    definition.variables = { name: '', visits: 0 };
    expect(issuePaths(definition)).toEqual([
      ['states', 'start', 'transitions', 0, 'actions', 0, 'name'],
      ['states', 'ask_name', 'transitions', 1, 'condition', 'name'],
    ]);
  });

  it('refuses a transition after an "any" condition', () => {
    const definition = validDefinition();
    definition.states['start']!.transitions.push({ condition: { type: 'any' }, target: 'done' });
    expect(issuePaths(definition)).toEqual([['states', 'start', 'transitions', 4]]);
  });

  it('refuses a final state with transitions', () => {
    const definition = validDefinition();
    definition.states['done'] = {
      final: true,
      transitions: [{ condition: { type: 'any' }, target: 'start' }],
    };
    expect(issuePaths(definition)).toEqual([['states', 'done', 'final']]);
  });

  it('refuses a definition without states', () => {
    expect(issuePaths({ initial_state: 'start', states: {} })).toEqual([
      ['states'],
      ['initial_state'],
    ]);
  });

  it('refuses more than 100 states', () => {
    const states: BotDefinitionInput['states'] = {};
    for (let n = 0; n <= BOT_STATES_MAX; n += 1) {
      states[`s${n}`] = { transitions: [] };
    }
    expect(issuePaths({ initial_state: 's0', states })).toEqual([['states']]);
  });

  it('refuses more than 50 transitions in one state', () => {
    const transitions = Array.from({ length: BOT_TRANSITIONS_PER_STATE_MAX + 1 }, (_, n) => ({
      condition: { type: 'button' as const, id: `b${n}` },
      target: 'a',
    }));
    expect(issuePaths({ initial_state: 'a', states: { a: { transitions } } })).toEqual([
      ['states', 'a', 'transitions'],
    ]);
  });
});

describe('BotDefinition: structure', () => {
  it('refuses an unknown key (typo)', () => {
    const result = BotDefinition.safeParse({
      initial_state: 'a',
      states: { a: { transitions: [], on_entry: [] } },
    });
    expect(result.success).toBe(false);
  });

  it('refuses an invalid state id', () => {
    expect(
      BotDefinition.safeParse({ initial_state: 'a b', states: { 'a b': { transitions: [] } } })
        .success,
    ).toBe(false);
  });

  it('refuses a send_message action with delivery fields', () => {
    expect(
      Action.safeParse({
        type: 'send_message',
        message: { type: 'text', text: 'Oi', to: '5511987654321' },
      }).success,
    ).toBe(false);
  });

  it('refuses a timeout shorter than 10 s or longer than 7 days', () => {
    for (const after_seconds of [9, 604_801]) {
      expect(
        BotDefinition.safeParse({
          initial_state: 'a',
          states: { a: { transitions: [], timeout: { after_seconds, target: 'a' } } },
        }).success,
      ).toBe(false);
    }
  });
});

describe('Condition', () => {
  it.each([
    [{ type: 'text', equals: [] }],
    [{ type: 'button', id: '' }],
    [{ type: 'regex', pattern: 'x'.repeat(201) }],
    [{ type: 'regex', pattern: 'a', flags: 'g' }],
    [{ type: 'regex', pattern: 'a', flags: 'ii' }],
    [{ type: 'regex', pattern: '(' }],
    [{ type: 'external', url: 'http://api.example.com', expect: { path: '/ok', equals: true } }],
    [
      {
        type: 'external',
        url: 'https://api.example.com',
        timeout_ms: 5001,
        expect: { path: '/ok', equals: true },
      },
    ],
    [{ type: 'external', url: 'https://api.example.com', expect: { path: 'ok', equals: true } }],
    [{ type: 'variable', name: '1x', equals: 1 }],
    [{ type: 'any', extra: true }],
    [{ type: 'llm' }],
  ])('refuses %j', (condition) => {
    expect(Condition.safeParse(condition).success).toBe(false);
  });

  it('reports the path of an invalid regular expression', () => {
    const result = Condition.safeParse({ type: 'regex', pattern: '[a-' });
    expect(result.error?.issues[0]?.path).toEqual(['pattern']);
  });

  it('sets the default timeout of an external call', () => {
    expect(
      Condition.parse({
        type: 'external',
        url: 'https://api.example.com/check',
        expect: { path: '', equals: null },
      }),
    ).toMatchObject({ timeout_ms: 3000 });
  });
});

describe('Action', () => {
  it.each([
    [{ type: 'set_variable', name: 'x' }],
    [{ type: 'set_variable', name: 'x', value: 'a', from: 'message_text' }],
    [{ type: 'set_variable', name: 'x', from: 'contact' }],
    [{ type: 'call_webhook', url: 'http://example.com' }],
    [{ type: 'send_message', message: { type: 'media', media_type: 'image' } }],
    [{ type: 'handoff', to: 'human' }],
  ])('refuses %j', (action) => {
    expect(Action.safeParse(action).success).toBe(false);
  });

  it('accepts a template value', () => {
    expect(
      Action.safeParse({ type: 'set_variable', name: 'greeting', value: 'Olá {{name}}' }).success,
    ).toBe(true);
  });
});

describe('extractTemplateVariables', () => {
  it('returns each variable once, in order', () => {
    expect(extractTemplateVariables('Olá {{name}}, {{ visits }} visitas, {{name}}')).toEqual([
      'name',
      'visits',
    ]);
  });

  it('ignores text that is not a template', () => {
    expect(extractTemplateVariables('{name} {{1x}} {{ }}')).toEqual([]);
  });
});
