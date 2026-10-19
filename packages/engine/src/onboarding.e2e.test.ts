import { describe, expect, it, vi } from 'vitest';
import { handleInbound, handleTimeout, startConversation } from './engine.js';
import { ExternalCallError } from './errors.js';
import {
  ONBOARDING_SLOTS_URL,
  ONBOARDING_WEBHOOK_URL,
  personalTrainerOnboarding,
} from './fixtures/personal-trainer-onboarding.js';
import {
  after,
  button,
  CONVERSATION_ID,
  define,
  listRow,
  NOW,
  sentTexts,
  text,
} from './test-helpers.js';
import type { ConversationSnapshot, EngineResult, ExternalCaller, InboundInput } from './types.js';
import { validateDefinitionForEngine } from './validate.js';

const definition = define(personalTrainerOnboarding);

/** Plays the role of the conversations slice: it stores each result and moves the clock. */
class Conversation {
  snapshot: ConversationSnapshot;
  now = NOW;
  readonly log: EngineResult[] = [];

  constructor(private readonly external: ExternalCaller) {
    const result = startConversation(definition, {
      conversationId: CONVERSATION_ID,
      now: this.now,
    });
    this.snapshot = after(result);
    this.log.push(result);
  }

  async send(input: InboundInput): Promise<EngineResult> {
    const result = await handleInbound(definition, this.snapshot, input, {
      now: this.now,
      external: this.external,
    });
    this.store(result);
    return result;
  }

  fire(timer: NonNullable<EngineResult['timer']>): EngineResult {
    this.now = timer.fireAt;
    const result = handleTimeout(definition, this.snapshot, {
      timerState: timer.state,
      timerVersion: timer.version,
      now: this.now,
    });
    this.store(result);
    return result;
  }

  private store(result: EngineResult): void {
    if (result.persist) {
      this.snapshot = after(result);
    }
    this.log.push(result);
  }
}

function slots(open: boolean): ExternalCaller & { call: ReturnType<typeof vi.fn> } {
  return { call: vi.fn(async () => ({ agenda: { aberta: open } })) };
}

