import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook, WEBHOOK_TOLERANCE_SECONDS } from './signature.js';

const SECRET = `whsec_${'A'.repeat(43)}`;
const NOW = 1_792_400_000;
const BODY = '{"id":"e1","type":"message.status","data":{"status":"read"}}';

describe('signWebhook', () => {
  it('signs "timestamp.body" with HMAC-SHA256 in hex', () => {
    const expected = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
    expect(signWebhook(SECRET, NOW, BODY)).toBe(`v1=${expected}`);
  });

  it('gives the same signature for a string and its bytes', () => {
    expect(signWebhook(SECRET, NOW, Buffer.from(BODY))).toBe(signWebhook(SECRET, NOW, BODY));
  });

  it('throws on an empty secret or an invalid timestamp', () => {
    expect(() => signWebhook('', NOW, BODY)).toThrow(TypeError);
    expect(() => signWebhook(SECRET, -1, BODY)).toThrow(TypeError);
    expect(() => signWebhook(SECRET, 1.5, BODY)).toThrow(TypeError);
  });
});

describe('verifyWebhook', () => {
  const signed = {
    secret: SECRET,
    signature: signWebhook(SECRET, NOW, BODY),
    timestamp: String(NOW),
    rawBody: BODY,
    nowSeconds: NOW + 10,
  };

  it('accepts a round trip', () => {
    expect(verifyWebhook(signed)).toEqual({ valid: true });
  });

  it('accepts one valid signature among several', () => {
    const other = signWebhook('whsec_other', NOW, BODY);
    expect(verifyWebhook({ ...signed, signature: `${other}, ${signed.signature}` })).toEqual({
      valid: true,
    });
  });

  it('refuses a changed body', () => {
    expect(verifyWebhook({ ...signed, rawBody: BODY.replace('read', 'sent') })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses a changed timestamp', () => {
    expect(verifyWebhook({ ...signed, timestamp: String(NOW + 1) })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses a different secret', () => {
    expect(verifyWebhook({ ...signed, secret: 'whsec_other' })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses a timestamp older than 300 s', () => {
    expect(verifyWebhook({ ...signed, nowSeconds: NOW + WEBHOOK_TOLERANCE_SECONDS + 1 })).toEqual({
      valid: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('accepts a timestamp exactly 300 s old', () => {
    expect(verifyWebhook({ ...signed, nowSeconds: NOW + WEBHOOK_TOLERANCE_SECONDS })).toEqual({
      valid: true,
    });
  });

  it('refuses a timestamp in the future beyond the tolerance', () => {
    expect(verifyWebhook({ ...signed, nowSeconds: NOW - WEBHOOK_TOLERANCE_SECONDS - 1 })).toEqual({
      valid: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('refuses missing headers', () => {
    expect(verifyWebhook({ ...signed, signature: undefined })).toEqual({
      valid: false,
      reason: 'missing_header',
    });
    expect(verifyWebhook({ ...signed, timestamp: '' })).toEqual({
      valid: false,
      reason: 'missing_header',
    });
  });

  it('refuses a timestamp that is not an integer', () => {
    expect(verifyWebhook({ ...signed, timestamp: '17924e5' })).toEqual({
      valid: false,
      reason: 'invalid_timestamp',
    });
  });

  it('refuses a malformed signature', () => {
    for (const signature of ['abc', 'v0=abc', 'v1=xyz', `v1=${'a'.repeat(63)}`]) {
      expect(verifyWebhook({ ...signed, signature })).toEqual({
        valid: false,
        reason: 'malformed_signature',
      });
    }
  });

  it('uses the system clock by default', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      verifyWebhook({
        secret: SECRET,
        signature: signWebhook(SECRET, now, BODY),
        timestamp: String(now),
        rawBody: BODY,
      }),
    ).toEqual({ valid: true });
  });
});
