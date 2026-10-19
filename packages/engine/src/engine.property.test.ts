import type { BotDefinitionInput, VariableValue } from '@botcenter/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { handleInbound, handleTimeout, startConversation } from './engine.js';
import { after, CONVERSATION_ID, define, NOW } from './test-helpers.js';
import type { EngineResult, ExternalCaller, InboundInput } from './types.js';
import { valueType } from './variables.js';

type StateInput = BotDefinitionInput['states'][string];
type TransitionInput = StateInput['transitions'][number];
type ConditionInput = TransitionInput['condition'];
type ActionInput = NonNullable<StateInput['on_enter']>[number];

const WORDS = ['sim', 'Não', 'oi', '1', '72,5', 'Ana', ''];
const IDS = ['a', 'b', 'c'];
const PATTERNS = ['^\\d+$', '^s', 'a|b', '^(a+)+$', '^\\p{L}+$'];

const variableArb = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
);

/** A deterministic external service: it approves an even text length. */
const external: ExternalCaller = {
  call: async (_url, request) => {
    const length = request.message.type === 'text' ? request.message.text.length : 1;
    if (length === 3) {
      throw new Error('service failure');
    }
    return { ok: length % 2 === 0 };
  },
};

function conditionArb(variables: Record<string, VariableValue>): fc.Arbitrary<ConditionInput> {
  const names = Object.keys(variables);
  const options: fc.Arbitrary<ConditionInput>[] = [
    fc.record({
      type: fc.constant('text' as const),
      equals: fc.subarray(
        WORDS.filter((word) => word !== ''),
        { minLength: 1 },
      ),
      case_sensitive: fc.boolean(),
    }),
    fc.record({ type: fc.constant('button' as const), id: fc.constantFrom(...IDS) }),
    fc.record({
      type: fc.constant('regex' as const),
      pattern: fc.constantFrom(...PATTERNS),
      flags: fc.constantFrom('', 'i', 'u'),
    }),
    fc.constant({
      type: 'external' as const,
      url: 'https://api.example.com/check',
      timeout_ms: 100,
      expect: { path: '/ok', equals: true },
    }),
  ];
  if (names.length > 0) {
    options.push(
      fc.constantFrom(...names).chain((name) =>
        fc.record({
          type: fc.constant('variable' as const),
          name: fc.constant(name),
          equals: fc.constant(variables[name]!),
        }),
      ),
    );
  }
  return fc.oneof(...options);
}

function actionArb(variables: Record<string, VariableValue>): fc.Arbitrary<ActionInput> {
  const names = Object.keys(variables);
  const options: fc.Arbitrary<ActionInput>[] = [
    fc
      .constantFrom(...WORDS.filter((word) => word !== ''), ...names.map((name) => `{{${name}}}`))
      .map((body) => ({
        type: 'send_message' as const,
        message: { type: 'text' as const, text: `> ${body}` },
      })),
    fc.constant({ type: 'call_webhook' as const, url: 'https://hooks.example.com/x' }),
    fc.constant({ type: 'handoff' as const }),
  ];
  for (const name of names) {
    const type = valueType(variables[name]!);
    const fixed =
      type === 'string'
        ? fc.string({ maxLength: 8 })
        : type === 'number'
          ? fc.integer()
          : fc.boolean();
    options.push(fixed.map((value) => ({ type: 'set_variable' as const, name, value })));
    if (type !== 'boolean') {
      options.push(
        fc.constant({ type: 'set_variable' as const, name, from: 'message_text' as const }),
      );
    }
  }
  return fc.oneof(...options);
}

function stateArb(
  ids: string[],
  variables: Record<string, VariableValue>,
): fc.Arbitrary<StateInput> {
  const target = fc.constantFrom(...ids);
  const actions = fc.array(actionArb(variables), { maxLength: 3 });
  const transition = fc.record({ condition: conditionArb(variables), target, actions });
  const normal = fc.record({
    on_enter: actions,
    transitions: fc
      .tuple(fc.array(transition, { maxLength: 4 }), fc.option(fc.record({ target, actions })))
      .map(([list, last]) =>
        last === null ? list : [...list, { condition: { type: 'any' as const }, ...last }],
      ),
    timeout: fc.option(
      fc.record({ after_seconds: fc.integer({ min: 10, max: 86_400 }), target, actions }),
      { nil: undefined },
    ),
  });
  const final = fc.record({
    on_enter: actions,
    transitions: fc.constant<TransitionInput[]>([]),
    final: fc.constant(true),
  });
  return fc.oneof({ weight: 4, arbitrary: normal }, { weight: 1, arbitrary: final });
}

const definitionArb: fc.Arbitrary<BotDefinitionInput> = fc
  .tuple(
    fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,5}$/), { minLength: 1, maxLength: 6 }),
    fc.dictionary(fc.stringMatching(/^v[0-9]$/), variableArb, { maxKeys: 4 }),
  )
  .chain(([ids, variables]) =>
    fc.tuple(...ids.map(() => stateArb(ids, variables)), fc.constantFrom(...ids)).map((parts) => {
      const initial = parts.pop() as string;
      const states = Object.fromEntries(ids.map((id, index) => [id, parts[index] as StateInput]));
      return { initial_state: initial, variables, states };
    }),
  );

