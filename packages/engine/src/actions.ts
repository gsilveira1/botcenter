import { VARIABLE_STRING_MAX_LENGTH } from '@botcenter/contracts';
import type { Action, BotDefinition, VariableValue } from '@botcenter/contracts';
import { renderMessage, renderTemplate, truncate } from './templates.js';
import type { Diagnostic, DiagnosticSeverity, EngineAction, Variables } from './types.js';
import { isValueOfType, parseNumber, valueType } from './variables.js';

type Path = (string | number)[];
type SetVariableAction = Extract<Action, { type: 'set_variable' }>;

export interface ActionContext {
  definition: BotDefinition;
  /** The working copy of the variables. `set_variable` changes it in place. */
  variables: Variables;
  /** `messageText(input)`, or `null` for a timeout and for a message without text. */
  text: string | null;
  diagnostics: Diagnostic[];
}

/**
 * Turns a list of definition actions into result actions, in order. `set_variable` changes the
 * working variables at once, so a later action in the same step sees the new value, and an earlier
 * action keeps the old value. `call_webhook` gets a copy of the variables at its position.
 */
export function applyActions(
  actions: readonly Action[],
  context: ActionContext,
  path: Path,
): EngineAction[] {
  const result: EngineAction[] = [];
  actions.forEach((action, index) => {
    const actionPath = [...path, index];
    switch (action.type) {
      case 'send_message': {
        const message = renderMessage(action.message, context.variables, context.diagnostics, [
          ...actionPath,
          'message',
        ]);
        if (message !== null) {
          result.push({ type: 'send_message', message });
        }
        break;
      }
      case 'call_webhook':
        result.push({ type: 'call_webhook', url: action.url, variables: { ...context.variables } });
        break;
      case 'set_variable': {
        const value = resolveValue(action, context, actionPath);
        if (value !== null) {
          context.variables[action.name] = value;
          result.push({ type: 'set_variable', name: action.name, value });
        }
        break;
      }
      case 'handoff':
        result.push({ type: 'handoff' });
        break;
    }
  });
  return result;
}

/** The new value of a `set_variable` action, or `null` when the engine must skip the action. */
function resolveValue(
  action: SetVariableAction,
  context: ActionContext,
  path: Path,
): VariableValue | null {
  const declared = context.definition.variables[action.name];
  if (declared === undefined) {
    return mismatch(context, path, `The variable "${action.name}" is not declared.`);
  }
  const type = valueType(declared);

  if (action.value !== undefined) {
    if (!isValueOfType(action.value, type)) {
      return mismatch(
        context,
        path,
        `The value of "${action.name}" is not a ${type}. The variable keeps its value.`,
      );
    }
    if (typeof action.value === 'string') {
      const rendered = renderTemplate(action.value, context.variables, context.diagnostics, [
        ...path,
        'value',
      ]);
      return truncate(rendered, VARIABLE_STRING_MAX_LENGTH, context.diagnostics, [
        ...path,
        'value',
      ]);
    }
    return action.value;
  }

  // `from: "message_text"`.
  if (context.text === null) {
    context.diagnostics.push({
      code: 'message_text_missing',
      severity: 'info',
      message: `There is no message text, so "${action.name}" keeps its value.`,
      path,
    });
    return null;
  }
  if (type === 'string') {
    return truncate(context.text, VARIABLE_STRING_MAX_LENGTH, context.diagnostics, path);
  }
  if (type === 'number') {
    const value = parseNumber(context.text);
    if (value === null) {
      // A user who writes text where the bot expects a number is normal: severity `info`.
      return mismatch(
        context,
        path,
        `The message text is not a number, so "${action.name}" keeps its value.`,
        'info',
      );
    }
    return value;
  }
  return mismatch(
    context,
    path,
    `The boolean variable "${action.name}" cannot take the message text. The variable keeps its value.`,
  );
}

function mismatch(
  context: ActionContext,
  path: Path,
  message: string,
  severity: DiagnosticSeverity = 'warning',
): null {
  context.diagnostics.push({ code: 'variable_type_mismatch', severity, message, path });
  return null;
}
