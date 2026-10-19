import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API key format: `bc_live_<prefix>_<secret>`.
 * - `prefix`: 12 characters `[a-z0-9]`, public and unique (`api_keys.prefix`). It finds the key.
 * - `secret`: 43 characters base62 (about 256 bits). The database keeps only `sha256(pepper + secret)`.
 * The parts use no `_` or `-`, so the key splits without doubt and a double click selects all of it.
 */
export const API_KEY_PREFIX = 'bc_live_';
export const KEY_ID_LENGTH = 12;
export const KEY_SECRET_LENGTH = 43;

const KEY_PATTERN = /^bc_live_([a-z0-9]{12})_([A-Za-z0-9]{43})$/;
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Uniform random text from `alphabet` (rejection sampling, no modulo bias). */
export function randomText(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit) {
        out += alphabet[byte % alphabet.length];
        if (out.length === length) {
          break;
        }
      }
    }
  }
  return out;
}

export interface GeneratedApiKey {
  /** The full key. Show it once; never store or log it. */
  key: string;
  prefix: string;
  secret: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomText(LOWER_ALNUM, KEY_ID_LENGTH);
  const secret = randomText(BASE62, KEY_SECRET_LENGTH);
  return { key: `${API_KEY_PREFIX}${prefix}_${secret}`, prefix, secret };
}

export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  const match = KEY_PATTERN.exec(raw);
  return match ? { prefix: match[1]!, secret: match[2]! } : null;
}

/** Reads the key from `Authorization: Bearer <key>`. */
export function parseBearer(header: string | undefined): { prefix: string; secret: string } | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? parseApiKey(match[1]!) : null;
}

export function hashSecret(pepper: string, secret: string): string {
  return createHash('sha256').update(pepper).update(secret).digest('hex');
}

/** Constant-time comparison of the hash of `secret` with the stored hash. */
export function secretMatches(pepper: string, secret: string, storedHash: string): boolean {
  const actual = Buffer.from(hashSecret(pepper, secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
