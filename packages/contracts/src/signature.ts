import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header with the signature: `v1=<hex>`. Several values are separated by a space or a comma. */
export const WEBHOOK_SIGNATURE_HEADER = 'Webhook-Signature';
/** Header with the Unix time of the signature, in seconds. */
export const WEBHOOK_TIMESTAMP_HEADER = 'Webhook-Timestamp';
/** Header with the event id. A redelivery keeps the same id. */
export const WEBHOOK_ID_HEADER = 'Webhook-Id';
export const WEBHOOK_SIGNATURE_VERSION = 'v1';
/** A receiver refuses a timestamp older or newer than 5 minutes. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type RawBody = string | Uint8Array;

function assertTimestamp(timestampSeconds: number): void {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new TypeError(`timestampSeconds must be a non-negative integer, got ${timestampSeconds}`);
  }
}

function digest(secret: string, timestampSeconds: number, rawBody: RawBody): Buffer {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return createHmac('sha256', secret).update(`${timestampSeconds}.`, 'utf8').update(body).digest();
}

/**
 * Signs a webhook body: `v1=` and the hex HMAC-SHA256 of `"<timestamp>.<body>"`.
 * Sign the exact bytes that you send. Do not serialize the JSON again after you sign it.
 */
export function signWebhook(secret: string, timestampSeconds: number, rawBody: RawBody): string {
  if (secret.length === 0) {
    throw new TypeError('secret must not be empty');
  }
  assertTimestamp(timestampSeconds);
  return `${WEBHOOK_SIGNATURE_VERSION}=${digest(secret, timestampSeconds, rawBody).toString('hex')}`;
}

export type WebhookVerificationFailure =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'malformed_signature'
  | 'signature_mismatch';

export type WebhookVerification =
  { valid: true } | { valid: false; reason: WebhookVerificationFailure };

export interface VerifyWebhookInput {
  secret: string;
  /** Value of the `Webhook-Signature` header. */
  signature: string | undefined;
  /** Value of the `Webhook-Timestamp` header. */
  timestamp: string | undefined;
  rawBody: RawBody;
  /** Current Unix time in seconds. Default: the system clock. */
  nowSeconds?: number;
  /** Default: `WEBHOOK_TOLERANCE_SECONDS`. */
  toleranceSeconds?: number;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Verifies a webhook signature with a timing-safe comparison.
 * The result gives the reason of a failure, so that the receiver can log it.
 */
export function verifyWebhook(input: VerifyWebhookInput): WebhookVerification {
  const { secret, signature, timestamp, rawBody } = input;
  if (secret.length === 0) {
    throw new TypeError('secret must not be empty');
  }
  if (signature === undefined || signature === '' || timestamp === undefined || timestamp === '') {
    return { valid: false, reason: 'missing_header' };
  }
  if (!/^\d{1,15}$/.test(timestamp)) {
    return { valid: false, reason: 'invalid_timestamp' };
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const prefix = `${WEBHOOK_SIGNATURE_VERSION}=`;
  const candidates = signature
    .split(/[\s,]+/)
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length))
    .filter((hex) => HEX_SHA256.test(hex));
  if (candidates.length === 0) {
    return { valid: false, reason: 'malformed_signature' };
  }

  const expected = digest(secret, timestampSeconds, rawBody);
  const matched = candidates.some((hex) => timingSafeEqual(Buffer.from(hex, 'hex'), expected));
  return matched ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}
