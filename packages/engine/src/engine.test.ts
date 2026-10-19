import { describe, expect, it } from 'vitest';
import { handleInbound, handleTimeout, startConversation } from './engine.js';
import { EngineStateError } from './errors.js';
import {
  after,
  button,
  CONVERSATION_ID,
  define,
  NOW,
  sentTexts,
  snapshot,
  text,
} from './test-helpers.js';
import { timerJobId } from './timers.js';

const say = (value: string) => ({
  type: 'send_message' as const,
  message: { type: 'text' as const, text: value },
});

const definition = define({
  initial_state: 'menu',
  variables: { nome: '', visitas: 0 },
  states: {
    menu: {
      on_enter: [say('Menu, {{nome}}')],
      transitions: [
        {
          condition: { type: 'button', id: 'perfil' },
          target: 'perfil',
          actions: [
            say('Indo para o perfil'),
            { type: 'set_variable', name: 'nome', value: 'Ana' },
          ],
        },
        {
          condition: { type: 'text', equals: ['de novo'] },
          target: 'menu',
          actions: [{ type: 'set_variable', name: 'visitas', value: 1 }],
        },
        { condition: { type: 'text', equals: ['tchau'] }, target: 'fim' },
        { condition: { type: 'text', equals: ['humano'] }, target: 'humano' },
      ],
      timeout: {
        after_seconds: 60,
        target: 'lembrete',
        actions: [say('Tempo esgotado em {{nome}}')],
      },
    },
    perfil: {
      on_enter: [say('Perfil de {{nome}}')],
      transitions: [{ condition: { type: 'any' }, target: 'menu' }],
    },
    lembrete: {
      on_enter: [say('Ainda está aí?')],
      transitions: [{ condition: { type: 'any' }, target: 'menu' }],
      timeout: { after_seconds: 120, target: 'lembrete' },
    },
    humano: {
      on_enter: [{ type: 'handoff' }, say('Um humano vai responder')],
      transitions: [{ condition: { type: 'any' }, target: 'menu' }],
      timeout: { after_seconds: 60, target: 'menu' },
    },
    fim: { on_enter: [say('Tchau, {{nome}}')], transitions: [], final: true },
  },
});

const inbound = (
  state: string,
  input = text('x'),
  version = 5,
  variables = { nome: 'Bia', visitas: 0 },
) => handleInbound(definition, snapshot(state, variables, version), input, { now: NOW });

describe('startConversation', () => {
  it('enters the initial state with the default variables, on_enter actions, and the timer', () => {
    const result = startConversation(definition, { conversationId: CONVERSATION_ID, now: NOW });
    expect(result).toEqual({
      trigger: 'start',
      matched: true,
      persist: true,
      fromState: null,
      toState: 'menu',
      transitionIndex: null,
      ended: false,
      handoff: false,
      version: 0,
      variables: { nome: '', visitas: 0 },
      actions: [{ type: 'send_message', message: { type: 'text', text: 'Menu, ' } }],
      timer: {
        state: 'menu',
        version: 0,
        jobId: timerJobId(CONVERSATION_ID, 0),
        fireAt: new Date(NOW.getTime() + 60_000),
      },
      cancelTimer: null,
      diagnostics: [],
    });
  });

  it('increments the version of an existing row (a restart after a final state)', () => {
    const result = startConversation(definition, {
      conversationId: CONVERSATION_ID,
      now: NOW,
      version: 7,
    });
    expect(result.version).toBe(8);
    expect(result.timer?.jobId).toBe(timerJobId(CONVERSATION_ID, 8));
  });

  it('ends at once when the initial state is final', () => {
    const only = define({ initial_state: 'x', states: { x: { transitions: [], final: true } } });
    const result = startConversation(only, { conversationId: CONVERSATION_ID, now: NOW });
    expect(result).toMatchObject({ ended: true, timer: null });
  });
});

