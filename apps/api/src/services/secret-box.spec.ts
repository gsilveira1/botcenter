import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox, SecretBoxError } from './secret-box';

const box = new SecretBox({ DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });

describe('SecretBox', () => {
  it('encrypts with a random IV and decrypts', () => {
    const sealed = box.encrypt('whsec_abc');
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('whsec_abc');
    expect(box.encrypt('whsec_abc')).not.toBe(sealed);
    expect(box.decrypt(sealed)).toBe('whsec_abc');
  });

  it('binds the value to its owner with the additional data', () => {
    const sealed = box.encrypt('secret', 'subscription-1');
    expect(box.decrypt(sealed, 'subscription-1')).toBe('secret');
    expect(() => box.decrypt(sealed, 'subscription-2')).toThrow(SecretBoxError);
  });

  it('refuses a changed text, a different key, and an unknown format', () => {
    const sealed = box.encrypt('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('changed').toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow(SecretBoxError);
    expect(() =>
      new SecretBox({ DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') }).decrypt(sealed),
    ).toThrow(SecretBoxError);
    expect(() => box.decrypt('v2.a.b.c')).toThrow(/format/);
    expect(
      () => new SecretBox({ DATA_ENCRYPTION_KEY: randomBytes(16).toString('base64') }),
    ).toThrow(SecretBoxError);
  });
});
