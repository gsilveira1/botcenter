import RE2 from 're2';

/**
 * Client regular expressions run on RE2: the match time is linear in the input length, so a
 * pattern such as `^(a+)+$` cannot block the worker (no ReDoS). RE2 does not support
 * backreferences and lookaround. `validateDefinitionForEngine()` refuses those patterns.
 * The engine always adds the `u` flag: RE2 works on Unicode code points.
 */

/** Upper limit of compiled patterns in the cache. A definition has at most 5000 transitions. */
const CACHE_MAX = 1000;
const cache = new Map<string, RE2>();

export type CompileResult = { ok: true; regex: RE2 } | { ok: false; error: string };

function engineFlags(flags: string): string {
  return flags.includes('u') ? flags : `${flags}u`;
}

/** Compiles a pattern with RE2. It never throws: a pattern that RE2 refuses gives `ok: false`. */
export function compileRegex(pattern: string, flags: string): CompileResult {
  const key = `${flags}/${pattern}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return { ok: true, regex: cached };
  }
  let regex: RE2;
  try {
    regex = new RE2(pattern, engineFlags(flags));
  } catch (error) {
    // RE2 throws a SyntaxError for a pattern that it cannot compile. Other errors are bugs.
    if (error instanceof SyntaxError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  if (cache.size >= CACHE_MAX) {
    // Remove the oldest entry (a Map keeps the insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, regex);
  return { ok: true, regex };
}
