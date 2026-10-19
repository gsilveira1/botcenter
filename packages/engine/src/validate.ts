import {
  BotDefinition,
  extractTemplateVariables,
  type Action,
  type BotDefinition as BotDefinitionType,
} from '@botcenter/contracts';
import { compileRegex } from './regex.js';
import { valueType } from './variables.js';

type Path = (string | number)[];

/** One problem in a definition. The shape agrees with a Zod issue (`path` and `message`). */
export interface DefinitionIssue {
  path: Path;
  message: string;
}

export type ParseDefinitionResult =
  { success: true; definition: BotDefinitionType } | { success: false; issues: DefinitionIssue[] };

/** Keys of a message that are not text for a person, so they are not templates. */
const NON_TEMPLATE_KEYS = new Set(['type', 'id', 'url', 'media_id', 'media_type']);

/** The template text fields of a message, with their paths. */
function templateFields(value: unknown, path: Path): { path: Path; text: string }[] {
  if (typeof value === 'string') {
    return [{ path, text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => templateFields(item, [...path, index]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      NON_TEMPLATE_KEYS.has(key) ? [] : templateFields(item, [...path, key]),
    );
  }
  return [];
}

function checkTemplate(
  text: string,
  declared: Record<string, unknown>,
  path: Path,
  issues: DefinitionIssue[],
): void {
  for (const name of extractTemplateVariables(text)) {
    if (!Object.hasOwn(declared, name)) {
      issues.push({
        path,
        message: `The template uses "${name}", which is not declared in "variables"`,
      });
    }
  }
}

function checkActions(
  definition: BotDefinitionType,
  actions: readonly Action[],
  path: Path,
  issues: DefinitionIssue[],
): void {
  actions.forEach((action, index) => {
    const actionPath = [...path, index];
    if (action.type === 'send_message') {
      for (const field of templateFields(action.message, [...actionPath, 'message'])) {
        checkTemplate(field.text, definition.variables, field.path, issues);
      }
      return;
    }
    if (action.type !== 'set_variable') {
      return;
    }
    const declared = definition.variables[action.name];
    if (declared === undefined) {
      // The contract schema reports an undeclared variable.
      return;
    }
    const type = valueType(declared);
    if (action.value !== undefined) {
      if (typeof action.value !== type) {
        issues.push({
          path: [...actionPath, 'value'],
          message: `"${action.name}" is a ${type}, but the value is a ${typeof action.value}`,
        });
      } else if (typeof action.value === 'string') {
        checkTemplate(action.value, definition.variables, [...actionPath, 'value'], issues);
      }
    } else if (type === 'boolean') {
      issues.push({
        path: [...actionPath, 'from'],
        message: `"${action.name}" is a boolean: it cannot take the message text`,
      });
    }
  });
}

/**
 * The engine rules that the contract schema does not check. Give it the parsed definition.
 * - A `regex` pattern must compile with RE2 (no backreferences, no lookaround).
 * - A template (`{{name}}`) uses only declared variables.
 * - A `set_variable` value has the declared type. A boolean variable cannot take the message text.
 * - A `variable` condition compares with a value of the declared type (else it never matches).
 */
export function validateDefinitionForEngine(definition: BotDefinitionType): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  for (const [stateId, state] of Object.entries(definition.states)) {
    const statePath: Path = ['states', stateId];
    checkActions(definition, state.on_enter, [...statePath, 'on_enter'], issues);
    state.transitions.forEach((transition, index) => {
      const transitionPath: Path = [...statePath, 'transitions', index];
      const condition = transition.condition;
      if (condition.type === 'regex') {
        const compiled = compileRegex(condition.pattern, condition.flags);
        if (!compiled.ok) {
          issues.push({
            path: [...transitionPath, 'condition', 'pattern'],
            message: `The pattern is not valid for RE2 (no backreferences, no lookaround): ${compiled.error}`,
          });
        }
      }
      if (condition.type === 'variable') {
        const declared = definition.variables[condition.name];
        if (declared !== undefined && typeof condition.equals !== typeof declared) {
          issues.push({
            path: [...transitionPath, 'condition', 'equals'],
            message: `"${condition.name}" is a ${typeof declared}, so a ${typeof condition.equals} value never matches`,
          });
        }
      }
      checkActions(definition, transition.actions, [...transitionPath, 'actions'], issues);
    });
    if (state.timeout !== undefined) {
      checkActions(definition, state.timeout.actions, [...statePath, 'timeout', 'actions'], issues);
    }
  }
  return issues;
}

/**
 * Parses a definition with the contract schema, then applies `validateDefinitionForEngine()`.
 * The API uses it for `PUT /v1/bots/{id}` (`BOT_DEFINITION_INVALID` when `success` is false).
 */
export function parseDefinitionForEngine(input: unknown): ParseDefinitionResult {
  const parsed = BotDefinition.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) =>
          typeof segment === 'number' ? segment : String(segment),
        ),
        message: issue.message,
      })),
    };
  }
  const issues = validateDefinitionForEngine(parsed.data);
  return issues.length > 0
    ? { success: false, issues }
    : { success: true, definition: parsed.data };
}
