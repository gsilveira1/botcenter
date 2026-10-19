import { describe, expect, it } from 'vitest';
import { compileRegex } from './regex.js';

describe('compileRegex', () => {
  it('compiles a pattern with Unicode classes and flags', () => {
    const result = compileRegex('^n(ã|a)o$', 'i');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.regex.test('NÃO')).toBe(true);
      expect(result.regex.test('nao')).toBe(true);
      expect(result.regex.test('não sei')).toBe(false);
    }
  });

  it.each(['(a)\\1', '(?=a)b', '(?<=a)b', '(?!a)b'])(
    'refuses %j, which RE2 does not support',
    (pattern) => {
      const result = compileRegex(pattern, '');
      expect(result.ok).toBe(false);
    },
  );

  it('returns the same compiled object from the cache', () => {
    const first = compileRegex('^cache-test$', 'i');
    const second = compileRegex('^cache-test$', 'i');
    expect(first.ok && second.ok && first.regex === second.regex).toBe(true);
  });

  it('keeps the flags in the cache key', () => {
    const insensitive = compileRegex('^abc$', 'i');
    const sensitive = compileRegex('^abc$', '');
    expect(insensitive.ok && insensitive.regex.test('ABC')).toBe(true);
    expect(sensitive.ok && sensitive.regex.test('ABC')).toBe(false);
  });

  it('matches a catastrophic pattern in linear time (ReDoS guard)', () => {
    const cases: [string, string][] = [
      ['^(a+)+$', `${'a'.repeat(50_000)}!`],
      ['^(a|aa)+$', `${'a'.repeat(50_000)}!`],
      ['^(\\w+\\s?)*$', `${'word '.repeat(10_000)}!`],
      ['(x+x+)+y', 'x'.repeat(50_000)],
    ];
    for (const [pattern, input] of cases) {
      const compiled = compileRegex(pattern, '');
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) {
        continue;
      }
      const started = performance.now();
      expect(compiled.regex.test(input)).toBe(false);
      // A backtracking engine needs hours for these inputs. RE2 needs a few milliseconds.
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});