describe('personal trainer onboarding (end to end)', () => {
  it('is a valid definition for the engine', () => {
    expect(validateDefinitionForEngine(definition)).toEqual([]);
  });

  it('completes the happy path and sends the result to the trainer', async () => {
    const external = slots(true);
    const chat = new Conversation(external);
    expect(chat.log[0]?.actions[0]).toMatchObject({
      type: 'send_message',
      message: { type: 'buttons', buttons: [{ id: 'comecar' }, { id: 'falar_personal' }] },
    });

    expect(sentTexts(await chat.send(button('comecar', 'Começar')))).toEqual([
      'Como você se chama?',
    ]);

    const goal = await chat.send(text('  Ana Souza '));
    expect(goal.toState).toBe('pedir_objetivo');
    expect(goal.actions).toEqual([
      { type: 'set_variable', name: 'nome', value: 'Ana Souza' },
      {
        type: 'send_message',
        message: expect.objectContaining({
          type: 'list',
          text: 'Prazer, Ana Souza! Qual é o seu objetivo principal?',
        }),
      },
    ]);

    expect((await chat.send(listRow('hipertrofia', 'Ganhar massa muscular'))).toState).toBe(
      'pedir_dias',
    );

    const wrongDays = await chat.send(text('todos'));
    expect(wrongDays).toMatchObject({
      matched: true,
      fromState: 'pedir_dias',
      toState: 'pedir_dias',
    });
    // The transition actions come before the on_enter actions of the target.
    expect(sentTexts(wrongDays)).toEqual([
      'Responda só com um número de 1 a 7.',
      'Quantos dias por semana você pode treinar? Responda com um número de 1 a 7.',
    ]);

    expect((await chat.send(text('4'))).toState).toBe('pedir_peso');

    const confirm = await chat.send(text('68,5'));
    expect(confirm.toState).toBe('confirmar');
    expect(confirm.variables).toEqual({
      nome: 'Ana Souza',
      objetivo: 'hipertrofia',
      dias_semana: 4,
      peso_kg: 68.5,
    });
    expect(confirm.actions[1]).toMatchObject({
      type: 'send_message',
      message: {
        text: 'Confira os seus dados:\nNome: Ana Souza\nObjetivo: hipertrofia\nDias por semana: 4\nPeso: 68.5 kg',
      },
    });

    const done = await chat.send(button('confirmar', 'Está certo'));
    expect(done).toMatchObject({ toState: 'concluido', ended: true, timer: null });
    expect(external.call).toHaveBeenCalledTimes(1);
    expect(external.call.mock.calls[0]?.[0]).toBe(ONBOARDING_SLOTS_URL);
    expect(done.actions).toEqual([
      {
        type: 'send_message',
        message: {
          type: 'text',
          text: 'Tudo certo, Ana Souza! O seu personal vai falar com você em breve para marcar a primeira aula. 💪',
        },
      },
      { type: 'call_webhook', url: ONBOARDING_WEBHOOK_URL, variables: confirm.variables },
    ]);

    // Every step had no warning and no error.
    const problems = chat.log.flatMap((result) =>
      result.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info'),
    );
    expect(problems).toEqual([]);
  });

  it('puts the client on the waiting list when the external call fails', async () => {
    const external: ExternalCaller = {
      call: async () => {
        throw new ExternalCallError('timeout', 'No response in 2000 ms');
      },
    };
    const chat = new Conversation(external);
    await chat.send(text('sim'));
    await chat.send(text('Bruno'));
    await chat.send(listRow('saude'));
    await chat.send(text('3'));
    await chat.send(text('90'));
    const result = await chat.send(button('confirmar'));
    expect(result).toMatchObject({ toState: 'lista_espera', ended: true, transitionIndex: 2 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'external_call_failed', severity: 'warning' }),
    ]);
  });

  it('lets the client correct the data', async () => {
    const chat = new Conversation(slots(true));
    for (const input of [text('quero'), text('Carla'), listRow('saude'), text('2'), text('55')]) {
      await chat.send(input);
    }
    const result = await chat.send(button('corrigir', 'Corrigir'));
    expect(result.toState).toBe('pedir_nome');
    expect(sentTexts(result)).toEqual([
      'Sem problema, vamos começar de novo.',
      'Como você se chama?',
    ]);
  });

  it('hands the conversation to the trainer', async () => {
    const chat = new Conversation(slots(true));
    const result = await chat.send(text('Falar com o PERSONAL'));
    expect(result).toMatchObject({ toState: 'humano', handoff: true, timer: null });
    expect(result.actions.at(-1)).toEqual({ type: 'handoff' });
  });

  it('sends a reminder after 30 minutes and ends after one more day without an answer', () => {
    const chat = new Conversation(slots(true));
    const firstTimer = chat.log[0]?.timer;
    expect(firstTimer).toMatchObject({
      state: 'inicio',
      fireAt: new Date('2026-10-19T12:30:00.000Z'),
    });

    const reminder = chat.fire(firstTimer!);
    expect(reminder).toMatchObject({ trigger: 'timeout', toState: 'lembrete' });
    expect(sentTexts(reminder)).toEqual([
      'Oi! Ainda quer começar a sua avaliação? É só tocar em *Começar*.',
    ]);
    expect(reminder.timer?.fireAt).toEqual(new Date('2026-10-20T12:30:00.000Z'));

    const end = chat.fire(reminder.timer!);
    expect(end).toMatchObject({ toState: 'sem_resposta', ended: true, timer: null });
  });

  it('ignores the old timer after the client answers', async () => {
    const chat = new Conversation(slots(true));
    const oldTimer = chat.log[0]!.timer!;
    const answer = await chat.send(text('oi'));
    // "oi" matches only `any`: the bot re-enters "inicio" and arms a new timer.
    expect(answer).toMatchObject({ toState: 'inicio', cancelTimer: { jobId: oldTimer.jobId } });

    const stale = chat.fire(oldTimer);
    expect(stale).toMatchObject({ persist: false, matched: false, toState: 'inicio' });
  });
});
