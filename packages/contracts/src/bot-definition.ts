import { z } from 'zod';
import { HttpsUrl } from './common.js';
import { StrictMessageContent } from './messages.js';

/**
 * Versioned state machine of a bot (architecture plan, section "State machine das conversas").
 * The definition is JSON. Every object is strict: an unknown key is an error, so a typo does not drop a rule.
 * A conversation stays on the version that it started with.
 */

export const BOT_STATES_MAX = 100;
export const BOT_TRANSITIONS_PER_STATE_MAX = 50;
export const BOT_ACTIONS_PER_LIST_MAX = 20;
export const BOT_VARIABLES_MAX = 100;
export const BOT_TIMEOUT_SECONDS_MIN = 10;
/** Seven days. */
export const BOT_TIMEOUT_SECONDS_MAX = 604_800;
export const REGEX_PATTERN_MAX_LENGTH = 200;
export const EXTERNAL_TIMEOUT_MS_MIN = 100;
export const EXTERNAL_TIMEOUT_MS_MAX = 5000;
export const EXTERNAL_TIMEOUT_MS_DEFAULT = 3000;
export const TEXT_CONDITION_VALUES_MAX = 50;
export const VARIABLE_STRING_MAX_LENGTH = 1024;

/** Identifier of a state. */
export const StateId = z
  .string()
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/,
    'Must be 1 to 64 characters: A-Z, a-z, 0-9, "_", ".", "-"',
  );
export type StateId = z.infer<typeof StateId>;

/** Name of a variable. Templates use it as `{{name}}`. */
export const VariableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Must be 1 to 64 characters: A-Z, a-z, 0-9, "_"');
export type VariableName = z.infer<typeof VariableName>;

export const VariableValue = z.union([
  z.string().max(VARIABLE_STRING_MAX_LENGTH),
  z.number().finite(),
  z.boolean(),
]);
export type VariableValue = z.infer<typeof VariableValue>;

/** Source of a template variable: `{{name}}` or `{{ name }}`. */
export const TEMPLATE_VARIABLE_PATTERN = '\\{\\{\\s*([A-Za-z_][A-Za-z0-9_]{0,63})\\s*\\}\\}';

/** Returns the variable names that a template text uses, in order of appearance, without duplicates. */
export function extractTemplateVariables(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(new RegExp(TEMPLATE_VARIABLE_PATTERN, 'g'))) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** Matches when the trimmed message text is equal to one of the values. Default: not case sensitive. */
export const TextCondition = z.strictObject({
  type: z.literal('text'),
  equals: z.array(z.string().min(1).max(1024)).min(1).max(TEXT_CONDITION_VALUES_MAX),
  case_sensitive: z.boolean().default(false),
});

/** Matches when the user clicks the button (or the list row) with this id. */
export const ButtonCondition = z.strictObject({
  type: z.literal('button'),
  id: z.string().min(1).max(256),
});

/**
 * Matches when the regular expression finds the message text. Flags are a subset of `imsu`.
 * The engine must run the expression with a time limit (the pattern comes from a client).
 */
export const RegexCondition = z
  .strictObject({
    type: z.literal('regex'),
    pattern: z.string().min(1).max(REGEX_PATTERN_MAX_LENGTH),
    flags: z
      .string()
      .regex(/^[imsu]*$/, 'Flags must be a subset of "imsu"')
      .refine((flags) => new Set(flags).size === flags.length, 'A flag must not repeat')
      .default(''),
  })
  .superRefine((value, ctx) => {
    try {
      new RegExp(value.pattern, value.flags);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

/**
 * JSON Pointer (RFC 6901) into the JSON response of an external call. `""` is the full document.
 * Example: `/data/approved`.
 */
export const JsonPointer = z
  .string()
  .max(256)
  .regex(/^(\/[^/]*)*$/, 'Must be a JSON Pointer (RFC 6901), for example "/data/approved"');

/**
 * Calls an HTTPS service of the client (POST, signed like a webhook) and matches when the value at
 * `expect.path` in the JSON response is equal to `expect.equals`. A timeout or an error does not match.
 */
export const ExternalCondition = z.strictObject({
  type: z.literal('external'),
  url: HttpsUrl,
  timeout_ms: z
    .number()
    .int()
    .min(EXTERNAL_TIMEOUT_MS_MIN)
    .max(EXTERNAL_TIMEOUT_MS_MAX)
    .default(EXTERNAL_TIMEOUT_MS_DEFAULT),
  expect: z.strictObject({
    path: JsonPointer,
    equals: z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]),
  }),
});

/** Matches when the variable has this value (strict equality, no type conversion). */
export const VariableCondition = z.strictObject({
  type: z.literal('variable'),
  name: VariableName,
  equals: VariableValue,
});

/** Always matches. Put it last: the transitions after it are not reachable. */
export const AnyCondition = z.strictObject({ type: z.literal('any') });

export const Condition = z.discriminatedUnion('type', [
  TextCondition,
  ButtonCondition,
  RegexCondition,
  ExternalCondition,
  VariableCondition,
  AnyCondition,
]);
export type Condition = z.infer<typeof Condition>;
export type ConditionType = Condition['type'];

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Message content of a `send_message` action: the content of `POST /v1/messages` without
 * `instance_id`, `to`, and `priority`. Text fields accept `{{var}}` templates.
 * The engine sends to the contact of the conversation with the priority `reply`.
 */
export const BotMessageContent = StrictMessageContent;
export type BotMessageContent = z.infer<typeof BotMessageContent>;

export const SendMessageAction = z.strictObject({
  type: z.literal('send_message'),
  message: BotMessageContent,
});

/** Sends the conversation context to an HTTPS URL of the client (signed like a webhook). */
export const CallWebhookAction = z.strictObject({
  type: z.literal('call_webhook'),
  url: HttpsUrl,
});

/**
 * Sets a variable. Use exactly one of:
 * - `value`: a fixed value. A string value is a template (`{{var}}`).
 * - `from: "message_text"`: the text of the message that caused the transition.
 */
export const SetVariableAction = z
  .strictObject({
    type: z.literal('set_variable'),
    name: VariableName,
    value: VariableValue.optional(),
    from: z.literal('message_text').optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.value === undefined) === (value.from === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Send exactly one of "value" and "from"',
      });
    }
  });

