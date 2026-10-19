import { Action, VARIABLE_STRING_MAX_LENGTH } from '@botcenter/contracts';
import { describe, expect, it } from 'vitest';
import { applyActions } from './actions.js';
import { define } from './test-helpers.js';
import type { Diagnostic } from './types.js';

const definition = define({
  initial_state: 'a',
  variables: { nome: '', idade: 0, peso: 0, ativo: false },
  states: { a: { transitions: [] } },
});

function run(
  actions: unknown[],
  text: string | null = null,
  variables = { ...definition.variables },
) {
  const diagnostics: Diagnostic[] = [];
  const result = applyActions(
    actions.map((action) => Action.parse(action)),
    { definition, variables, text, diagnostics },
    ['actions'],
  );
  return { result, variables, diagnostics };
}

describe('applyActions: order', () => {
  it('applies set_variable at its position: a later template sees the new value', () => {
    const { result, variables } = run([
      { type: 'send_message', message: { type: 'text', text: 'Antes: [{{nome}}]' } },
      { type: 'set_variable', name: 'nome', value: 'Ana' },
      { type: 'send_message', message: { type: 'text', text: 'Depois: [{{nome}}]' } },
      { type: 'call_webhook', url: 'https://hooks.example.com/a' },
      { type: 'set_variable', name: 'nome', value: '{{nome}} Souza' },
      { type: 'handoff' },
    ]);
    expect(result).toEqual([
      { type: 'send_message', message: { type: 'text', text: 'Antes: []' } },
      { type: 'set_variable', name: 'nome', value: 'Ana' },
      { type: 'send_message', message: { type: 'text', text: 'Depois: [Ana]' } },
      {
        type: 'call_webhook',
        url: 'https://hooks.example.com/a',
        variables: { nome: 'Ana', idade: 0, peso: 0, ativo: false },
      },
      { type: 'set_variable', name: 'nome', value: 'Ana Souza' },
      { type: 'handoff' },
    ]);
    expect(variables.nome).toBe('Ana Souza');
  });

  it('gives call_webhook a copy of the variables, not a reference', () => {
    const { result } = run([
      { type: 'call_webhook', url: 'https://hooks.example.com/a' },
      { type: 'set_variable', name: 'ativo', value: true },
    ]);
    expect(result[0]).toMatchObject({ variables: { ativo: false } });
  });
});

describe('applyActions: set_variable', () => {
  it('sets fixed values of each type', () => {
    const { variables } = run([
      { type: 'set_variable', name: 'idade', value: 30 },
      { type: 'set_variable', name: 'ativo', value: true },
    ]);
    expect(variables).toMatchObject({ idade: 30, ativo: true });
  });

  it('takes the message text for a string variable and cuts it to the limit', () => {
    const { variables, diagnostics } = run(
      [{ type: 'set_variable', name: 'nome', from: 'message_text' }],
      'x'.repeat(VARIABLE_STRING_MAX_LENGTH + 10),
    );
    expect((variables.nome as string).length).toBe(VARIABLE_STRING_MAX_LENGTH);
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'value_truncated' })]);
  });

  it.each([
    ['72,5', 72.5],
    ['72.5', 72.5],
    ['-3', -3],
    ['+80', 80],
  ])('converts the message text %j for a number variable', (text, expected) => {
    expect(
      run([{ type: 'set_variable', name: 'peso', from: 'message_text' }], text).variables.peso,
    ).toBe(expected);
  });

  it.each(['abc', '1e3', '72,5 kg', '1.000,50', ''])(
    'keeps the number variable when the message text %j is not a number',
    (text) => {
      const { variables, diagnostics, result } = run(
        [{ type: 'set_variable', name: 'peso', from: 'message_text' }],
        text,
        { ...definition.variables, peso: 60 },
      );
      expect(variables.peso).toBe(60);
      expect(result).toEqual([]);
      expect(diagnostics).toEqual([
        expect.objectContaining({ code: 'variable_type_mismatch', severity: 'info' }),
      ]);
    },
  );

  it('refuses the message text for a boolean variable', () => {
    const { variables, diagnostics } = run(
      [{ type: 'set_variable', name: 'ativo', from: 'message_text' }],
      'true',
    );
    expect(variables.ativo).toBe(false);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'variable_type_mismatch', severity: 'warning' }),
    ]);
  });

  it('refuses a value of a different type than the declared type', () => {
    const { variables, diagnostics } = run([{ type: 'set_variable', name: 'idade', value: '30' }]);
    expect(variables.idade).toBe(0);
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'variable_type_mismatch' })]);
  });

  it('keeps the value when there is no message text (timeout or media without caption)', () => {
    const { variables, diagnostics } = run(
      [{ type: 'set_variable', name: 'nome', from: 'message_text' }],
      null,
      { ...definition.variables, nome: 'Ana' },
    );
    expect(variables.nome).toBe('Ana');
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'message_text_missing' })]);
  });

  it('skips a variable that is not declared', () => {
    const { result, diagnostics } = run([{ type: 'set_variable', name: 'outra', value: 'x' }]);
    expect(result).toEqual([]);
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'variable_type_mismatch' })]);
  });
});

describe('applyActions: send_message', () => {
  it('drops a message that is not valid after the render and continues', () => {
    const { result, diagnostics } = run([
      { type: 'send_message', message: { type: 'text', text: '{{nome}}' } },
      { type: 'handoff' },
    ]);
    expect(result).toEqual([{ type: 'handoff' }]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'message_invalid', path: ['actions', 0, 'message'] }),
    ]);
  });
});
