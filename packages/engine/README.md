# @botcenter/engine

The state machine engine of the bot conversations. The engine is pure: it has no database, no Redis, no HTTP client, and it reads no clock. The caller gives the time (`now`) and the port for external calls.

The conversations slice of the API does these steps for each event:

1. Lock the conversation and load it (state, variables, version).
2. Call the engine.
3. If `result.persist` is true, write the new state, the variables, the version, the transition row, and the outbox rows in one transaction. Use `WHERE version = snapshot.version`.
4. Remove `result.cancelTimer` from the `timers` queue. Add `result.timer` with its `jobId` and the delay `fireAt - now`.
5. Execute the actions in order: `send_message`, `call_webhook`, and `handoff`. Do not execute `set_variable`: the engine applied it to `variables` already.
6. Log the diagnostics. Send an alert for each diagnostic with the severity `error`.

## API

```ts
startConversation(definition, { conversationId, now, version? }): EngineResult
handleInbound(definition, snapshot, input, { now, external? }): Promise<EngineResult>
handleTimeout(definition, snapshot, { timerState, timerVersion, now }): EngineResult
timerForState(definition, { conversationId, state, version, now }): TimerPlan | null
timerJobId(conversationId, version): string
parseDefinitionForEngine(input: unknown): { success: true; definition } | { success: false; issues }
validateDefinitionForEngine(definition): DefinitionIssue[]
definitionHash(definition): string
```

- `definition` is the parsed `BotDefinition` of `@botcenter/contracts` (with the defaults).
- `snapshot` is `{ conversationId, state, variables, version }`. `version` is the column `conversations.version`.
- `input` is `InboundInput`. It has the same shape as `InboundContent` of `@botcenter/whatsapp-provider`.
- `external` is an `ExternalCaller`. It must throw `ExternalCallError` on a failure.

`EngineResult` has these fields: `trigger`, `matched`, `persist`, `fromState`, `toState`, `transitionIndex`, `ended`, `handoff`, `version`, `variables`, `actions`, `timer`, `cancelTimer`, and `diagnostics`.

The engine throws only `EngineStateError`: the snapshot has a state that the definition does not have. This is a data error. Catch it, log it, and send an alert.

## Example

```ts
import { handleInbound, parseDefinitionForEngine, startConversation } from '@botcenter/engine';

const parsed = parseDefinitionForEngine(body.definition);
if (!parsed.success) throw new BotDefinitionInvalid(parsed.issues);

const start = startConversation(parsed.definition, { conversationId, now: new Date() });
// Write start.toState, start.variables, start.version (0). Schedule start.timer.

const result = await handleInbound(
  parsed.definition,
  { conversationId, state: start.toState, variables: start.variables, version: start.version },
  { type: 'button_reply', buttonId: 'comecar', text: 'Começar' },
  { now: new Date(), external: httpExternalCaller },
);
```

The fixture `personalTrainerOnboarding` (`@botcenter/engine/fixtures`) is a complete onboarding bot in pt-BR. Use it in tests.

## Rules

### Transitions

- The engine evaluates the transitions of the current state in order. The first true condition wins.
- When no transition matches, the state stays, there are no actions, and `matched` is false.
- On a transition, the engine runs the actions of the transition, then the `on_enter` actions of the target state.
- A transition to the same state is a re-entry: `on_enter` runs again and the timer starts again.
- A final target state ends the conversation (`ended: true`, no timer). A message in a final state gives `matched: false` and `persist: false`. Start a new conversation.
- The first message of a contact only starts the conversation. The engine does not evaluate it against the transitions of the initial state.
- Loop guard: the engine does at most one transition in each call. Only an input causes a call (the start, one message, or one timer). There are no automatic chains of transitions.

### Conditions

| Condition  | Rule                                                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`     | The engine trims the message text and makes it Unicode NFC. With `case_sensitive: false` (the default), the engine also ignores case and accents and changes each run of white space to one space: `NÃO` matches `nao`. With `case_sensitive: true`, case and accents count.                                                      |
| `button`   | Matches the id of a button reply or of a list row reply.                                                                                                                                                                                                                                                                          |
| `regex`    | Runs on RE2 (linear time, no ReDoS). The engine always adds the `u` flag. RE2 has no backreferences and no lookaround: `validateDefinitionForEngine` refuses those patterns.                                                                                                                                                      |
| `external` | Calls the port with `{ conversationId, state, variables, message, timeoutMs, signal }`. It reads the JSON response with the JSON Pointer `expect.path` and compares with `expect.equals` (strict equality). A port error, a timeout, or a missing value gives `false` and a diagnostic. The engine never throws for a port error. |
| `variable` | Strict equality, no type conversion.                                                                                                                                                                                                                                                                                              |
| `any`      | Always true.                                                                                                                                                                                                                                                                                                                      |

The message text is the text, the title of a button or list reply, or the caption of a media message. A media message without a caption and an unsupported message have no text: `text` and `regex` conditions are false for them.

### Actions

- Actions are data. The order of the result is the order of execution.
- `set_variable` changes the variables at its position. A later action in the same step sees the new value.
- `set_variable` keeps the declared type of the variable. For a number variable, `from: "message_text"` accepts `72` and `72,5`. If the text is not a number, the variable keeps its value.
- `send_message` renders `{{name}}` in the text fields (`text`, `caption`, `file_name`, `footer`, titles, `button_text`, row descriptions). Ids and URLs are not templates. The render is one pass and escapes nothing. An unknown variable renders as an empty text and gives a warning. The engine cuts each field to its WhatsApp limit. If the rendered message is not valid (for example, an empty text), the engine drops the action and gives an error diagnostic.
- `call_webhook` carries a copy of the variables at its position.
- `handoff` sets `result.handoff`. The engine arms no timer: the bot stops. Do not call the engine while the conversation is in handoff.

### Timers

- A timer job id is `timerJobId(conversationId, version)` = `timer-<conversationId>-v<version>`. `version` is the conversation version that the API writes with the timer. Each write increments the version, so each entry into a state gets a new id.
- Any message restarts the timer of the current state, also a message that matches no transition. The timeout means "no message in `after_seconds`".
- `handleTimeout` is stale (no-op, `persist: false`) when the state or the version of the conversation is different from the timer. So a late timer cannot move the conversation, also when the API could not remove the job.
- A write that is not from the engine (for example, a handoff) makes the pending timer stale. When the API gives the conversation back to the bot, it writes the conversation and calls `timerForState` with the new version.

### Definition checks

`parseDefinitionForEngine` applies the contract schema, then `validateDefinitionForEngine`. The engine checks:

- Each `regex` pattern compiles with RE2.
- Each template uses only declared variables.
- Each `set_variable` value has the declared type. A boolean variable cannot take the message text.
- Each `variable` condition compares with a value of the declared type.

`definitionHash` is the SHA-256 of the canonical JSON (sorted keys). Give it the parsed definition, so that an input with and without the defaults gives the same hash.

## Runtime

`re2` is a native module. The install downloads a prebuilt binary (glibc and musl) or builds it with `node-gyp`. The root `pnpm-workspace.yaml` allows its install script. `re2@1.27` asks for Node `^24.15.0`.
