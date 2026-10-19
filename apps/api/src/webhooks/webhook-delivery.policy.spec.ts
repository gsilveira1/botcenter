import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  WebhookSecret,
  verifyWebhook,
} from '@botcenter/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBHOOK_DELIVERY_SETTINGS,
  afterAttempt,
  buildSignedRequest,
  generateWebhookSecret,
  resultOfStatus,
} from './webhook-delivery.policy';

const ENVELOPE = {
  id: '0199a1b2-0000-7000-8000-000000000001',
  type: 'message.status',
  created_at: '2026-10-19T10:00:00.000Z',
  data: { instance_id: 'x', status: 'sent' },
};

describe('generateWebhookSecret', () => {
  it('makes a whsec_ secret in the contracts format, different each time', () => {
    const first = generateWebhookSecret();
    expect(WebhookSecret.safeParse(first).success).toBe(true);
    expect(generateWebhookSecret()).not.toBe(first);
  });
});

describe('buildSignedRequest', () => {
  it('signs timestamp.body so that the contracts verifyWebhook accepts it', () => {
    const secret = generateWebhookSecret();
    const request = buildSignedRequest(ENVELOPE.id, ENVELOPE, [secret], 1_760_000_000);
    expect(JSON.parse(request.body)).toEqual(ENVELOPE);
    expect(request.headers).toMatchObject({
      'Webhook-Id': ENVELOPE.id,
      'Webhook-Timestamp': '1760000000',
    });
    const verification = verifyWebhook({
      secret,
      signature: request.headers['Webhook-Signature'],
      timestamp: request.headers['Webhook-Timestamp'],
      rawBody: request.body,
      nowSeconds: 1_760_000_010,
    });
    expect(verification).toEqual({ valid: true });
  });

  it('refuses a changed body and a wrong secret', () => {
    const secret = generateWebhookSecret();
    const request = buildSignedRequest(ENVELOPE.id, ENVELOPE, [secret], 1_760_000_000);
    const base = {
      signature: request.headers['Webhook-Signature'],
      timestamp: request.headers['Webhook-Timestamp'],
      nowSeconds: 1_760_000_000,
    };
    expect(verifyWebhook({ ...base, secret, rawBody: `${request.body} ` }).valid).toBe(false);
    expect(
      verifyWebhook({ ...base, secret: generateWebhookSecret(), rawBody: request.body }).valid,
    ).toBe(false);
  });

  it('signs with both secrets during a rotation, so each secret verifies', () => {
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const request = buildSignedRequest(ENVELOPE.id, ENVELOPE, [current, previous], 1_760_000_000);
    expect(request.headers['Webhook-Signature']?.split(' ')).toHaveLength(2);
    for (const secret of [current, previous]) {
      expect(
        verifyWebhook({
          secret,
          signature: request.headers['Webhook-Signature'],
          timestamp: request.headers['Webhook-Timestamp'],
          rawBody: request.body,
          nowSeconds: 1_760_000_000,
        }).valid,
      ).toBe(true);
    }
  });
});

describe('afterAttempt (retry schedule)', () => {
  const now = new Date('2026-10-19T10:00:00.000Z');
  const failure = { ok: false as const, statusCode: 500, error: 'http_500' };

  it('marks a 2xx as succeeded with no next attempt', () => {
    expect(afterAttempt(2, resultOfStatus(204), now, DEFAULT_WEBHOOK_DELIVERY_SETTINGS)).toEqual({
      status: 'succeeded',
      attempts: 3,
      lastStatusCode: 204,
      lastError: null,
      nextAttemptAt: null,
    });
  });

  it('schedules the retries at 1 min, 5 min, 30 min, 2 h, and 6 h, then dead', () => {
    const delays: number[] = [];
    let attempts = 0;
    let update = afterAttempt(attempts, failure, now, DEFAULT_WEBHOOK_DELIVERY_SETTINGS);
    while (update.status === 'failed') {
      delays.push(((update.nextAttemptAt?.getTime() ?? 0) - now.getTime()) / 1000);
      attempts = update.attempts;
      update = afterAttempt(attempts, failure, now, DEFAULT_WEBHOOK_DELIVERY_SETTINGS);
    }
    expect(delays).toEqual([...WEBHOOK_RETRY_DELAYS_SECONDS]);
    expect(update).toEqual({
      status: 'dead',
      attempts: WEBHOOK_MAX_ATTEMPTS,
      lastStatusCode: 500,
      lastError: 'http_500',
      nextAttemptAt: null,
    });
  });

  it('keeps a null status code for a network error', () => {
    const update = afterAttempt(
      0,
      { ok: false, statusCode: null, error: 'timeout' },
      now,
      DEFAULT_WEBHOOK_DELIVERY_SETTINGS,
    );
    expect(update).toMatchObject({ status: 'failed', lastStatusCode: null, lastError: 'timeout' });
  });
});

describe('resultOfStatus', () => {
  it('accepts only 2xx; a redirect is a failure', () => {
    expect(resultOfStatus(200).ok).toBe(true);
    expect(resultOfStatus(299).ok).toBe(true);
    expect(resultOfStatus(301)).toEqual({ ok: false, statusCode: 301, error: 'http_301' });
    expect(resultOfStatus(410).ok).toBe(false);
  });
});
