import type { Action, BotDefinition, BotState, TransitionTrigger } from '@botcenter/contracts';
import { applyActions } from './actions.js';
import { evaluateCondition } from './conditions.js';
import { EngineStateError } from './errors.js';
import { messageText } from './text.js';
import { pendingTimer, timerForState } from './timers.js';
import type {
  ConversationSnapshot,
  Diagnostic,
  EngineResult,
  ExternalCaller,
  InboundInput,
  TimerRef,
  Variables,
} from './types.js';
import { defaultVariables, reconcileVariables } from './variables.js';

/*
 * Loop guard: the engine does at most one transition in each call, and only an input (the start,
 * one message, or one timer) causes a call. The engine never follows a chain of transitions
 * without an input, so a definition cannot make an endless loop in one step. A timeout that
 * targets its own state repeats at most one time in `after_seconds` (minimum 10 s).
 */

export interface StartOptions {
  conversationId: string;
  now: Date;
  /**
   * The current version of the conversation row when the API starts a conversation again on the
   * same row (for example, after a final state). Leave it out for a new row: the version is then 0.
   */
  version?: number;
}

export interface InboundOptions {
  now: Date;
  /** The port for the `external` condition. */
  external?: ExternalCaller;
}

export interface TimeoutOptions {
  /** The `state` of the timer job. */
  timerState: string;
  /** The `version` of the timer job. */
  timerVersion: number;
  now: Date;
}

function stateOf(definition: BotDefinition, state: string): BotState {
  const found = definition.states[state];
  if (found === undefined) {
    throw new EngineStateError(`The state "${state}" does not exist in the definition`);
  }
  return found;
}

/**
 * Starts a conversation: the initial state, the default variables, the `on_enter` actions of the
 * initial state, and its timer. The message that opened the conversation is not evaluated against
 * the transitions of the initial state.
 */
export function startConversation(definition: BotDefinition, options: StartOptions): EngineResult {
  const diagnostics: Diagnostic[] = [];
  const toState = definition.initial_state;
  const state = stateOf(definition, toState);
  const variables = defaultVariables(definition);
  const actions = applyActions(state.on_enter, { definition, variables, text: null, diagnostics }, [
    'states',
    toState,
    'on_enter',
  ]);
  const version = options.version === undefined ? 0 : options.version + 1;
  return finish({
    definition,
    conversationId: options.conversationId,
    trigger: 'start',
    fromState: null,
    toState,
    transitionIndex: null,
    version,
    variables,
    actions,
    cancelTimer: null,
    now: options.now,
    diagnostics,
  });
}

/**
 * Applies one inbound message. The engine evaluates the transitions of the current state in order
 * and uses the first true condition. Any message restarts the timer of the current state (the
 * timeout means "no message in `after_seconds`"), also a message that matches no transition.
 * The API must not call it while the conversation is in handoff.
 */
export async function handleInbound(
  definition: BotDefinition,
  snapshot: ConversationSnapshot,
  input: InboundInput,
  options: InboundOptions,
): Promise<EngineResult> {
  const diagnostics: Diagnostic[] = [];
  const current = stateOf(definition, snapshot.state);
  const variables = reconcileVariables(definition, snapshot.variables, diagnostics);

  if (current.final) {
    diagnostics.push({
      code: 'conversation_ended',
      severity: 'info',
      message: `The state "${snapshot.state}" is final. Start a new conversation.`,
    });
    return stay(definition, snapshot, variables, diagnostics, false, options.now);
  }

  const text = messageText(input);
  const context = {
    conversationId: snapshot.conversationId,
    state: snapshot.state,
    input,
    text,
    variables,
    ports: options.external === undefined ? {} : { external: options.external },
    diagnostics,
  };

  for (const [index, transition] of current.transitions.entries()) {
    const path = ['states', snapshot.state, 'transitions', index];
    if (await evaluateCondition(transition.condition, context, [...path, 'condition'])) {
      return enter({
        definition,
        snapshot,
        trigger: 'message',
        transitionIndex: index,
        firstActions: transition.actions,
        firstPath: [...path, 'actions'],
        target: transition.target,
        text,
        variables,
        cancelTimer: pendingTimer(
          definition,
          snapshot.conversationId,
          snapshot.state,
          snapshot.version,
        ),
        now: options.now,
        diagnostics,
      });
    }
  }

  diagnostics.push({
    code: 'no_transition_matched',
    severity: 'info',
    message: `No transition of "${snapshot.state}" matched the message.`,
  });
  return stay(definition, snapshot, variables, diagnostics, true, options.now);
}

/**
 * Applies a state timer. When the conversation is still in `timerState` with the version that
 * armed the timer, the engine runs `timeout.actions`, then the `on_enter` actions of
 * `timeout.target`. Otherwise the timer is stale and the result changes nothing (`persist: false`).
 */