const inputArb: fc.Arbitrary<InboundInput> = fc.oneof(
  fc
    .oneof(fc.constantFrom(...WORDS), fc.string({ maxLength: 12 }))
    .map((text) => ({ type: 'text' as const, text })),
  fc.constantFrom(...IDS).map((id) => ({ type: 'button_reply' as const, buttonId: id, text: id })),
  fc.constantFrom(...IDS).map((id) => ({ type: 'list_reply' as const, rowId: id, text: 'Linha' })),
  fc.constant({
    type: 'media' as const,
    mediaType: 'image' as const,
    mimeType: 'image/png',
    caption: 'sim',
  }),
  fc.constant({ type: 'unsupported' as const, providerType: 'stickerMessage' }),
);

/** An event of a random walk: a message, or the pending timer (when there is one). */
const eventArb = fc.oneof(
  inputArb.map((input) => ({ kind: 'message' as const, input })),
  fc.constant({ kind: 'timer' as const }),
);

function checkInvariants(definition: ReturnType<typeof define>, result: EngineResult): void {
  expect(Object.keys(definition.states)).toContain(result.toState);
  expect(Object.keys(result.variables).sort()).toEqual(Object.keys(definition.variables).sort());
  for (const [name, value] of Object.entries(result.variables)) {
    expect(valueType(value)).toBe(valueType(definition.variables[name]!));
  }
  expect(result.ended).toBe(definition.states[result.toState]!.final);
  if (result.timer !== null) {
    expect(result.timer.state).toBe(result.toState);
    expect(result.timer.version).toBe(result.version);
    expect(result.ended || result.handoff).toBe(false);
  }
  expect(
    result.actions.every(
      (action) => action.type !== 'set_variable' || action.name in definition.variables,
    ),
  ).toBe(true);
}

describe('engine properties', () => {
  it('generates only valid definitions', () => {
    fc.assert(
      fc.property(definitionArb, (input) => {
        expect(() => define(input)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('keeps every invariant in a random walk of messages and timers', async () => {
    await fc.assert(
      fc.asyncProperty(
        definitionArb,
        fc.array(eventArb, { maxLength: 12 }),
        async (input, events) => {
          const definition = define(input);
          let result = startConversation(definition, { conversationId: CONVERSATION_ID, now: NOW });
          checkInvariants(definition, result);
          let snapshot = after(result);
          let pending = result.timer;
          const jobIds = new Set(pending === null ? [] : [pending.jobId]);

          for (const event of events) {
            if (result.ended || result.handoff) {
              break;
            }
            const previousVersion = snapshot.version;
            if (event.kind === 'timer') {
              if (pending === null) {
                continue;
              }
              result = handleTimeout(definition, snapshot, {
                timerState: pending.state,
                timerVersion: pending.version,
                now: pending.fireAt,
              });
              // The pending timer always belongs to the current entry, so it is never stale.
              expect(result.matched).toBe(true);
            } else {
              result = await handleInbound(definition, snapshot, event.input, {
                now: NOW,
                external,
              });
              if (pending !== null) {
                expect(result.cancelTimer?.jobId).toBe(pending.jobId);
              }
            }
            checkInvariants(definition, result);
            expect(result.version).toBe(result.persist ? previousVersion + 1 : previousVersion);
            if (result.persist) {
              snapshot = after(result);
              pending = result.timer;
            }
            if (result.timer !== null) {
              expect(jobIds.has(result.timer.jobId)).toBe(false);
              jobIds.add(result.timer.jobId);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('is deterministic: equal inputs give equal results', async () => {
    await fc.assert(
      fc.asyncProperty(
        definitionArb,
        inputArb,
        fc.nat({ max: 5 }),
        async (input, message, pick) => {
          const definition = define(input);
          const ids = Object.keys(definition.states);
          const state = ids[pick % ids.length]!;
          const snapshot = {
            conversationId: CONVERSATION_ID,
            state,
            variables: { ...definition.variables },
            version: 3,
          };
          const first = await handleInbound(definition, snapshot, message, { now: NOW, external });
          const second = await handleInbound(definition, structuredClone(snapshot), message, {
            now: NOW,
            external,
          });
          expect(second).toEqual(first);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never changes the stored variables or the definition', async () => {
    await fc.assert(
      fc.asyncProperty(definitionArb, inputArb, async (input, message) => {
        const definition = define(input);
        const frozenDefinition = structuredClone(definition);
        const snapshot = after(
          startConversation(definition, { conversationId: CONVERSATION_ID, now: NOW }),
        );
        const frozenSnapshot = structuredClone(snapshot);
        await handleInbound(definition, snapshot, message, { now: NOW, external });
        expect(snapshot).toEqual(frozenSnapshot);
        expect(definition).toEqual(frozenDefinition);
      }),
      { numRuns: 200 },
    );
  });
});
