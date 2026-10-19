import { ProviderError } from '@botcenter/whatsapp-provider';
import { describe, expect, it } from 'vitest';
import {
  OUTBOUND_MAX_ATTEMPTS,
  RetryableSendError,
  backoffDelayMs,
  decideRetry,
  errorKind,
  outboundBackoff,
} from './retry-policy';

const unavailable503 = new ProviderError('unavailable', 'send failed', 503);
const timeout = new ProviderError('unavailable', 'send timed out');
const notConnected = new ProviderError('not_connected', 'not connected');

describe('errorKind', () => {
  it('tells a timeout or network error (no HTTP status) from an answer of the provider', () => {
    expect(errorKind(unavailable503)).toBe('unavailable');
    expect(errorKind(timeout)).toBe('ambiguous');
    expect(errorKind(notConnected)).toBe('not_connected');
    expect(errorKind(new ProviderError('rejected', 'no', 400))).toBeNull();
  });
});

describe('decideRetry', () => {
  it('fails at once for invalid_recipient, not_found, and rejected', () => {
    expect(decideRetry(new ProviderError('invalid_recipient', 'x', 400), 0, 0)).toEqual({
      action: 'fail',
      reason: 'invalid_recipient',
    });
    expect(decideRetry(new ProviderError('not_found', 'x', 404), 0, 0)).toEqual({
      action: 'fail',
      reason: 'instance_not_found',
    });
    expect(decideRetry(new ProviderError('rejected', 'x', 400), 0, 0)).toEqual({
      action: 'fail',
      reason: 'rejected',
    });
  });

  it('retries unavailable with an exponential delay from 5 s to 2 min', () => {
    const delays = [0, 1, 2, 3, 4].map((attemptsMade) =>
      decideRetry(unavailable503, attemptsMade, 0),
    );
    expect(
      delays.map((decision) => (decision.action === 'retry' ? decision.delayMs : null)),
    ).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);
  });

  it('retries not_connected from 30 s, then fails with not_connected on the last attempt', () => {
    expect(decideRetry(notConnected, 0, 0)).toEqual({
      action: 'retry',
      kind: 'not_connected',
      delayMs: 30_000,
    });
    expect(decideRetry(notConnected, 3, 0)).toMatchObject({ action: 'retry', delayMs: 240_000 });
    expect(decideRetry(notConnected, 4, 0)).toMatchObject({ action: 'retry', delayMs: 300_000 });
    expect(decideRetry(notConnected, OUTBOUND_MAX_ATTEMPTS - 1, 0)).toEqual({
      action: 'fail',
      reason: 'not_connected',
    });
    expect(decideRetry(unavailable503, OUTBOUND_MAX_ATTEMPTS - 1, 0)).toEqual({
      action: 'fail',
      reason: 'provider_unavailable',
    });
  });

  it('waits at least 60 s after a timeout and fails after the second timeout (duplicate limit)', () => {
    expect(decideRetry(timeout, 0, 0)).toEqual({
      action: 'retry',
      kind: 'ambiguous',
      delayMs: 60_000,
    });
    expect(decideRetry(timeout, 2, 1)).toEqual({ action: 'fail', reason: 'send_timeout' });
  });
});

describe('outboundBackoff', () => {
  it('uses the delay of a RetryableSendError and the default for other errors', () => {
    expect(outboundBackoff(1, 'outbound', new RetryableSendError('unavailable', 7_000))).toBe(
      7_000,
    );
    expect(outboundBackoff(1, 'outbound', new Error('database down'))).toBe(5_000);
    expect(outboundBackoff(3, 'outbound', new Error('database down'))).toBe(20_000);
    expect(backoffDelayMs({ baseMs: 5_000, maxMs: 120_000 }, 10)).toBe(120_000);
  });
});