export function handleTimeout(
  definition: BotDefinition,
  snapshot: ConversationSnapshot,
  options: TimeoutOptions,
): EngineResult {
  const diagnostics: Diagnostic[] = [];
  const current = stateOf(definition, snapshot.state);
  const variables = reconcileVariables(definition, snapshot.variables, diagnostics);
  const timeout = current.timeout;

  if (
    timeout === undefined ||
    snapshot.state !== options.timerState ||
    snapshot.version !== options.timerVersion
  ) {
    diagnostics.push({
      code: 'timer_stale',
      severity: 'info',
      message: `The timer of "${options.timerState}" (version ${options.timerVersion}) is stale: the conversation is in "${snapshot.state}" (version ${snapshot.version}).`,
    });
    return {
      trigger: 'timeout',
      matched: false,
      persist: false,
      fromState: snapshot.state,
      toState: snapshot.state,
      transitionIndex: null,
      ended: current.final,
      handoff: false,
      version: snapshot.version,
      variables,
      actions: [],
      timer: null,
      cancelTimer: null,
      diagnostics,
    };
  }

  return enter({
    definition,
    snapshot,
    trigger: 'timeout',
    transitionIndex: null,
    firstActions: timeout.actions,
    firstPath: ['states', snapshot.state, 'timeout', 'actions'],
    target: timeout.target,
    text: null,
    variables,
    // The timer job runs now: there is no other pending timer to remove.
    cancelTimer: null,
    now: options.now,
    diagnostics,
  });
}

interface EnterArgs {
  definition: BotDefinition;
  snapshot: ConversationSnapshot;
  trigger: TransitionTrigger;
  transitionIndex: number | null;
  firstActions: readonly Action[];
  firstPath: (string | number)[];
  target: string;
  text: string | null;
  variables: Variables;
  cancelTimer: TimerRef | null;
  now: Date;
  diagnostics: Diagnostic[];
}

/** Moves to `target`: the actions of the transition (or timeout), then `on_enter` of the target. */
function enter(args: EnterArgs): EngineResult {
  const { definition, diagnostics, variables, text } = args;
  const targetState = stateOf(definition, args.target);
  const context = { definition, variables, text, diagnostics };
  const actions = [
    ...applyActions(args.firstActions, context, args.firstPath),
    ...applyActions(targetState.on_enter, context, ['states', args.target, 'on_enter']),
  ];
  return finish({
    definition,
    conversationId: args.snapshot.conversationId,
    trigger: args.trigger,
    fromState: args.snapshot.state,
    toState: args.target,
    transitionIndex: args.transitionIndex,
    version: args.snapshot.version + 1,
    variables,
    actions,
    cancelTimer: args.cancelTimer,
    now: args.now,
    diagnostics,
  });
}

interface FinishArgs {
  definition: BotDefinition;
  conversationId: string;
  trigger: TransitionTrigger;
  fromState: string | null;
  toState: string;
  transitionIndex: number | null;
  version: number;
  variables: Variables;
  actions: EngineResult['actions'];
  cancelTimer: TimerRef | null;
  now: Date;
  diagnostics: Diagnostic[];
}

/** Builds the result of a step that entered `toState`. */
function finish(args: FinishArgs): EngineResult {
  const ended = stateOf(args.definition, args.toState).final;
  const handoff = args.actions.some((action) => action.type === 'handoff');
  const timer =
    ended || handoff
      ? null
      : timerForState(args.definition, {
          conversationId: args.conversationId,
          state: args.toState,
          version: args.version,
          now: args.now,
        });
  return {
    trigger: args.trigger,
    matched: true,
    persist: true,
    fromState: args.fromState,
    toState: args.toState,
    transitionIndex: args.transitionIndex,
    ended,
    handoff,
    version: args.version,
    variables: args.variables,
    actions: args.actions,
    timer,
    cancelTimer: args.cancelTimer,
    diagnostics: args.diagnostics,
  };
}

function sameVariables(left: Variables, right: Variables): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

/**
 * The result of a message that did not move the conversation. When the state has a timeout, the
 * step restarts the timer, so the API must write a new version (`persist: true`).
 */
function stay(
  definition: BotDefinition,
  snapshot: ConversationSnapshot,
  variables: Variables,
  diagnostics: Diagnostic[],
  restartTimer: boolean,
  now: Date,
): EngineResult {
  const pending = restartTimer
    ? pendingTimer(definition, snapshot.conversationId, snapshot.state, snapshot.version)
    : null;
  const persist = pending !== null || !sameVariables(snapshot.variables, variables);
  const version = persist ? snapshot.version + 1 : snapshot.version;
  return {
    trigger: 'message',
    matched: false,
    persist,
    fromState: snapshot.state,
    toState: snapshot.state,
    transitionIndex: null,
    ended: stateOf(definition, snapshot.state).final,
    handoff: false,
    version,
    variables,
    actions: [],
    timer:
      pending === null
        ? null
        : timerForState(definition, {
            conversationId: snapshot.conversationId,
            state: snapshot.state,
            version,
            now,
          }),
    cancelTimer: pending,
    diagnostics,
  };
}