describe('handleInbound: transitions', () => {
  it('uses the first true condition, then runs the transition actions and on_enter in order', async () => {
    const result = await inbound('menu', button('perfil'));
    expect(result).toMatchObject({
      trigger: 'message',
      matched: true,
      persist: true,
      fromState: 'menu',
      toState: 'perfil',
      transitionIndex: 0,
      ended: false,
      version: 6,
      variables: { nome: 'Ana', visitas: 0 },
      timer: null,
      cancelTimer: { state: 'menu', jobId: timerJobId(CONVERSATION_ID, 5) },
    });
    expect(sentTexts(result)).toEqual(['Indo para o perfil', 'Perfil de Ana']);
  });

  it('keeps the state and gives no actions when no transition matches', async () => {
    const result = await inbound('menu', text('outra coisa'));
    expect(result).toMatchObject({
      matched: false,
      fromState: 'menu',
      toState: 'menu',
      transitionIndex: null,
      actions: [],
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'no_transition_matched', severity: 'info' }),
    ]);
  });

  it('restarts the timer on a message that matches nothing (the timeout means "no message")', async () => {
    const result = await inbound('menu', text('outra coisa'));
    expect(result).toMatchObject({
      persist: true,
      version: 6,
      cancelTimer: { state: 'menu', jobId: timerJobId(CONVERSATION_ID, 5) },
      timer: {
        state: 'menu',
        version: 6,
        jobId: timerJobId(CONVERSATION_ID, 6),
        fireAt: new Date(NOW.getTime() + 60_000),
      },
    });
  });

  it('does not ask for a write when nothing changed in a state without a timeout', async () => {
    const result = await inbound('perfil', { type: 'unsupported', providerType: 'x' }, 9);
    expect(result.matched).toBe(true);

    const noMatch = define({
      initial_state: 'a',
      states: { a: { transitions: [{ condition: { type: 'button', id: 'b' }, target: 'a' }] } },
    });
    const stay = await handleInbound(noMatch, snapshot('a', {}, 9), text('x'), { now: NOW });
    expect(stay).toMatchObject({
      matched: false,
      persist: false,
      version: 9,
      timer: null,
      cancelTimer: null,
    });
  });

  it('re-enters the same state: on_enter again and a new timer id', async () => {
    const result = await inbound('menu', text('De Novo'), 5);
    expect(result).toMatchObject({
      matched: true,
      fromState: 'menu',
      toState: 'menu',
      transitionIndex: 1,
      variables: { visitas: 1 },
      cancelTimer: { state: 'menu', jobId: timerJobId(CONVERSATION_ID, 5) },
      timer: { state: 'menu', jobId: timerJobId(CONVERSATION_ID, 6) },
    });
    expect(sentTexts(result)).toEqual(['Menu, Bia']);
  });

  it('ends the conversation on a final target: on_enter runs and there is no timer', async () => {
    const result = await inbound('menu', text('tchau'));
    expect(result).toMatchObject({ toState: 'fim', ended: true, timer: null });
    expect(sentTexts(result)).toEqual(['Tchau, Bia']);
  });

  it('gives no transition in a final state and asks for no write', async () => {
    const result = await inbound('fim', text('oi'));
    expect(result).toMatchObject({
      matched: false,
      ended: true,
      persist: false,
      version: 5,
      actions: [],
    });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'conversation_ended' })]);
  });

  it('keeps all actions after a handoff, sets handoff, and arms no timer', async () => {
    const result = await inbound('menu', text('humano'));
    expect(result).toMatchObject({ toState: 'humano', handoff: true, timer: null });
    expect(result.actions.map((action) => action.type)).toEqual(['handoff', 'send_message']);
  });

  it('does not change the snapshot object', async () => {
    const before = snapshot('menu', { nome: 'Bia', visitas: 0 }, 5);
    const copy = structuredClone(before);
    await handleInbound(definition, before, button('perfil'), { now: NOW });
    expect(before).toEqual(copy);
  });

  it('throws EngineStateError for a state that the definition does not have', async () => {
    await expect(inbound('removido')).rejects.toBeInstanceOf(EngineStateError);
  });
});

describe('handleInbound: stored variables', () => {
  it('resets a value of the wrong type, removes an undeclared key, and adds a missing one', async () => {
    const result = await handleInbound(
      definition,
      snapshot('perfil', { nome: 42, antiga: 'x' } as never, 3),
      text('x'),
      { now: NOW },
    );
    expect(result.variables).toEqual({ nome: '', visitas: 0 });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'variable_reset',
      'variable_dropped',
    ]);
  });

  it('asks for a write when only the variables changed', async () => {
    const noTimer = define({
      initial_state: 'a',
      variables: { n: 0 },
      states: { a: { transitions: [{ condition: { type: 'button', id: 'b' }, target: 'a' }] } },
    });
    const result = await handleInbound(noTimer, snapshot('a', {}, 2), text('x'), { now: NOW });
    expect(result).toMatchObject({
      matched: false,
      persist: true,
      version: 3,
      variables: { n: 0 },
    });
  });
});

