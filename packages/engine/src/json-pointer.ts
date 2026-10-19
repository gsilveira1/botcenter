/** The result of a JSON Pointer read: `found: false` when a token does not exist. */
export type PointerResult = { found: true; value: unknown } | { found: false };

/**
 * Reads a value with a JSON Pointer (RFC 6901). `""` is the full document.
 * `~1` is `/` and `~0` is `~`. An array token must be a decimal index without leading zeros.
 * Only own properties count (`/constructor` does not read the prototype).
 */
export function readJsonPointer(document: unknown, pointer: string): PointerResult {
  if (pointer === '') {
    return { found: true, value: document };
  }
  if (!pointer.startsWith('/')) {
    return { found: false };
  }
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) {
        return { found: false };
      }
      const index = Number(token);
      if (index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else if (typeof current === 'object' && current !== null) {
      if (!Object.hasOwn(current, token)) {
        return { found: false };
      }
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
