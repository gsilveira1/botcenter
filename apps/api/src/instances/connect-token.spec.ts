import { createHash } from 'node:crypto';
import { ConnectInstanceResponse } from '@botcenter/contracts';
import { describe, expect, it } from 'vitest';
import { generateConnectToken, hashConnectToken, isConnectTokenFormat } from './connect-token';

describe('connect tokens', () => {
  it('makes a random token with the ct_ prefix that the contract accepts', () => {
    const first = generateConnectToken();
    const second = generateConnectToken();
    expect(first.token).toMatch(/^ct_[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(ConnectInstanceResponse.shape.connect_token.safeParse(first.token).success).toBe(true);
  });

  it('stores only the SHA-256 hex of the token', () => {
    const { token, hash } = generateConnectToken();
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashConnectToken(token)).toBe(hash);
    expect(hash).not.toContain(token.slice(3));
  });

  it('checks the format before a database lookup', () => {
    expect(isConnectTokenFormat(generateConnectToken().token)).toBe(true);
    expect(isConnectTokenFormat('ct_short')).toBe(false);
    expect(isConnectTokenFormat(`xx_${'a'.repeat(43)}`)).toBe(false);
    expect(isConnectTokenFormat(`ct_${'a'.repeat(42)}!`)).toBe(false);
    expect(isConnectTokenFormat(undefined)).toBe(false);
  });
});
