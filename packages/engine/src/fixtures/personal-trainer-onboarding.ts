import type { BotDefinitionInput } from '@botcenter/contracts';

/** The URL that the `external` condition calls to see if the trainer has free slots. */
export const ONBOARDING_SLOTS_URL = 'https://api.personallife.com.br/bots/onboarding/vagas';
/** The URL that receives the result of the onboarding. */
export const ONBOARDING_WEBHOOK_URL =
  'https://api.personallife.com.br/webhooks/botcenter/onboarding';

const askAgain = (text: string) => ({
  type: 'send_message' as const,
  message: { type: 'text' as const, text },
});

/**
 * A real-life onboarding bot of a personal trainer (texts in pt-BR, the language of the product).
 * Flow: welcome, name, goal (list), days for each week, weight, confirmation, slot check (external
 * condition), and the end. It has reminders (timeouts), a handoff to the trainer, and re-prompts.
 * Tests of the engine and of the API use it.
 */
export const personalTrainerOnboarding: BotDefinitionInput = {
  initial_state: 'inicio',
  variables: { nome: '', objetivo: '', dias_semana: 0, peso_kg: 0 },
  states: {
    inicio: {
      on_enter: [
        {
          type: 'send_message',
          message: {
            type: 'buttons',
            text: 'Olá! Eu sou o assistente do seu personal trainer. Quer começar a sua avaliação inicial?',
            buttons: [
              { id: 'comecar', title: 'Começar' },
              { id: 'falar_personal', title: 'Falar com o personal' },
            ],
          },
        },
      ],
      transitions: [
        { condition: { type: 'button', id: 'comecar' }, target: 'pedir_nome' },
        { condition: { type: 'button', id: 'falar_personal' }, target: 'humano' },
        {
          condition: { type: 'text', equals: ['sim', 'quero', 'começar', 'bora'] },
          target: 'pedir_nome',
        },
        {
          condition: { type: 'text', equals: ['falar com o personal', 'humano', 'atendente'] },
          target: 'humano',
        },
        { condition: { type: 'any' }, target: 'inicio' },
      ],
      timeout: { after_seconds: 1800, target: 'lembrete' },
    },
    lembrete: {
      on_enter: [askAgain('Oi! Ainda quer começar a sua avaliação? É só tocar em *Começar*.')],
      transitions: [
        { condition: { type: 'button', id: 'comecar' }, target: 'pedir_nome' },
        { condition: { type: 'text', equals: ['sim', 'quero', 'começar'] }, target: 'pedir_nome' },
        { condition: { type: 'any' }, target: 'inicio' },
      ],
      timeout: { after_seconds: 86_400, target: 'sem_resposta' },
    },
    pedir_nome: {
      on_enter: [askAgain('Como você se chama?')],
      transitions: [
        {
          condition: { type: 'regex', pattern: "^\\p{L}[\\p{L} '.-]{1,59}$", flags: 'u' },
          target: 'pedir_objetivo',
          actions: [{ type: 'set_variable', name: 'nome', from: 'message_text' }],
        },
        {
          condition: { type: 'any' },
          target: 'pedir_nome',
          actions: [askAgain('Não entendi. Escreva só o seu nome, por favor.')],
        },
      ],
      timeout: { after_seconds: 3600, target: 'sem_resposta' },
    },
    pedir_objetivo: {
      on_enter: [
        {
          type: 'send_message',
          message: {
            type: 'list',
            text: 'Prazer, {{nome}}! Qual é o seu objetivo principal?',
            button_text: 'Ver objetivos',
            sections: [
              {
                title: 'Objetivos',
                rows: [
                  { id: 'emagrecimento', title: 'Emagrecer' },
                  { id: 'hipertrofia', title: 'Ganhar massa muscular' },
                  { id: 'condicionamento', title: 'Condicionamento físico' },
                  {
                    id: 'saude',
                    title: 'Saúde e bem-estar',
                    description: 'Dores, postura e qualidade de vida',
                  },
                ],
              },
            ],
          },
        },
      ],
      transitions: [
        ...(['emagrecimento', 'hipertrofia', 'condicionamento', 'saude'] as const).map((id) => ({
          condition: { type: 'button' as const, id },
          target: 'pedir_dias',
          actions: [{ type: 'set_variable' as const, name: 'objetivo', value: id }],
        })),
        {
          condition: { type: 'any' },
          target: 'pedir_objetivo',
          actions: [askAgain('Escolha uma opção da lista, por favor.')],
        },
      ],
      timeout: { after_seconds: 3600, target: 'sem_resposta' },
    },
    pedir_dias: {
      on_enter: [
        askAgain('Quantos dias por semana você pode treinar? Responda com um número de 1 a 7.'),
      ],
      transitions: [
        {
          condition: { type: 'regex', pattern: '^[1-7]$' },
          target: 'pedir_peso',
          actions: [{ type: 'set_variable', name: 'dias_semana', from: 'message_text' }],
        },
        {
          condition: { type: 'any' },
          target: 'pedir_dias',
          actions: [askAgain('Responda só com um número de 1 a 7.')],
        },
      ],
      timeout: { after_seconds: 3600, target: 'sem_resposta' },
    },
    pedir_peso: {
      on_enter: [askAgain('Qual é o seu peso atual em kg? Por exemplo: 72,5')],
      transitions: [
        {
          condition: { type: 'regex', pattern: '^\\d{2,3}([.,]\\d)?$' },
          target: 'confirmar',
          actions: [{ type: 'set_variable', name: 'peso_kg', from: 'message_text' }],
        },
        {
          condition: { type: 'any' },
          target: 'pedir_peso',
          actions: [askAgain('Não entendi. Escreva só o número, por exemplo: 72,5')],
        },
      ],
      timeout: { after_seconds: 3600, target: 'sem_resposta' },
    },
    confirmar: {
      on_enter: [
        {
          type: 'send_message',
          message: {
            type: 'buttons',
            text: 'Confira os seus dados:\nNome: {{nome}}\nObjetivo: {{objetivo}}\nDias por semana: {{dias_semana}}\nPeso: {{peso_kg}} kg',
            buttons: [
              { id: 'confirmar', title: 'Está certo' },
              { id: 'corrigir', title: 'Corrigir' },
            ],
            footer: 'Toque em uma opção',
          },
        },
      ],
      transitions: [
        {
          condition: { type: 'button', id: 'corrigir' },
          target: 'pedir_nome',
          actions: [askAgain('Sem problema, vamos começar de novo.')],
        },
        {
          condition: {
            type: 'external',
            url: ONBOARDING_SLOTS_URL,
            timeout_ms: 2000,
            expect: { path: '/agenda/aberta', equals: true },
          },
          target: 'concluido',
        },
        { condition: { type: 'any' }, target: 'lista_espera' },
      ],
      timeout: { after_seconds: 3600, target: 'sem_resposta' },
    },
    concluido: {
      final: true,
      transitions: [],
      on_enter: [
        askAgain(
          'Tudo certo, {{nome}}! O seu personal vai falar com você em breve para marcar a primeira aula. 💪',
        ),
        { type: 'call_webhook', url: ONBOARDING_WEBHOOK_URL },
      ],
    },
    lista_espera: {
      final: true,
      transitions: [],
      on_enter: [
        askAgain(
          'Obrigado, {{nome}}! A agenda está cheia agora. Você entrou na lista de espera e vamos avisar quando abrir uma vaga.',
        ),
        { type: 'call_webhook', url: ONBOARDING_WEBHOOK_URL },
      ],
    },
    humano: {
      on_enter: [
        askAgain('Certo! Vou chamar o seu personal. Ele responde em horário comercial.'),
        { type: 'handoff' },
      ],
      transitions: [],
    },
    sem_resposta: {
      final: true,
      transitions: [],
      on_enter: [askAgain('Vou encerrar por aqui. Quando quiser, é só mandar um oi! 👋')],
    },
  },
};
