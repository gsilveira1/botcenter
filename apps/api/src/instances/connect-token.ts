import { createHash, randomBytes } from 'node:crypto';

/**
 * Connect tokens: `ct_` plus 32 random bytes in base64url (46 characters). The database keeps only the
 * SHA-256 of the token (hex). The token goes to the browser of the end user, never the API key.
 */
export const CONNECT_TOKEN_PREFIX = 'ct_';
const TOKEN_PATTERN = /^ct_[A-Za-z0-9_-]{43}$/;

export interface GeneratedConnectToken {
  token: string;
  hash: string;
}

export function hashConnectToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateConnectToken(): GeneratedConnectToken {
  const token = `${CONNECT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashConnectToken(token) };
}

/** True when the value has the format of a connect token. The verifier refuses other values at once. */
export function isConnectTokenFormat(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}
