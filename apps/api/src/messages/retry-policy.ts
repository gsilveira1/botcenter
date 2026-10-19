import type { ProviderError } from '@botcenter/whatsapp-provider';

/** Maximum runs of one send job (the first send and 5 retries). */
export const OUTBOUND_MAX_ATTEMPTS = 6;

/**
 * Maximum sends that end in a timeout or a network error. Such a send can be on WhatsApp already, so
 * each retry can make a duplicate message. After this number, the message is `failed` (`send_timeout`).
 */
export const OUTBOUND_MAX_AMBIGUOUS_SENDS = 2;

/** The values of `failure_reason` that the outbound path writes. */
export type OutboundFailureReason =
  | 'invalid_recipient'
  | 'instance_not_found'
  | 'rejected'
  | 'not_connected'
  | 'provider_unavailable'
  | 'send_timeout'
  | 'instance_deleted'
  | 'instance_not_connected'
  | 'media_not_found'
  | 'media_not_uploaded'
  | 'media_url_forbidden'
  | 'media_download_failed'
  | 'media_too_large'
  | 'media_type_not_accepted'
  | 'internal_error'
  | 'provider_error'
  | 'instance_queue_full'
  | 'expired';

export type SendErrorKind = 'not_connected' | 'unavailable' | 'ambiguous';

export type RetryDecision =
  | { action: 'retry'; delayMs: number; kind: SendErrorKind }
  | { action: 'fail'; reason: OutboundFailureReason };

interface Backoff {
  baseMs: number;
  maxMs: number;
}

/**
 * The delay before retry number `n` is `baseMs * 2^(n-1)`, at most `maxMs`.
 * - `not_connected`: the instance reconnects (Baileys reconnects in seconds to minutes). 30 s to 5 min.
 * - `unavailable`: the provider answered 5xx, 408, or 429, so it did not send. 5 s to 2 min.
 * - `ambiguous`: a timeout or a network error. The message can be on WhatsApp already. The first retry
 *   waits 60 s, so the provider can finish the first send and the delivery status can arrive.
 */
export const BACKOFF: Readonly<Record<SendErrorKind, Backoff>> = {
  not_connected: { baseMs: 30_000, maxMs: 300_000 },
  unavailable: { baseMs: 5_000, maxMs: 120_000 },
  ambiguous: { baseMs: 60_000, maxMs: 300_000 },
};

/** The backoff of an unexpected error (for example a database error): the default of BullMQ. */
export const DEFAULT_BACKOFF: Backoff = { baseMs: 5_000, maxMs: 120_000 };

const FINAL_REASON: Readonly<Record<SendErrorKind, OutboundFailureReason>> = {
  not_connected: 'not_connected',
  unavailable: 'provider_unavailable',
  ambiguous: 'send_timeout',
};

const NO_RETRY_REASON: Readonly<Record<string, OutboundFailureReason>> = {
  invalid_recipient: 'invalid_recipient',
  not_found: 'instance_not_found',
  rejected: 'rejected',
};

export function backoffDelayMs(backoff: Backoff, retryNumber: number): number {
  return Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, retryNumber - 1));
}

export function errorKind(error: ProviderError): SendErrorKind | null {
  if (error.code === 'not_connected') {
    return 'not_connected';
  }
  if (error.code === 'unavailable') {
    // The adapter sets `httpStatus` only when the provider answered. Without it, the request timed out
    // or the connection failed, and the provider can have sent the message.
    return error.httpStatus === undefined ? 'ambiguous' : 'unavailable';
  }
  return null;
}

/**
 * The decision after a `ProviderError` of a send.
 * @param attemptsMade the runs of the job before this run (BullMQ `attemptsMade`).
 * @param ambiguousSends the sends before this run that ended in a timeout or a network error.
 */
export function decideRetry(
  error: ProviderError,
  attemptsMade: number,
  ambiguousSends: number,
): RetryDecision {
  const kind = errorKind(error);
  if (kind === null) {
    return { action: 'fail', reason: NO_RETRY_REASON[error.code] ?? 'rejected' };
  }
  const run = attemptsMade + 1;
  const ambiguousLimit = kind === 'ambiguous' && ambiguousSends + 1 >= OUTBOUND_MAX_AMBIGUOUS_SENDS;
  if (run >= OUTBOUND_MAX_ATTEMPTS || ambiguousLimit) {
    return { action: 'fail', reason: FINAL_REASON[kind] };
  }
  return { action: 'retry', kind, delayMs: backoffDelayMs(BACKOFF[kind], run) };
}

/**
 * The error that the processor throws to retry a send. The custom backoff of the `outbound` queue reads
 * `delayMs` from it.
 */
export class RetryableSendError extends Error {
  constructor(
    readonly kind: SendErrorKind,
    readonly delayMs: number,
    options?: { cause?: unknown },
  ) {
    super(`Send failed (${kind}); retry in ${delayMs} ms`, options);
    this.name = 'RetryableSendError';
  }
}

/** The custom BullMQ backoff strategy of the `outbound` queue (job option `backoff: { type: 'outbound' }`). */
export function outboundBackoff(attemptsMade: number, _type?: string, error?: Error): number {
  if (error instanceof RetryableSendError) {
    return error.delayMs;
  }
  return backoffDelayMs(DEFAULT_BACKOFF, attemptsMade);
}
