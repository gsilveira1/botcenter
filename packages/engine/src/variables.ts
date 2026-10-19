import type { BotDefinition, VariableValue } from '@botcenter/contracts';
import type { Diagnostic, Variables } from './types.js';

export type VariableType = 'string' | 'number' | 'boolean';

/** The type of a variable value. The declared default value fixes the type of each variable. */
export function valueType(value: VariableValue): VariableType {
  return typeof value as VariableType;
}

/** True when the value is a valid value of the type (a number must be finite). */
export function isValueOfType(value: unknown, type: VariableType): value is VariableValue {
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === type;
}

/** The declared variables with their default values. */
export function defaultVariables(definition: BotDefinition): Variables {
  return { ...definition.variables };
}

/**
 * Makes the stored variables agree with the declaration:
 * - a declared variable that is missing gets its default value (no diagnostic: a new variable);
 * - a stored value with a different type gets the default value (`variable_reset`);
 * - a stored key that is not declared is removed (`variable_dropped`).
 */
export function reconcileVariables(
  definition: BotDefinition,
  stored: Variables,
  diagnostics: Diagnostic[],
): Variables {
  const result: Variables = {};
  for (const [name, fallback] of Object.entries(definition.variables)) {
    if (!Object.hasOwn(stored, name)) {
      result[name] = fallback;
      continue;
    }
    const value = stored[name];
    if (isValueOfType(value, valueType(fallback))) {
      result[name] = value;
    } else {
      result[name] = fallback;
      diagnostics.push({
        code: 'variable_reset',
        severity: 'warning',
        message: `The stored value of "${name}" is not a ${valueType(fallback)}. The engine used the default value.`,
        path: ['variables', name],
      });
    }
  }
  for (const name of Object.keys(stored)) {
    if (!Object.hasOwn(definition.variables, name)) {
      diagnostics.push({
        code: 'variable_dropped',
        severity: 'warning',
        message: `The stored variable "${name}" is not declared. The engine removed it.`,
        path: ['variables', name],
      });
    }
  }
  return result;
}

const DECIMAL = /^[+-]?\d{1,15}(?:[.,]\d{1,15})?$/;

/**
 * Converts the message text for a number variable. It accepts a decimal number with a point or a
 * comma (pt-BR), for example `"72,5"`. It returns `null` for other text.
 */
export function parseNumber(text: string): number | null {
  if (!DECIMAL.test(text)) {
    return null;
  }
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}