/** Moves the conversation to a human. The bot stops until `POST /v1/conversations/{id}/handoff` with `to: "bot"`. */
export const HandoffAction = z.strictObject({ type: z.literal('handoff') });

export const Action = z.discriminatedUnion('type', [
  SendMessageAction,
  CallWebhookAction,
  SetVariableAction,
  HandoffAction,
]);
export type Action = z.infer<typeof Action>;
export type ActionType = Action['type'];

const ActionList = z.array(Action).max(BOT_ACTIONS_PER_LIST_MAX);

// ---------------------------------------------------------------------------
// States and the definition
// ---------------------------------------------------------------------------

export const Transition = z.strictObject({
  condition: Condition,
  target: StateId,
  actions: ActionList.default([]),
});
export type Transition = z.infer<typeof Transition>;

/** Moves the conversation to `target` when no message arrives in `after_seconds`. */
export const StateTimeout = z.strictObject({
  after_seconds: z.number().int().min(BOT_TIMEOUT_SECONDS_MIN).max(BOT_TIMEOUT_SECONDS_MAX),
  target: StateId,
  actions: ActionList.default([]),
});
export type StateTimeout = z.infer<typeof StateTimeout>;

/**
 * One state. The engine evaluates `transitions` in order and uses the first match.
 * A final state ends the conversation: it has no transitions and no timeout.
 */
export const BotState = z.strictObject({
  on_enter: ActionList.default([]),
  transitions: z.array(Transition).max(BOT_TRANSITIONS_PER_STATE_MAX),
  timeout: StateTimeout.optional(),
  final: z.boolean().default(false),
});
export type BotState = z.infer<typeof BotState>;

type Path = (string | number)[];

function checkVariableName(
  name: string,
  declared: Set<string>,
  path: Path,
  ctx: z.core.$RefinementCtx,
): void {
  if (!declared.has(name)) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `Variable "${name}" is not declared in "variables"`,
    });
  }
}

function checkActions(
  actions: Action[],
  declared: Set<string>,
  path: Path,
  ctx: z.core.$RefinementCtx,
): void {
  actions.forEach((action, index) => {
    if (action.type === 'set_variable') {
      checkVariableName(action.name, declared, [...path, index, 'name'], ctx);
    }
  });
}

function checkTarget(
  target: string,
  states: Set<string>,
  path: Path,
  ctx: z.core.$RefinementCtx,
): void {
  if (!states.has(target)) {
    ctx.addIssue({ code: 'custom', path, message: `State "${target}" does not exist` });
  }
}

export const BotDefinition = z
  .strictObject({
    initial_state: StateId,
    variables: z.record(VariableName, VariableValue).default({}),
    states: z.record(StateId, BotState),
  })
  .superRefine((definition, ctx) => {
    const stateIds = new Set(Object.keys(definition.states));
    const declared = new Set(Object.keys(definition.variables));

    if (stateIds.size === 0 || stateIds.size > BOT_STATES_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['states'],
        message: `A definition has 1 to ${BOT_STATES_MAX} states`,
      });
    }
    if (declared.size > BOT_VARIABLES_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['variables'],
        message: `A definition has at most ${BOT_VARIABLES_MAX} variables`,
      });
    }
    checkTarget(definition.initial_state, stateIds, ['initial_state'], ctx);

    for (const [stateId, state] of Object.entries(definition.states)) {
      const statePath: Path = ['states', stateId];
      checkActions(state.on_enter, declared, [...statePath, 'on_enter'], ctx);

      if (state.final && (state.transitions.length > 0 || state.timeout !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: [...statePath, 'final'],
          message: 'A final state has no transitions and no timeout',
        });
      }

      let unreachableAfter: number | undefined;
      state.transitions.forEach((transition, index) => {
        const transitionPath: Path = [...statePath, 'transitions', index];
        if (unreachableAfter !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: transitionPath,
            message: `This transition is not reachable: transition ${unreachableAfter} has the condition "any"`,
          });
        }
        if (transition.condition.type === 'any' && unreachableAfter === undefined) {
          unreachableAfter = index;
        }
        if (transition.condition.type === 'variable') {
          checkVariableName(
            transition.condition.name,
            declared,
            [...transitionPath, 'condition', 'name'],
            ctx,
          );
        }
        checkTarget(transition.target, stateIds, [...transitionPath, 'target'], ctx);
        checkActions(transition.actions, declared, [...transitionPath, 'actions'], ctx);
      });

      if (state.timeout !== undefined) {
        checkTarget(state.timeout.target, stateIds, [...statePath, 'timeout', 'target'], ctx);
        checkActions(state.timeout.actions, declared, [...statePath, 'timeout', 'actions'], ctx);
      }
    }
  });
export type BotDefinition = z.infer<typeof BotDefinition>;
export type BotDefinitionInput = z.input<typeof BotDefinition>;
