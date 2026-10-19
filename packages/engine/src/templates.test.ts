import {
  BUTTON_TITLE_MAX_LENGTH,
  TEXT_MAX_LENGTH,
  type BotMessageContent,
} from '@botcenter/contracts';
import { describe, expect, it } from 'vitest';
import { renderMessage, renderTemplate, truncate } from './templates.js';
import type { Diagnostic } from './types.js';

describe('renderTemplate', () => {
  it('renders strings, numbers, and booleans, with and without spaces in the braces', () => {
    const diagnostics: Diagnostic[] = [];
    const out = renderTemplate(
      'Olá {{nome}}, {{ dias }} dias, ativo: {{ativo}}',
      { nome: 'Ana', dias: 4, ativo: true },
      diagnostics,
      ['t'],
    );
    expect(out).toBe('Olá Ana, 4 dias, ativo: true');
    expect(diagnostics).toEqual([]);
  });

  it('renders an unknown variable as an empty text and reports it', () => {
    const diagnostics: Diagnostic[] = [];
    expect(renderTemplate('Olá {{quem}}!', {}, diagnostics, ['p'])).toBe('Olá !');
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'template_variable_unknown', path: ['p'] }),
    ]);
  });

  it('does not expand a template inside a value (one pass)', () => {
    const diagnostics: Diagnostic[] = [];
    expect(
      renderTemplate('Nome: {{nome}}', { nome: '{{segredo}}', segredo: 'x' }, diagnostics, []),
    ).toBe('Nome: {{segredo}}');
  });

  it('does not escape anything (WhatsApp text is plain text)', () => {
    expect(renderTemplate('{{v}}', { v: '<b>*oi*</b> & $1' }, [], [])).toBe('<b>*oi*</b> & $1');
  });

  it('leaves text that is not a template', () => {
    expect(renderTemplate('{nome} {{1x}} {{ }}', { nome: 'Ana' }, [], [])).toBe(
      '{nome} {{1x}} {{ }}',
    );
  });
});

describe('truncate', () => {
  it('cuts to the limit and reports it', () => {
    const diagnostics: Diagnostic[] = [];
    expect(truncate('abcdef', 4, diagnostics, ['x'])).toBe('abcd');
    expect(diagnostics[0]).toMatchObject({ code: 'value_truncated', path: ['x'] });
  });

  it('does not cut a surrogate pair', () => {
    const value = `ab${'💪'}`; // length 4: "a", "b", and two code units.
    expect(truncate(value, 3, [], [])).toBe('ab');
  });

  it('keeps a text at the limit', () => {
    const diagnostics: Diagnostic[] = [];
    expect(truncate('abcd', 4, diagnostics, [])).toBe('abcd');
    expect(diagnostics).toEqual([]);
  });
});

describe('renderMessage', () => {
  it('renders every text field of a buttons message and keeps the ids', () => {
    const message: BotMessageContent = {
      type: 'buttons',
      text: 'Oi {{nome}}',
      buttons: [{ id: 'id_{{nome}}', title: 'Sou {{nome}}' }],
      footer: 'para {{nome}}',
    };
    expect(renderMessage(message, { nome: 'Ana' }, [], [])).toEqual({
      type: 'buttons',
      text: 'Oi Ana',
      buttons: [{ id: 'id_{{nome}}', title: 'Sou Ana' }],
      footer: 'para Ana',
    });
  });

  it('renders a list message and its rows', () => {
    const message: BotMessageContent = {
      type: 'list',
      text: 'Escolha, {{nome}}',
      button_text: 'Ver',
      sections: [
        {
          title: 'Seção {{n}}',
          rows: [{ id: 'r1', title: 'Linha {{n}}', description: '{{nome}}' }],
        },
      ],
    };
    expect(renderMessage(message, { nome: 'Ana', n: 1 }, [], [])).toEqual({
      type: 'list',
      text: 'Escolha, Ana',
      button_text: 'Ver',
      sections: [{ title: 'Seção 1', rows: [{ id: 'r1', title: 'Linha 1', description: 'Ana' }] }],
    });
  });

  it('renders the caption of a media message and does not render the URL', () => {
    const message: BotMessageContent = {
      type: 'media',
      media_type: 'image',
      url: 'https://cdn.example.com/treino.png',
      caption: 'Treino de {{nome}}',
    };
    expect(renderMessage(message, { nome: 'Ana' }, [], [])).toEqual({
      type: 'media',
      media_type: 'image',
      url: 'https://cdn.example.com/treino.png',
      caption: 'Treino de Ana',
    });
  });

  it('cuts each field to its WhatsApp limit', () => {
    const diagnostics: Diagnostic[] = [];
    const long = 'x'.repeat(TEXT_MAX_LENGTH);
    const rendered = renderMessage(
      {
        type: 'buttons',
        text: 'ok',
        buttons: [{ id: 'b', title: '{{v}}' }],
      },
      { v: long },
      diagnostics,
      ['m'],
    );
    expect(rendered?.type === 'buttons' && rendered.buttons[0]?.title.length).toBe(
      BUTTON_TITLE_MAX_LENGTH,
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'value_truncated', path: ['m', 'buttons', 0, 'title'] }),
    ]);

    const text = renderMessage({ type: 'text', text: 'a{{v}}' }, { v: long }, [], []);
    expect(text?.type === 'text' && text.text.length).toBe(TEXT_MAX_LENGTH);
  });

  it('drops a message that is empty after the render and reports an error', () => {
    const diagnostics: Diagnostic[] = [];
    expect(
      renderMessage({ type: 'text', text: '{{nome}}' }, { nome: '  ' }, diagnostics, ['m']),
    ).toBe(null);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'message_invalid', severity: 'error', path: ['m'] }),
    ]);
  });
});
