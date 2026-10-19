import { Condition, type Condition as ConditionType } from '@botcenter/contracts';
import { describe, expect, it, vi } from 'vitest';
import { evaluateCondition, type ConditionContext } from './conditions.js';
import { ExternalCallError } from './errors.js';
import { messageText } from './text.js';
import { button, CONVERSATION_ID, listRow, text } from './test-helpers.js';
import type { ExternalCaller, InboundInput, Variables } from './types.js';

function context(
  input: InboundInput,
  options: { variables?: Variables; external?: ExternalCaller } = {},
): ConditionContext {
  return {
    conversationId: CONVERSATION_ID,
    state: 'start',
    input,
    text: messageText(input),
    variables: options.variables ?? {},
    ports: options.external === undefined ? {} : { external: options.external },
    diagnostics: [],
  };
}

async function evaluate(
  condition: unknown,
  input: InboundInput,
  options: { variables?: Variables; external?: ExternalCaller } = {},
) {
  const ctx = context(input, options);
  const matched = await evaluateCondition(Condition.parse(condition), ctx, ['c']);
  return { matched, diagnostics: ctx.diagnostics };
}

describe('text condition', () => {
  const loose = { type: 'text', equals: ['Não', 'sim'] };

  it.each([' NAO ', 'não', 'NÃO', 'não', 'Sim'])(
    'matches %j without case and accents',
    async (value) => {
      expect((await evaluate(loose, text(value))).matched).toBe(true);
    },
  );

  it('does not match a text that only contains a value', async () => {
    expect((await evaluate(loose, text('não sei'))).matched).toBe(false);
  });

  it('respects case and accents with case_sensitive: true, after trim and NFC', async () => {
    const strict = { type: 'text', equals: ['Não'], case_sensitive: true };
    expect((await evaluate(strict, text(' Não '))).matched).toBe(true);
    expect((await evaluate(strict, text('não'))).matched).toBe(false);
    expect((await evaluate(strict, text('Nao'))).matched).toBe(false);
  });

  it('uses the title of a button reply and the caption of a media message', async () => {
    expect((await evaluate(loose, button('b1', 'Sim'))).matched).toBe(true);
    const media: InboundInput = {
      type: 'media',
      mediaType: 'image',
      mimeType: 'image/png',
      caption: 'sim',
    };
    expect((await evaluate(loose, media)).matched).toBe(true);
  });

  it('does not match a message without text', async () => {
    expect(
      (await evaluate(loose, { type: 'unsupported', providerType: 'stickerMessage' })).matched,
    ).toBe(false);
  });
});

describe('button condition', () => {
  const condition = { type: 'button', id: 'yes' };

  it('matches a button reply or a list reply with the id', async () => {
    expect((await evaluate(condition, button('yes', 'Outro título'))).matched).toBe(true);
    expect((await evaluate(condition, listRow('yes'))).matched).toBe(true);
  });

  it('does not match another id, or a text equal to the id', async () => {
    expect((await evaluate(condition, button('no'))).matched).toBe(false);
    expect((await evaluate(condition, text('yes'))).matched).toBe(false);
  });
});

