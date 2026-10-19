import type { Condition } from '@botcenter/contracts';
import { ExternalCallError } from './errors.js';
import { readJsonPointer } from './json-pointer.js';
import { compileRegex } from './regex.js';
import { looseText, strictText } from './text.js';
import type {
  Diagnostic,
  EnginePorts,
  ExternalCallRequest,
  ExternalCaller,
  InboundInput,
  Variables,
} from './types.js';

type Path = (string | number)[];

export interface ConditionContext {
  conversationId: string;
  state: string;
  input: InboundInput;
  /** `messageText(input)`. */
  text: string | null;
  variables: Variables;
  ports: EnginePorts;
  diagnostics: Diagnostic[];
}

type ExternalCondition = Extract<Condition, { type: 'external' }>;
type TextCondition = Extract<Condition, { type: 'text' }>;

/** Evaluates one condition. It never throws for a client error: it gives `false` and a diagnostic. */
export async function evaluateCondition(
  condition: Condition,
  context: ConditionContext,
  path: Path,
): Promise<boolean> {
  switch (condition.type) {
    case 'any':
      return true;
    case 'text':
      return matchText(condition, context.text);
    case 'button':
      return (
        (context.input.type === 'button_reply' && context.input.buttonId === condition.id) ||
        (context.input.type === 'list_reply' && context.input.rowId === condition.id)
      );
    case 'regex':
      return matchRegex(condition.pattern, condition.flags, context, path);
    case 'variable':
      return (
        Object.hasOwn(context.variables, condition.name) &&
        context.variables[condition.name] === condition.equals
      );
    case 'external':
      return matchExternal(condition, context, path);
  }
}

function matchText(condition: TextCondition, text: string | null): boolean {
  if (text === null) {
    return false;
  }
  const form = condition.case_sensitive ? strictText : looseText;
  const value = form(text);
  return condition.equals.some((candidate) => form(candidate) === value);
}

function matchRegex(
  pattern: string,
  flags: string,
  context: ConditionContext,
  path: Path,
): boolean {
  if (context.text === null) {
    return false;
  }
  const compiled = compileRegex(pattern, flags);
  if (!compiled.ok) {
    context.diagnostics.push({
      code: 'regex_invalid',
      severity: 'error',
      message: `RE2 cannot compile the pattern, so the condition is false: ${compiled.error}`,
      path: [...path, 'pattern'],
    });
    return false;
  }
  return compiled.regex.test(context.text);
}

async function matchExternal(
  condition: ExternalCondition,
  context: ConditionContext,
  path: Path,
): Promise<boolean> {
  const port = context.ports.external;
  if (port === undefined) {
    context.diagnostics.push({
      code: 'external_port_missing',
      severity: 'error',
      message: 'The engine has no ExternalCaller port, so the external condition is false.',
      path,
    });
    return false;
  }

  let body: unknown;
  try {
    body = await callWithLimit(port, condition.url, {
      conversationId: context.conversationId,
      state: context.state,
      variables: { ...context.variables },
      message: context.input,
      timeoutMs: condition.timeout_ms,
    });
  } catch (error) {
    // The port is the I/O boundary: a failure there must not stop the conversation. The condition
    // is false and the diagnostic carries the cause, so the API logs it (no silent failure).
    context.diagnostics.push(externalFailure(error, path));
    return false;
  }

  const read = readJsonPointer(body, condition.expect.path);
  if (!read.found) {
    context.diagnostics.push({
      code: 'external_value_missing',
      severity: 'info',
      message: `The response has no value at "${condition.expect.path}", so the condition is false.`,
      path,
    });
    return false;
  }
  return read.value === condition.expect.equals;
}

function externalFailure(error: unknown, path: Path): Diagnostic {
  if (error instanceof ExternalCallError) {
    const status = error.httpStatus === undefined ? '' : ` (HTTP ${error.httpStatus})`;
    return {
      code: 'external_call_failed',
      severity: 'warning',
      message: `External call failed: ${error.kind}${status}: ${error.message}`,
      path,
    };
  }
  // The port must throw ExternalCallError. Another error is a bug in the port: report it as an error.
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    code: 'external_call_failed',
    severity: 'error',
    message: `External call failed with an unexpected error (the port must throw ExternalCallError): ${detail}`,
    path,
  };
}

/**
 * Calls the port and stops the wait after `timeoutMs`, also when the port does not obey the signal.
 * The engine reads no clock: the abort signal holds the time limit.
 */
function callWithLimit(
  port: ExternalCaller,
  url: string,
  request: Omit<ExternalCallRequest, 'signal'>,
): Promise<unknown> {
  const signal = AbortSignal.timeout(request.timeoutMs);
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(
        new ExternalCallError('timeout', `No response in ${request.timeoutMs} ms`, undefined, {
          cause: signal.reason,
        }),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<unknown>;
    try {
      pending = port.call(url, { ...request, signal });
    } catch (error) {
      // A port that throws before it returns a promise. Treat it like a rejected promise.
      signal.removeEventListener('abort', onAbort);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