describe('handleTimeout', () => {
  it('applies a fresh timer: timeout actions, then on_enter of the target, then a new timer', () => {
    const result = handleTimeout(definition, snapshot('menu', { nome: 'Bia', visitas: 0 }, 5), {
      timerState: 'menu',
      timerVersion: 5,
      now: NOW,
    });
    expect(result).toMatchObject({
      trigger: 'timeout',
      matched: true,
      persist: true,
      fromState: 'menu',
      toState: 'lembrete',
      transitionIndex: null,
      version: 6,
      cancelTimer: null,
      timer: {
        state: 'lembrete',
        version: 6,
        jobId: timerJobId(CONVERSATION_ID, 6),
        fireAt: new Date(NOW.getTime() + 120_000),
      },
    });
    expect(sentTexts(result)).toEqual(['Tempo esgotado em Bia', 'Ainda está aí?']);
  });

  it('re-enters on a timeout to the same state with a new timer id each time', () => {
    const first = handleTimeout(definition, snapshot('lembrete', {}, 10), {
      timerState: 'lembrete',
      timerVersion: 10,
      now: NOW,
    });
    const second = handleTimeout(definition, after(first), {
      timerState: 'lembrete',
      timerVersion: first.version,
      now: NOW,
    });
    expect(first.toState).toBe('lembrete');
    expect(second.toState).toBe('lembrete');
    expect(first.timer?.jobId).not.toBe(second.timer?.jobId);
  });

  it.each([
    ['another state', 'perfil', 5],
    ['the same state after a re-entry (other version)', 'menu', 6],
  ])('is a no-op for a stale timer: %s', (_name, state, version) => {
    const result = handleTimeout(
      definition,
      snapshot(state, { nome: 'Bia', visitas: 0 }, version),
      {
        timerState: 'menu',
        timerVersion: 5,
        now: NOW,
      },
    );
    expect(result).toMatchObject({
      trigger: 'timeout',
      matched: false,
      persist: false,
      fromState: state,
      toState: state,
      version,
      actions: [],
      timer: null,
      cancelTimer: null,
    });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'timer_stale' })]);
  });

  it('is a no-op for a state without a timeout', () => {
    const result = handleTimeout(definition, snapshot('perfil', {}, 5), {
      timerState: 'perfil',
      timerVersion: 5,
      now: NOW,
    });
    expect(result).toMatchObject({ matched: false, persist: false });
  });

  it('does not arm a timer when the target hands the conversation to a human', () => {
    const humanTimeout = define({
      initial_state: 'a',
      states: {
        a: { transitions: [], timeout: { after_seconds: 10, target: 'h' } },
        h: {
          on_enter: [{ type: 'handoff' }],
          transitions: [],
          timeout: { after_seconds: 10, target: 'a' },
        },
      },
    });
    const result = handleTimeout(humanTimeout, snapshot('a', {}, 1), {
      timerState: 'a',
      timerVersion: 1,
      now: NOW,
    });
    expect(result).toMatchObject({ toState: 'h', handoff: true, timer: null });
  });
});

describe('timers across steps', () => {
  it('gives a new job id for each entry and cancels the id of the previous write', async () => {
    const start = startConversation(definition, { conversationId: CONVERSATION_ID, now: NOW });
    const toProfile = await handleInbound(definition, after(start), button('perfil'), { now: NOW });
    const backToMenu = await handleInbound(definition, after(toProfile), text('x'), { now: NOW });
    expect(toProfile.cancelTimer?.jobId).toBe(start.timer?.jobId);
    expect(backToMenu.timer?.jobId).not.toBe(start.timer?.jobId);

    // The first timer of "menu" fires late: it is stale, because the version changed.
    const late = handleTimeout(definition, after(backToMenu), {
      timerState: 'menu',
      timerVersion: start.version,
      now: NOW,
    });
    expect(late.persist).toBe(false);
  });
});