describe('regex condition', () => {
  it('matches with RE2 and the flags', async () => {
    const condition = { type: 'regex', pattern: '^n(ã|a)o$', flags: 'i' };
    expect((await evaluate(condition, text(' NÃO '))).matched).toBe(true);
    expect((await evaluate(condition, text('nãoo'))).matched).toBe(false);
  });

  it('is false for a message without text', async () => {
    const condition = { type: 'regex', pattern: '.*' };
    expect(
      (await evaluate(condition, { type: 'unsupported', providerType: 'pollMessage' })).matched,
    ).toBe(false);
  });

  it('is false with an error diagnostic for a pattern that RE2 refuses', async () => {
    // The contract accepts it (JavaScript syntax), but validateDefinitionForEngine refuses it.
    const result = await evaluate({ type: 'regex', pattern: '(a)\\1' }, text('aa'));
    expect(result.matched).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'regex_invalid', severity: 'error', path: ['c', 'pattern'] }),
    ]);
  });

  it('returns fast for a catastrophic pattern (ReDoS guard)', async () => {
    const started = performance.now();
    const result = await evaluate(
      { type: 'regex', pattern: '^(a+)+$' },
      text(`${'a'.repeat(4000)}!`),
    );
    expect(result.matched).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('variable condition', () => {
  it('uses strict equality without type conversion', async () => {
    const variables = { dias: 3, nome: '3', ativo: false };
    expect(
      (await evaluate({ type: 'variable', name: 'dias', equals: 3 }, text('x'), { variables }))
        .matched,
    ).toBe(true);
    expect(
      (await evaluate({ type: 'variable', name: 'nome', equals: 3 }, text('x'), { variables }))
        .matched,
    ).toBe(false);
    expect(
      (await evaluate({ type: 'variable', name: 'ativo', equals: false }, text('x'), { variables }))
        .matched,
    ).toBe(true);
    expect(
      (await evaluate({ type: 'variable', name: 'outra', equals: false }, text('x'), { variables }))
        .matched,
    ).toBe(false);
  });
});

describe('any condition', () => {
  it('matches every input', async () => {
    for (const input of [
      text('x'),
      button('b'),
      { type: 'unsupported', providerType: 'x' } as const,
    ]) {
      expect((await evaluate({ type: 'any' }, input)).matched).toBe(true);
    }
  });
});

describe('external condition', () => {
  const condition: ConditionType = Condition.parse({
    type: 'external',
    url: 'https://api.example.com/check',
    timeout_ms: 100,
    expect: { path: '/data/approved', equals: true },
  });

  function port(impl: ExternalCaller['call']): ExternalCaller & { call: ReturnType<typeof vi.fn> } {
    return { call: vi.fn(impl) };
  }

  it('calls the port with the context and matches the value at the pointer', async () => {
    const external = port(async () => ({ data: { approved: true } }));
    const variables = { nome: 'Ana' };
    const result = await evaluate(condition, text('oi'), { external, variables });
    expect(result.matched).toBe(true);
    expect(external.call).toHaveBeenCalledWith('https://api.example.com/check', {
      conversationId: CONVERSATION_ID,
      state: 'start',
      variables: { nome: 'Ana' },
      message: { type: 'text', text: 'oi' },
      timeoutMs: 100,
      signal: expect.any(AbortSignal),
    });
  });

  it('is false when the value is different (strict equality)', async () => {
    const external = port(async () => ({ data: { approved: 'true' } }));
    expect((await evaluate(condition, text('oi'), { external })).matched).toBe(false);
  });

  it('is false with an info diagnostic when the pointer finds nothing', async () => {
    const external = port(async () => ({ data: {} }));
    const result = await evaluate(condition, text('oi'), { external });
    expect(result.matched).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'external_value_missing', severity: 'info' }),
    ]);
  });

  it('matches a null value with equals: null', async () => {
    const nullCondition = Condition.parse({
      type: 'external',
      url: 'https://api.example.com/check',
      expect: { path: '/value', equals: null },
    });
    const external = port(async () => ({ value: null }));
    expect((await evaluate(nullCondition, text('oi'), { external })).matched).toBe(true);
  });

  it.each([
    [new ExternalCallError('http_status', 'Service answered 503', 503), /http_status \(HTTP 503\)/],
    [new ExternalCallError('invalid_json', 'Body is not JSON'), /invalid_json/],
    [new ExternalCallError('blocked', 'Private address'), /blocked/],
    [new ExternalCallError('network', 'ECONNREFUSED'), /network/],
  ])('is false with a warning when the port throws %s', async (error, pattern) => {
    const external = port(async () => {
      throw error;
    });
    const result = await evaluate(condition, text('oi'), { external });
    expect(result.matched).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'external_call_failed',
        severity: 'warning',
        message: expect.stringMatching(pattern),
        path: ['c'],
      }),
    ]);
  });

  it('reports an unexpected port error with severity error and does not throw', async () => {
    const external = port(() => {
      throw new TypeError('bug in the port');
    });
    const result = await evaluate(condition, text('oi'), { external });
    expect(result.matched).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'external_call_failed',
        severity: 'error',
        message: expect.stringContaining('TypeError: bug in the port'),
      }),
    ]);
  });

  it('stops the wait at timeout_ms when the port does not answer', async () => {
    let signal: AbortSignal | undefined;
    const external = port((_url, request) => {
      signal = request.signal;
      return new Promise(() => undefined);
    });
    const started = performance.now();
    const result = await evaluate(condition, text('oi'), { external });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.matched).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'external_call_failed',
        message: expect.stringContaining('timeout'),
      }),
    ]);
  });

  it('is false with an error when there is no port', async () => {
    const result = await evaluate(condition, text('oi'));
    expect(result.matched).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'external_port_missing', severity: 'error' }),
    ]);
  });
});
