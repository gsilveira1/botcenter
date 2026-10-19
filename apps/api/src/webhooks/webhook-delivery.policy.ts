import { randomBytes } from 'node:crypto';
import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  signWebhook,
} from '@botcenter/contracts';
import type { WebhookDeliveryStatus } from '@botcenter/contracts';

/**
 * The pure rules of the webhook deliveries: the secret format, the signed request, and the retry
 * schedule. The services use them; the unit tests check them without I/O.
 */

/** `whsec_` and 32 random bytes in base64url (the contracts `WebhookSecret` format). */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** The delivery settings. Tests replace them (`WEBHOOK_DELIVERY_SETTINGS`) with short delays. */
export interface WebhookDeliverySettings {
  requestTimeoutMs: number;
  /** Delay before each retry, in seconds. The attempt limit is the number of delays plus one. */
  retryDelaysSeconds: readonly number[];
}

export const WEBHOOK_DELIVERY_SETTINGS = Symbol('WEBHOOK_DELIVERY_SETTINGS');

export const DEFAULT_WEBHOOK_DELIVERY_SETTINGS: WebhookDeliverySettings = {
  requestTimeoutMs: WEBHOOK_REQUEST_TIMEOUT_MS,
  retryDelaysSeconds: WEBHOOK_RETRY_DELAYS_SECONDS,
};

/** `lastError` of the deliveries that stopped because the client deleted the webhook. */
export const WEBHOOK_DELETED_ERROR = 'webhook_deleted';

/** The receiver can answer with a large body: the worker reads only this part and keeps the status. */
export const DELIVERY_MAX_RESPONSE_BYTES = 64 * 1024;

export interface SignedDeliveryRequest {
  body: string;
  headers: Record<string, string>;
}

/**
 * Builds the body and the headers of one delivery. The body is the event envelope; the signature covers
 * the exact body bytes. With two secrets (a rotation in progress), the header has two `v1=` values.
 */
export function buildSignedRequest(
  envelope: { id: string },
  secrets: readonly string[],
  nowSeconds: number,
): SignedDeliveryRequest {
  const body = JSON.stringify(envelope);
  const signature = secrets.map((secret) => signWebhook(secret, nowSeconds, body)).join(' ');
  return {
    body,
    headers: {
      [WEBHOOK_ID_HEADER]: envelope.id,
      [WEBHOOK_TIMESTAMP_HEADER]: String(nowSeconds),
      [WEBHOOK_SIGNATURE_HEADER]: signature,
    },
  };
}

export type AttemptResult =
  { ok: true; statusCode: number } | { ok: false; statusCode: number | null; error: string };

/** The new state of a delivery after one attempt. `attempts` counts the attempts before this one. */
export interface DeliveryUpdate {
  status: WebhookDeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
}

export function afterAttempt(
  attemptsBefore: number,
  result: AttemptResult,
  now: Date,
  settings: Pick<WebhookDeliverySettings, 'retryDelaysSeconds'>,
): DeliveryUpdate {
  const attempts = attemptsBefore + 1;
  if (result.ok) {
    return {
      status: 'succeeded',
      attempts,
      lastStatusCode: result.statusCode,
      lastError: null,
      nextAttemptAt: null,
    };
  }
  const delaySeconds = settings.retryDelaysSeconds[attempts - 1];
  const base = { attempts, lastStatusCode: result.statusCode, lastError: result.error };
  if (delaySeconds === undefined) {
    return { ...base, status: 'dead', nextAttemptAt: null };
  }
  return {
    ...base,
    status: 'failed',
    nextAttemptAt: new Date(now.getTime() + Math.round(delaySeconds * 1000)),
  };
}

/** A 2xx answer is a success. Every other answer is a failure with a retry (no redirect is followed). */
export function resultOfStatus(statusCode: number): AttemptResult {
  return statusCode >= 200 && statusCode < 300
    ? { ok: true, statusCode }
    : { ok: false, statusCode, error: `http_${statusCode}` };
}
