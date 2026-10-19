import type { BotDefinitionInput } from '@botcenter/contracts';
import { describe, expect, it } from 'vitest';
import { personalTrainerOnboarding } from './fixtures/personal-trainer-onboarding.js';
import { define } from './test-helpers.js';
import { parseDefinitionForEngine, validateDefinitionForEngine } from './validate.js';

function base(): BotDefinitionInput {
  return {
    initial_state: 'a',
    variables: { nome: '', idade: 0, ativo: false },
    states: { a: { transitions: [] } },
  };
}

function withState(state: BotDefinitionInput['states'][string]): BotDefinitionInput {
  return { ...base(), states: { a: state } };
}

describe('validateDefinitionForEngine', () => {
  it('accepts the onboarding fixture', () => {
    expect(validateDefinitionForEngine(define(personalTrainerOnboarding))).toEqual([]);
  });

  it.each(['(a)\\1', '(?=x)y', '(?<!x)y'])(
    'refuses the regex %j that RE2 cannot compile',
    (pattern) => {
      const issues = validateDefinitionForEngine(
        define(
          withState({ transitions: [{ condition: { type: 'regex', pattern }, target: 'a' }] }),
        ),
      );
      expect(issues).toEqual([
        {
          path: ['states', 'a', 'transitions', 0, 'condition', 'pattern'],
          message: expect.stringContaining('RE2'),
        },
      ]);
    },
  );

  it('refuses a template with an undeclared variable, with the exact path', () => {
    const issues = validateDefinitionForEngine(
      define(
        withState({
          on_enter: [
            {
              type: 'send_message',
              message: {
                type: 'buttons',
                text: 'Oi {{nome}}',
                buttons: [{ id: 'b', title: '{{apelido}}' }],
              },
            },
          ],
          transitions: [],
        }),
      ),
    );
    expect(issues).toEqual([
      {
        path: ['states', 'a', 'on_enter', 0, 'message', 'buttons', 0, 'title'],
        message: expect.stringContaining('"apelido"'),
      },
    ]);
  });

  it('refuses an undeclared variable in a set_variable template value', () => {
    const issues = validateDefinitionForEngine(
      define(
        withState({
          transitions: [
            {
              condition: { type: 'any' },
              target: 'a',
              actions: [{ type: 'set_variable', name: 'nome', value: '{{sobrenome}}' }],
            },
          ],
        }),
      ),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      ['states', 'a', 'transitions', 0, 'actions', 0, 'value'],
    ]);
  });

  it('refuses a set_variable value of a different type and message text for a boolean', () => {
    const issues = validateDefinitionForEngine(
      define(
        withState({
          transitions: [],
          timeout: {
            after_seconds: 60,
            target: 'a',
            actions: [
              { type: 'set_variable', name: 'idade', value: '30' },
              { type: 'set_variable', name: 'ativo', from: 'message_text' },
              { type: 'set_variable', name: 'idade', from: 'message_text' },
            ],
          },
        }),
      ),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      ['states', 'a', 'timeout', 'actions', 0, 'value'],
      ['states', 'a', 'timeout', 'actions', 1, 'from'],
    ]);
  });

  it('refuses a variable condition that compares with a value of another type', () => {
    const issues = validateDefinitionForEngine(
      define(
        withState({
          transitions: [
            { condition: { type: 'variable', name: 'idade', equals: '3' }, target: 'a' },
          ],
        }),
      ),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      ['states', 'a', 'transitions', 0, 'condition', 'equals'],
    ]);
  });
});

describe('parseDefinitionForEngine', () => {
  it('returns the parsed definition with the defaults', () => {
    const result = parseDefinitionForEngine({
      initial_state: 'a',
      states: { a: { transitions: [] } },
    });
    expect(result).toEqual({
      success: true,
      definition: {
        initial_state: 'a',
        variables: {},
        states: { a: { on_enter: [], transitions: [], final: false } },
      },
    });
  });

  it('returns the contract issues first', () => {
    const result = parseDefinitionForEngine({
      initial_state: 'x',
      states: { a: { transitions: [] } },
    });
    expect(result).toEqual({
      success: false,
      issues: [{ path: ['initial_state'], message: 'State "x" does not exist' }],
    });
  });

  it('returns the engine issues of a definition that the contract accepts', () => {
    const result = parseDefinitionForEngine(
      withState({ transitions: [{ condition: { type: 'regex', pattern: '(?=a)' }, target: 'a' }] }),
    );
    expect(result.success).toBe(false);
  });
});
