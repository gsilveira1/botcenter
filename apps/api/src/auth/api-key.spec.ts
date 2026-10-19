import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  hashSecret,
  parseApiKey,
  parseBearer,
  randomText,
  secretMatches,
} from './api-key';

describe('API key format', () => {
  it('generates bc_live_<12 lowercase alnum>_<43 base62> keys that parse back', () => {
    const generated = generateApiKey();
    expect(generated.key).toMatch(/^bc_live_[a-z0-9]{12}_[A-Za-z0-9]{43}$/);
    expect(parseApiKey(generated.key)).toEqual({
      prefix: generated.prefix,
      secret: generated.secret,
    });
    expect(generateApiKey().key).not.toBe(generated.key);
  });

  it('refuses other formats', () => {
    for (const raw of [
      '',
      'bc_live_',
      'bc_test_aaaaaaaaaaaa_' + 'A'.repeat(43),
      'bc_live_AAAAAAAAAAAA_' + 'A'.repeat(43),
      'bc_live_aaaaaaaaaaaa_' + 'A'.repeat(42),
    ]) {
      expect(parseApiKey(raw)).toBeNull();
    }
  });

  it('reads the key from a Bearer header only', () => {
    const { key, prefix } = generateApiKey();
    expect(parseBearer(`Bearer ${key}`)?.prefix).toBe(prefix);
    expect(parseBearer(`bearer  ${key}`)?.prefix).toBe(prefix);
    expect(parseBearer(`Basic ${key}`)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });

  it('hashes sha256(pepper + secret) and compares in constant time', () => {
    const hash = hashSecret('pepper', 'secret');
    expect(hash).toBe('744a9101f7182a6ae0d978121ff74e33cac8d2832579c0637c1c37e9bbb6c065');
    expect(secretMatches('pepper', 'secret', hash)).toBe(true);
    expect(secretMatches('pepper', 'other', hash)).toBe(false);
    expect(secretMatches('other', 'secret', hash)).toBe(false);
    expect(secretMatches('pepper', 'secret', 'abcd')).toBe(false);
  });

  it('randomText uses only the alphabet', () => {
    expect(randomText('ab', 200)).toMatch(/^[ab]{200}$/);
  });
});
