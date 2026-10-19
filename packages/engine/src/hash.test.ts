import { describe, expect, it } from 'vitest';
import { personalTrainerOnboarding } from './fixtures/personal-trainer-onboarding.js';
import { canonicalJson, definitionHash } from './hash.js';
import { define } from './test-helpers.js';

/** A deep copy with the object keys in the reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  }
  return value;
}

describe('canonicalJson', () => {
  it('sorts the keys at every level and keeps the array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('leaves out undefined object values', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });

  it('refuses a value without a JSON form', () => {
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe('definitionHash', () => {
  it('is stable for the same definition with a different key order', () => {
    const parsed = define(personalTrainerOnboarding);
    const reversed = reverseKeys(parsed);
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(parsed));
    expect(definitionHash(reversed)).toBe(definitionHash(parsed));
    expect(definitionHash(parsed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is equal for an input with and without the defaults after the parse', () => {
    const without = define({ initial_state: 'a', states: { a: { transitions: [] } } });
    const withDefaults = define({
      initial_state: 'a',
      variables: {},
      states: { a: { transitions: [], on_enter: [], final: false } },
    });
    expect(definitionHash(without)).toBe(definitionHash(withDefaults));
  });

  it('changes when a value changes', () => {
    const one = define({
      initial_state: 'a',
      variables: { n: 1 },
      states: { a: { transitions: [] } },
    });
    const two = define({
      initial_state: 'a',
      variables: { n: 2 },
      states: { a: { transitions: [] } },
    });
    expect(definitionHash(one)).not.toBe(definitionHash(two));
  });
});
