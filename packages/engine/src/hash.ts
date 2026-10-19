import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys in code point order, no white space, arrays in their order.
 * `undefined` object values are left out (as `JSON.stringify` does).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new TypeError(`The value of type ${typeof value} has no JSON form`);
    }
    return text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * A stable SHA-256 hash (hexadecimal) of the canonical JSON of a definition. Give it the parsed
 * definition (with the defaults), so that an input with and without the default values gives the
 * same hash. The API compares it with the hash of the last version and skips a new version when
 * they are equal.
 */
export function definitionHash(definition: unknown): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}
