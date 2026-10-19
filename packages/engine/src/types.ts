import type {
  BotMessageContent,
  MediaType,
  TransitionTrigger,
  VariableValue,
} from '@botcenter/contracts';

/** The variables of one conversation. The keys are the variables that the definition declares. */
export type Variables = Record<string, VariableValue>;

/**
 * The normalized content of an inbound message. It has the same shape as `InboundContent` of
 * `@botcenter/whatsapp-provider`, so the API can give that value directly.
 */
export type InboundInput =
  | { type: 'text'; text: string }
  | { type: 'button_reply'; buttonId: string; text: string }
  | { type: 'list_reply'; rowId: string; text: string }
  | {
      type: 'media';
      mediaType: MediaType;
      mimeType: string;
      caption?: string;
      fileName?: string;
    }
  | { type: 'unsupported'; providerType: string };

/** The stored state of one conversation, as the API loads it. */
export interface ConversationSnapshot {
  conversationId: string;
  /** The current state. It must be a state of the definition. */
  state: string;
  variables: Variables;
  /** The optimistic lock of the conversation row (`conversations.version`). */
  version: number;
}

/** A delayed job that fires the timeout of a state. */
export interface TimerPlan {
  state: string;
  /** The conversation version that armed the timer. `handleTimeout` compares it. */
  version: number;
  /** Deterministic job id: `timerJobId(conversationId, version)`. */
  jobId: string;
  fireAt: Date;
}

/** A pending timer that the API must remove from the `timers` queue. */
export interface TimerRef {
  state: string;
  jobId: string;
}

/** Actions are data. The API executes them after it writes the result. */
export type EngineAction =
  | { type: 'send_message'; message: BotMessageContent }
  | { type: 'call_webhook'; url: string; variables: Variables }
  /** The engine applied it to `variables` already. The API does not execute it (audit only). */
  | { type: 'set_variable'; name: string; value: VariableValue }
  | { type: 'handoff' };

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type DiagnosticCode =
  | 'no_transition_matched'
  | 'conversation_ended'
  | 'timer_stale'
  | 'external_call_failed'
  | 'external_port_missing'
  | 'external_value_missing'
  | 'regex_invalid'
  | 'template_variable_unknown'
  | 'value_truncated'
  | 'message_invalid'
  | 'variable_type_mismatch'
  | 'message_text_missing'
  | 'variable_reset'
  | 'variable_dropped';

/**
 * A fact about one engine step. The API logs `warning` and `error` entries. An `error` entry
 * means that the bot did less than the definition says (send an alert).
 */
export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  /** Location in the definition, for example `['states', 'start', 'transitions', 2]`. */
  path?: (string | number)[];
}

export interface EngineResult {
  trigger: TransitionTrigger;
  /** True when a transition (or the start, or a fresh timeout) moved the conversation. */
  matched: boolean;
  /** True when the API must write this result. False for a stale timer and for a step that changed nothing. */
  persist: boolean;
  /** `null` for `start`. */
  fromState: string | null;
  toState: string;
  /** The index of the matched transition in `fromState`. `null` for start, timeout, and no match. */
  transitionIndex: number | null;
  /** True when `toState` is a final state. */
  ended: boolean;
  /** True when the actions contain `handoff`. The bot stops and `timer` is `null`. */
  handoff: boolean;
  /** The conversation version to write. It is `snapshot.version` when `persist` is false. */
  version: number;
  variables: Variables;
  actions: EngineAction[];
  /** The timer to schedule, or `null`. */
  timer: TimerPlan | null;
  /** The pending timer to remove, or `null`. */
  cancelTimer: TimerRef | null;
  diagnostics: Diagnostic[];
}

/** The request that the engine gives to the `ExternalCaller` port. */
export interface ExternalCallRequest {
  conversationId: string;
  state: string;
  variables: Variables;
  message: InboundInput;
  timeoutMs: number;
  /** The engine aborts this signal after `timeoutMs`. */
  signal: AbortSignal;
}

/**
 * Port for the `external` condition. The API implementation sends a signed HTTPS POST (with the
 * SSRF guard) and returns the parsed JSON body. It must throw `ExternalCallError` on a failure.
 */
export interface ExternalCaller {
  call(url: string, request: ExternalCallRequest): Promise<unknown>;
}

export interface EnginePorts {
  external?: ExternalCaller;
}
