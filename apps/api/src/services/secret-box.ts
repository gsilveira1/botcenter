import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The text is not a value of this box, or the key is wrong, or the text changed. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * AES-256-GCM encryption of short secrets (the webhook signing secrets) with `DATA_ENCRYPTION_KEY`.
 * Format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. `aad` binds the value to its owner
 * (for example the subscription id): a value copied to a different row does not decrypt.
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Pick<AppEnv, 'DATA_ENCRYPTION_KEY'>) {
    this.key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
    if (this.key.length !== 32) {
      throw new SecretBoxError('DATA_ENCRYPTION_KEY must decode to 32 bytes');
    }
  }

  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad !== undefined) {
      cipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decrypt(sealed: string, aad?: string): string {
    const [version, ivText, tagText, dataText, ...rest] = sealed.split('.');
    if (version !== VERSION || !ivText || !tagText || dataText === undefined || rest.length > 0) {
      throw new SecretBoxError('Unknown secret format');
    }
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError('Unknown secret format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    if (aad !== undefined) {
      decipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(dataText, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      throw new SecretBoxError(`Secret authentication failed: ${(error as Error).message}`);
    }
  }
}
